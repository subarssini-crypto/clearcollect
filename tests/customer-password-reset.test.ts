/**
 * Customer Portal minimum password length and "Forgot password?" flow.
 *
 * Runs the real route handlers against MySQL with test-owned customers only
 * (pr-…-<stamp>@example.invalid), removed afterwards. Zapier is never called:
 * reset emails go to a fake fetch.
 */

import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { CUSTOMER_COOKIE, MIN_CUSTOMER_PASSWORD_LENGTH, customerThrottles } from "@/lib/customer-auth";
import {
  PASSWORD_RESET_TTL_MS,
  RESET_INVALID_MESSAGE,
  RESET_WEBHOOK_URL_VAR,
  createResetToken,
  sendPasswordResetEmail,
  throttleResetRequest,
} from "@/lib/customer-password-reset";
import { proxy } from "@/proxy";
import { POST as signupRoute } from "@/app/api/customer/auth/signup/route";
import { POST as loginRoute } from "@/app/api/customer/auth/login/route";
import { POST as forgotRoute } from "@/app/api/customer/auth/forgot-password/route";
import { POST as resetRoute } from "@/app/api/customer/auth/reset-password/route";
import { GET as meRoute } from "@/app/api/customer/me/route";
import "./auth-helpers"; // throwaway AUTH_SECRET for this process

const BASE = "http://localhost:3000";
const STAMP = `${Date.now()}`;
const PASSWORD = "original-pw-1";
const emailFor = (label: string) => `pr-${label}-${STAMP}@example.invalid`;
const ZAPIER_ENV = {
  [RESET_WEBHOOK_URL_VAR]: "https://hooks.zapier.com/hooks/catch/test/reset/",
  ZAPIER_WEBHOOK_SECRET: "test-zapier-secret-0123456789",
};

function json(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const signup = (label: string, password = PASSWORD) =>
  signupRoute(json("/api/customer/auth/signup", { name: `Reset ${label}`, email: emailFor(label), password }));
const login = (label: string, password: string) => loginRoute(json("/api/customer/auth/login", { email: emailFor(label), password }));
const reset = (token: string, password: string) => resetRoute(json("/api/customer/auth/reset-password", { token, password }));

/** Runs the email step with a fake Zapier and returns what it was sent (or null if nothing). */
async function capturedResetEmail(email: string): Promise<Record<string, string> | null> {
  let sent: Record<string, string> | null = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await sendPasswordResetEmail(email, BASE, { env: ZAPIER_ENV, fetchImpl });
  return sent;
}
const tokenFrom = (message: string) => new URL(/https?:\/\/\S+/.exec(message)![0]).searchParams.get("token")!;

beforeEach(() => customerThrottles.reset());

after(async () => {
  await prisma.customer.deleteMany({ where: { email: { startsWith: "pr-", endsWith: `-${STAMP}@example.invalid` } } });
  customerThrottles.reset();
  await prisma.$disconnect();
});

describe("customer password minimum length", () => {
  test("is 8 characters for signup: 8 is accepted (and can sign in), 7 is rejected", async () => {
    assert.equal(MIN_CUSTOMER_PASSWORD_LENGTH, 8);
    assert.equal((await signup("eight", "abcd1234")).status, 200);
    assert.equal((await login("eight", "abcd1234")).status, 200);
    const short = await signup("seven", "abc1234");
    assert.equal(short.status, 422);
    assert.equal(await prisma.customer.count({ where: { email: emailFor("seven") } }), 0);
  });

  test("the signup form uses the same minimum", () => {
    const form = readFileSync(new URL("../src/components/CustomerAuthForm.tsx", import.meta.url), "utf8");
    assert.match(form, /export const MIN_PASSWORD = 8;/);
  });
});

describe("forgot password", () => {
  test("login page links to it, and its pages and endpoints are public", async () => {
    const form = readFileSync(new URL("../src/components/CustomerAuthForm.tsx", import.meta.url), "utf8");
    assert.match(form, /href="\/portal\/forgot-password"[^>]*>\s*Forgot password\?/);
    for (const path of ["/portal/forgot-password", "/portal/reset-password?token=x", "/api/customer/auth/forgot-password", "/api/customer/auth/reset-password"]) {
      assert.equal((await proxy(new NextRequest(`${BASE}${path}`))).headers.get("x-middleware-next"), "1", path);
    }
  });

  test("the request route never looks up the account and sends only after responding; bad input is rejected", async () => {
    // The route defers the email with next/server `after`, which needs a request scope;
    // the email step is tested directly below.
    const route = readFileSync(new URL("../src/app/api/customer/auth/forgot-password/route.ts", import.meta.url), "utf8");
    assert.match(route, /after\(\(\) => sendPasswordResetEmail\(email, origin\)\)/);
    assert.match(route, /getPaymentReturnOrigin\(request\.url\)/, "link origin never comes from the Host header");
    assert.doesNotMatch(route, /prisma|findUnique/, "the route itself never looks up the account");
    assert.equal((await forgotRoute(json("/api/customer/auth/forgot-password", { email: "not-an-email" }))).status, 422);
  });

  test("requests are throttled per email, the same way for any email", () => {
    for (let i = 0; i < 3; i++) assert.equal(throttleResetRequest(emailFor("throttle")), 0);
    assert.ok(throttleResetRequest(emailFor("throttle")) > 0);
    assert.equal(throttleResetRequest(emailFor("other")), 0);
  });

  test("emails a reset link only to an existing account, at its stored address", async () => {
    await signup("mail");
    const sent = await capturedResetEmail(`  ${emailFor("mail").toUpperCase()} `);
    assert.ok(sent);
    assert.equal(sent.recipient_email, emailFor("mail"));
    assert.equal(sent.auth_token, ZAPIER_ENV.ZAPIER_WEBHOOK_SECRET);
    assert.match(sent.message, new RegExp(`${BASE}/portal/reset-password\\?token=`));
    assert.equal(await capturedResetEmail(emailFor("nobody")), null, "no email for unknown addresses");
  });

  test("a reset sets the new password, signs out every session, and the link works only once", async () => {
    await signup("flow");
    const session = cookieFrom(await login("flow", PASSWORD));
    assert.ok(session.startsWith(`${CUSTOMER_COOKIE}=`));
    assert.equal((await meRoute(new NextRequest(`${BASE}/api/customer/me`, { headers: { cookie: session } }))).status, 200);

    const token = tokenFrom((await capturedResetEmail(emailFor("flow")))!.message);
    const before = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("flow") } });
    const res = await reset(token, "brand-new-pw");
    assert.equal(res.status, 200);
    assert.equal(res.headers.getSetCookie().length, 0, "reset never signs in");

    const afterReset = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("flow") } });
    assert.match(afterReset.passwordHash, /^scrypt:/);
    assert.notEqual(afterReset.passwordHash, before.passwordHash);
    assert.equal(afterReset.sessionVersion, before.sessionVersion + 1);
    assert.equal((await meRoute(new NextRequest(`${BASE}/api/customer/me`, { headers: { cookie: session } }))).status, 401, "old session revoked");

    assert.equal((await login("flow", PASSWORD)).status, 401);
    assert.equal((await login("flow", "brand-new-pw")).status, 200);

    const again = await reset(token, "another-new-pw");
    assert.equal(again.status, 400, "single use");
    assert.deepEqual(await again.json(), { ok: false, error: RESET_INVALID_MESSAGE });
  });

  test("expired, tampered, and malformed tokens are refused and change nothing", async () => {
    await signup("bad");
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("bad") } });
    const expired = createResetToken(customer, Date.now() - PASSWORD_RESET_TTL_MS - 1000);
    const valid = createResetToken(customer);
    const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
    const otherAccount = valid.replace(/^\d+/, String(customer.id + 1));
    for (const token of [expired, tampered, otherAccount, "", "x.y.z"]) {
      assert.equal((await reset(token, "brand-new-pw")).status, 400, token);
    }
    assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } }), customer);
  });

  test("a too-short new password is rejected without using up the link", async () => {
    await signup("short");
    const token = tokenFrom((await capturedResetEmail(emailFor("short")))!.message);
    assert.equal((await reset(token, "abc1234")).status, 422);
    assert.equal((await reset(token, "abcd1234")).status, 200);
    assert.equal((await login("short", "abcd1234")).status, 200);
  });
});
