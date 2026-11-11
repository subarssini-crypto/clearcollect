/**
 * Landing page + Customer Portal tests.
 *
 * Runs the real route handlers against MySQL with test-owned rows only
 * (clients "Portal Test …", invoices INV-TEST-CP-<stamp>-…, customers
 * cp-…-<stamp>@example.invalid), all removed afterwards. Payment tests that
 * create PayPal orders use the Sandbox and are skipped without credentials;
 * orders are never approved or captured, and no email is sent.
 */

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { Client, Environment, OrdersController } from "@paypal/paypal-server-sdk";
import { prisma } from "@/lib/prisma";
import { CUSTOMER_COOKIE, SIGNUP_ACCEPTED_MESSAGE, customerThrottles } from "@/lib/customer-auth";
import { INVITE_TTL_MS, createInvite, hashInviteToken, redeemInvite } from "@/lib/customer-invites";
import { generatePaymentToken } from "@/lib/payment-link";
import { safeNextPath, safePortalPath } from "@/lib/safe-redirect";
import { extractPayToken } from "@/lib/pay-link-input";
import { proxy } from "@/proxy";
import { POST as signupRoute } from "@/app/api/customer/auth/signup/route";
import { POST as loginRoute } from "@/app/api/customer/auth/login/route";
import { POST as logoutRoute } from "@/app/api/customer/auth/logout/route";
import { GET as invitePreviewRoute } from "@/app/api/customer/auth/invite/route";
import { GET as meRoute } from "@/app/api/customer/me/route";
import { POST as redeemRoute } from "@/app/api/customer/invite/route";
import { GET as invoicesRoute } from "@/app/api/customer/invoices/route";
import { POST as payRoute } from "@/app/api/customer/invoices/pay/route";
import { GET as paymentsRoute } from "@/app/api/customer/payments/route";
import { GET as ownerInvoicesRoute } from "@/app/api/invoices/route";
import { GET as publicPayRoute } from "@/app/api/pay/[token]/route";
import { GET as paypalReturn } from "@/app/api/paypal/return/route";
import { GET as reviewsRoute } from "@/app/api/payment-reviews/route";
import { PATCH as markReviewRoute } from "@/app/api/payment-reviews/[id]/route";
import { POST as reviewDemoRoute } from "@/app/api/payment-reviews/demo/route";
import { SESSION_COOKIE } from "@/lib/auth";
import { ownerCookie } from "./auth-helpers";
import { cleanupTestRecords } from "./cleanup";

const BASE = "http://localhost:3000";
const STAMP = `${Date.now()}`;
const PASSWORD = "portal-test-password-1";
const PAYPAL_CONFIGURED = !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
const created = { clientIds: [] as number[], invoiceIds: [] as number[] };
let owner = "";

// ── Helpers ───────────────────────────────────────────────────────────────────

const emailFor = (label: string) => `cp-${label}-${STAMP}@example.invalid`;

function json(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
const get = (path: string, cookie?: string) => new NextRequest(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });

function cookieFrom(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

const signup = (label: string, extra: Record<string, unknown> = {}) =>
  signupRoute(json("/api/customer/auth/signup", { name: `Portal ${label}`, email: emailFor(label), password: PASSWORD, ...extra }));

async function login(label: string, extra: Record<string, unknown> = {}, password = PASSWORD) {
  const res = await loginRoute(json("/api/customer/auth/login", { email: emailFor(label), password, ...extra }));
  return { res, cookie: cookieFrom(res) };
}

/** Signs up, signs in, and (with an invite) explicitly accepts it; returns the customer cookie. */
async function account(label: string, invite?: string): Promise<string> {
  assert.equal((await signup(label)).status, 200);
  const { res, cookie } = await login(label);
  assert.equal(res.status, 200);
  if (invite) assert.equal((await redeemRoute(json("/api/customer/invite", { token: invite }, cookie))).status, 200);
  return cookie;
}

async function testClient(label: string, data: Record<string, unknown> = {}) {
  const client = await prisma.client.create({
    data: { name: `Portal Test ${label} ${STAMP}`, email: emailFor(`client-${label}`), company: `TEST ONLY ${label}`, ...data },
  });
  created.clientIds.push(client.id);
  return client;
}

async function testInvoice(clientId: number, suffix: string, data: Record<string, unknown> = {}) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-TEST-CP-${STAMP}-${suffix}`,
      clientId,
      description: "TEST ONLY - customer portal test",
      amount: "25.50",
      currency: "USD",
      issueDate: new Date("2026-10-01T00:00:00Z"),
      dueDate: new Date("2099-01-01T00:00:00Z"),
      status: "SENT",
      ...data,
    },
  });
  created.invoiceIds.push(invoice.id);
  return invoice;
}

async function invoices(cookie: string, status = "all") {
  const res = await invoicesRoute(get(`/api/customer/invoices?status=${status}`, cookie));
  return { res, body: (await res.json()) as { ok: boolean; data: Record<string, unknown>[]; meta?: { linked: boolean } } };
}

const pay = (cookie: string, body: unknown) => payRoute(json("/api/customer/invoices/pay", body, cookie));

// ── Fixtures ──────────────────────────────────────────────────────────────────

let clientA: Awaited<ReturnType<typeof testClient>>;
let clientB: Awaited<ReturnType<typeof testClient>>;
let cookieA = "";
let cookieB = "";

before(async () => {
  owner = await ownerCookie();
  customerThrottles.reset();
  clientA = await testClient("A");
  clientB = await testClient("B");
  cookieA = await account("a", (await createInvite(clientA.id)).token);
  cookieB = await account("b", (await createInvite(clientB.id)).token);
});

beforeEach(() => customerThrottles.reset());

after(async () => {
  // Removes only what this file created, children first.
  let customerIds: number[] = [];
  await cleanupTestRecords(
    async () => {
      const customers = await prisma.customer.findMany({ where: { email: { endsWith: `-${STAMP}@example.invalid`, startsWith: "cp-" } }, select: { id: true } });
      customerIds = customers.map((c) => c.id);
    },
    () => prisma.customerInvite.deleteMany({ where: { OR: [{ clientId: { in: created.clientIds } }, { usedByCustomerId: { in: customerIds } }] } }),
    () => prisma.customer.deleteMany({ where: { id: { in: customerIds } } }),
    () => prisma.paymentReview.deleteMany({ where: { dedupeKey: { startsWith: `TEST-CP-${STAMP}-` } } }),
    () => prisma.invoice.deleteMany({ where: { id: { in: created.invoiceIds }, invoiceNumber: { startsWith: `INV-TEST-CP-${STAMP}-` } } }),
    () => prisma.client.deleteMany({ where: { id: { in: created.clientIds }, name: { startsWith: "Portal Test" } } }),
    () => customerThrottles.reset(),
  );
});

// ── Landing page ──────────────────────────────────────────────────────────────

describe("landing page", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");

  test("is public and reads no session or data", async () => {
    const res = await proxy(get("/"));
    assert.equal(res.headers.get("x-middleware-next"), "1");
    assert.doesNotMatch(page, /"use client"|prisma|fetch\(|cookies\(|headers\(|getCustomer|requireOwner/);
  });

  test("has one h1 with the hero line and labelled sections", () => {
    assert.equal(page.match(/<h1\b/g)?.length, 1);
    assert.match(page, /From invoice created to payment confirmed\./);
    assert.match(page, /aria-labelledby="hero-title"/);
    assert.match(page, /aria-labelledby="pay-title"/);
    for (const feature of ["AI invoice creation", "PayPal payments", "Transaction tracking", "AI follow-ups"]) {
      assert.match(page, new RegExp(feature));
    }
  });

  test("the three actions go to owner login, the portal, and payment-link instructions", () => {
    assert.match(page, /id="cta-owner-login" href="\/login"[^>]*>\s*Business Owner Login/);
    assert.match(page, /id="cta-customer-portal" href="\/portal\/login"[^>]*>\s*Customer Portal/);
    assert.match(page, /id="cta-pay-invoice" href="#pay-an-invoice"[^>]*>\s*Pay an Invoice/);
    assert.match(page, /id="pay-an-invoice"/);
    assert.match(page, /never with an invoice\s+number alone/);
  });

  test("the landing page and portal render without owner navigation", () => {
    assert.match(shell, /if \(pathname === "\/" \|\| pathname === "\/login" \|\| pathname === "\/portal" \|\| pathname\.startsWith\("\/portal\/"\)\) \{\s*return <main/);
    assert.match(shell, /\{ href: "\/dashboard", label: "Dashboard"/);
  });

  test("the pay-link box only opens real /pay/<token> links on this site, never invoice numbers or IDs", () => {
    const token = generatePaymentToken();
    assert.equal(extractPayToken(`${BASE}/pay/${token}`, BASE), token);
    assert.equal(extractPayToken(`  ${token} `, BASE), token);
    for (const bad of ["INV-2026-007", "42", `https://evil.example/pay/${token}`, `${BASE}/pay/${token}/x`, `${BASE}/invoices/1`, "", "javascript:alert(1)"]) {
      assert.equal(extractPayToken(bad, BASE), null, bad);
    }
  });

  test("owner dashboard moved to /dashboard and stays owner-only", async () => {
    const res = await proxy(get("/dashboard"));
    assert.equal(new URL(res.headers.get("location")!).pathname, "/login");
    assert.equal((await proxy(get("/dashboard", owner))).headers.get("x-middleware-next"), "1");
    assert.equal(safeNextPath(null), "/dashboard");
  });
});

// ── Authentication ────────────────────────────────────────────────────────────

describe("customer signup, login, logout", () => {
  test("signup stores a scrypt hash, never the password, and does not sign in", async () => {
    const res = await signup("new");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: SIGNUP_ACCEPTED_MESSAGE });
    assert.equal(res.headers.getSetCookie().length, 0, "signup never sets a session");
    const row = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("new") } });
    assert.match(row.passwordHash, /^scrypt:/);
    assert.ok(!row.passwordHash.includes(PASSWORD));
    assert.equal(row.clientId, null);
  });

  test("signing in right after signup with the identical credentials succeeds", async () => {
    // Exactly what the user typed, including case and surrounding spaces in the email
    // and non-ASCII characters/spaces in the password.
    const typedEmail = `  CP-Same-${STAMP}@Example.Invalid `;
    const typedPassword = " Pässwörd with spaces ① ";
    const res = await signupRoute(json("/api/customer/auth/signup", { name: "Same Creds", email: typedEmail, password: typedPassword }));
    assert.equal(res.status, 200);
    assert.ok(await prisma.customer.findUnique({ where: { email: emailFor("same").toLowerCase() } }), "account persisted");
    const loginRes = await loginRoute(json("/api/customer/auth/login", { email: typedEmail, password: typedPassword }));
    assert.equal(loginRes.status, 200);
    assert.deepEqual(await loginRes.json(), { ok: true });
    assert.ok(loginRes.headers.getSetCookie()[0]?.startsWith(`${CUSTOMER_COOKIE}=`));
  });

  test("the signup message tells a returning customer their existing password still applies", () => {
    assert.match(SIGNUP_ACCEPTED_MESSAGE, /already had an account/);
    assert.match(SIGNUP_ACCEPTED_MESSAGE, /existing password still applies/);
  });

  test("invalid signup input is rejected with field errors", async () => {
    const short = await signupRoute(json("/api/customer/auth/signup", { name: "X", email: emailFor("short"), password: "short" }));
    assert.equal(short.status, 422);
    const badEmail = await signupRoute(json("/api/customer/auth/signup", { name: "X", email: "not-an-email", password: PASSWORD }));
    assert.equal(badEmail.status, 422);
    const noName = await signupRoute(json("/api/customer/auth/signup", { name: " ", email: emailFor("noname"), password: PASSWORD }));
    assert.equal(noName.status, 422);
    assert.equal(await prisma.customer.count({ where: { email: { in: [emailFor("short"), emailFor("noname")] } } }), 0);
  });

  test("a duplicate email gets the identical response and changes nothing", async () => {
    await signup("dup");
    const before = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("dup") } });
    const again = await signupRoute(
      json("/api/customer/auth/signup", { name: "Attacker", email: `  ${emailFor("dup").toUpperCase()} `, password: "attacker-password-123" })
    );
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, message: SIGNUP_ACCEPTED_MESSAGE });
    assert.equal(await prisma.customer.count({ where: { email: emailFor("dup") } }), 1);
    assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("dup") } }), before);
    assert.equal((await login("dup", {}, "attacker-password-123")).res.status, 401);
    assert.equal((await login("dup")).res.status, 200);
  });

  test("wrong password and unknown email fail identically", async () => {
    await signup("creds");
    const wrong = await login("creds", {}, "wrong-password-123");
    const unknown = await loginRoute(json("/api/customer/auth/login", { email: emailFor("nobody"), password: PASSWORD }));
    assert.equal(wrong.res.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(await wrong.res.json(), await unknown.json());
    assert.equal(wrong.res.headers.getSetCookie().length, 0);
  });

  test("login sets an HttpOnly, SameSite=Lax customer cookie that reveals nothing", async () => {
    await signup("cookie");
    const { res } = await login("cookie");
    const [setCookie] = res.headers.getSetCookie();
    assert.ok(setCookie.startsWith(`${CUSTOMER_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.ok(!setCookie.includes(emailFor("cookie")) && !setCookie.includes(PASSWORD));
  });

  test("logout clears the cookie and revokes the old session everywhere", async () => {
    await signup("logout");
    const { cookie } = await login("logout");
    assert.equal((await meRoute(get("/api/customer/me", cookie))).status, 200);
    const out = await logoutRoute(new Request(`${BASE}/api/customer/auth/logout`, { method: "POST", headers: { cookie } }));
    assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie()[0], new RegExp(`^${CUSTOMER_COOKIE}=;.*Max-Age=0`));
    assert.equal((await meRoute(get("/api/customer/me", cookie))).status, 401, "the old cookie no longer works");
  });

  test("repeated failures for one email are throttled, even with the right password next", async () => {
    await signup("throttle");
    for (let i = 0; i < 5; i++) assert.equal((await login("throttle", {}, `wrong-password-${i}x`)).res.status, 401);
    const blocked = await login("throttle");
    assert.equal(blocked.res.status, 429);
    assert.ok(Number(blocked.res.headers.get("retry-after")) > 0);
    assert.equal((await login("a")).res.status, 200, "other accounts are unaffected");
  });

  test("signups are rate limited", async () => {
    for (let i = 0; i < 30; i++) customerThrottles.signupGlobal.record("*");
    assert.equal((await signup("limited")).status, 429);
    assert.equal(await prisma.customer.count({ where: { email: emailFor("limited") } }), 0);
  });

  test("owner and customer sessions never stand in for each other", async () => {
    assert.equal((await meRoute(get("/api/customer/me", owner))).status, 401, "owner cookie is not a customer session");
    assert.equal((await ownerInvoicesRoute(get("/api/invoices", cookieA))).status, 401, "customer cookie is not an owner session");
    // An owner cookie value replayed under the customer cookie name is rejected.
    const ownerValue = owner.split("=").slice(1).join("=");
    assert.equal((await meRoute(get("/api/customer/me", `${CUSTOMER_COOKIE}=${ownerValue}`))).status, 401);
    assert.equal((await ownerInvoicesRoute(get("/api/invoices", owner))).status, 200, "owner login still works");
  });

  test("portal paths are guarded by the proxy", async () => {
    const page = await proxy(get("/portal"));
    const location = new URL(page.headers.get("location")!);
    assert.equal(location.pathname, "/portal/login");
    assert.equal(location.searchParams.get("next"), "/portal");
    assert.equal((await proxy(get("/api/customer/invoices"))).status, 401);
    for (const open of ["/portal/login", "/portal/signup", "/portal/invite?token=x", "/api/customer/auth/login"]) {
      assert.equal((await proxy(get(open))).headers.get("x-middleware-next"), "1", open);
    }
    assert.equal((await proxy(get("/portal", cookieA))).headers.get("x-middleware-next"), "1");
    assert.equal(new URL((await proxy(get("/portal/login", cookieA))).headers.get("location")!).pathname, "/portal");
    assert.equal(safePortalPath("https://evil.example"), "/portal");
    assert.equal(safePortalPath("/invoices"), "/portal");
    assert.equal(safePortalPath("/portal?x=1"), "/portal?x=1");
  });
});

// ── Payment reviews (owner only) ──────────────────────────────────────────────

describe("payment reviews are owner-only", () => {
  let review: { id: number };
  let reviewInvoiceId = 0;

  before(async () => {
    const client = await testClient("reviews");
    const invoice = await testInvoice(client.id, "review", { status: "SENT" });
    reviewInvoiceId = invoice.id;
    review = await prisma.paymentReview.create({
      data: {
        dedupeKey: `TEST-CP-${STAMP}-amount`,
        code: "AMOUNT_MISMATCH",
        reason: "TEST ONLY - held payment",
        recommendedAction: "TEST ONLY",
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
      },
      select: { id: true },
    });
  });

  const patch = (id: number | string, cookie?: string, headers: Record<string, string> = {}) =>
    markReviewRoute(
      new Request(`${BASE}/api/payment-reviews/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
        body: JSON.stringify({ status: "REVIEWED" }),
      }),
      { params: Promise.resolve({ id: String(id) }) } as never
    );
  const demo = (cookie?: string, headers: Record<string, string> = {}) =>
    reviewDemoRoute(new Request(`${BASE}/api/payment-reviews/demo`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), ...headers } }));
  const list = (cookie?: string) => reviewsRoute(get("/api/payment-reviews?status=all", cookie));
  /** Every review and invoice payment field, to prove a request changed nothing. */
  const snapshot = async () => ({
    reviews: await prisma.paymentReview.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, reviewedAt: true } }),
    invoices: await prisma.invoice.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, paypalCaptureId: true, paidAt: true, updatedAt: true } }),
  });

  /** Asserts every payment-review endpoint answers 401 for `cookie`, and nothing in the database changes. */
  async function allRejected(cookie: string | undefined, label: string) {
    const before = await snapshot();
    const listRes = await list(cookie);
    assert.equal(listRes.status, 401, `${label}: GET list`);
    assert.equal(((await listRes.json()) as { data?: unknown }).data, undefined, `${label}: no review data leaked`);
    assert.equal((await patch(review.id, cookie)).status, 401, `${label}: PATCH`);
    assert.equal((await patch(review.id, cookie, { "sec-fetch-site": "same-origin" })).status, 401, `${label}: PATCH same-origin`);
    const demoRes = await demo(cookie, { "sec-fetch-site": "same-origin" });
    assert.equal(demoRes.status, 401, `${label}: demo`);
    assert.equal(((await demoRes.json()) as { results?: unknown }).results, undefined, `${label}: demo did not run`);
    assert.deepEqual(await snapshot(), before, `${label}: database unchanged`);
  }

  test("unauthenticated requests are rejected (401) and change nothing", async () => {
    await allRejected(undefined, "anonymous");
  });

  test("a signed-in customer cannot list, mark reviewed, or run the demo", async () => {
    await allRejected(cookieA, "customer");
    // Customer session value replayed under the owner cookie name, and a garbage owner cookie.
    const customerValue = cookieA.split("=").slice(1).join("=");
    await allRejected(`${SESSION_COOKIE}=${customerValue}`, "customer cookie as owner cookie");
    await allRejected(`${SESSION_COOKIE}=forged`, "forged owner cookie");
  });

  test("the proxy blocks the page and APIs for anonymous users and customers", async () => {
    for (const cookie of [undefined, cookieA]) {
      const page = await proxy(get("/payment-reviews", cookie));
      assert.equal(page.status, 307);
      assert.equal(new URL(page.headers.get("location")!).pathname, "/login");
      for (const [path, method] of [["/api/payment-reviews", "GET"], [`/api/payment-reviews/${review.id}`, "PATCH"], ["/api/payment-reviews/demo", "POST"]]) {
        const res = await proxy(new NextRequest(`${BASE}${path}`, { method, headers: cookie ? { cookie } : {} }));
        assert.equal(res.status, 401, `${method} ${path} (${cookie ? "customer" : "anonymous"})`);
      }
    }
    assert.equal((await proxy(get("/payment-reviews", owner))).headers.get("x-middleware-next"), "1", "owner reaches the page");
  });

  test("cross-site requests with the owner cookie are refused (403) and change nothing", async () => {
    const before = await snapshot();
    assert.equal((await patch(review.id, owner, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await demo(owner, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.deepEqual(await snapshot(), before);
  });

  test("the owner can list reviews and mark one reviewed; the invoice is never changed", async () => {
    const listRes = await list(owner);
    assert.equal(listRes.status, 200);
    const { data } = (await listRes.json()) as { data: { id: number; status: string }[] };
    assert.equal(data.find((r) => r.id === review.id)?.status, "OPEN");

    const invoiceBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: reviewInvoiceId } });
    const othersBefore = (await snapshot()).reviews.filter((r) => r.id !== review.id);
    assert.equal((await patch(review.id, owner, { "sec-fetch-site": "same-origin" })).status, 200);
    const marked = await prisma.paymentReview.findUniqueOrThrow({ where: { id: review.id } });
    assert.equal(marked.status, "REVIEWED");
    assert.ok(marked.reviewedAt);
    // Repeating is harmless and keeps the first reviewedAt.
    assert.equal((await patch(review.id, owner)).status, 200);
    assert.deepEqual((await prisma.paymentReview.findUniqueOrThrow({ where: { id: review.id } })).reviewedAt, marked.reviewedAt);
    assert.deepEqual(await prisma.invoice.findUniqueOrThrow({ where: { id: reviewInvoiceId } }), invoiceBefore, "invoice untouched");
    assert.deepEqual((await snapshot()).reviews.filter((r) => r.id !== review.id), othersBefore, "no other review changed");

    assert.equal((await patch(2_000_000_000, owner)).status, 404);
    assert.equal((await patch("1;DROP", owner)).status, 400);
  });

  test("the owner can run the demo; it writes nothing", async () => {
    const before = await snapshot();
    const res = await demo(owner, { "sec-fetch-site": "same-origin" });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { demo: boolean }).demo, true);
    assert.deepEqual(await snapshot(), before);
  });
});

// ── Client association ────────────────────────────────────────────────────────

describe("client association (owner invites only)", () => {
  test("a matching email alone never links an account", async () => {
    const client = await testClient("email-match");
    const res = await signupRoute(json("/api/customer/auth/signup", { name: "Match", email: client.email, password: PASSWORD }));
    assert.equal(res.status, 200);
    try {
      const row = await prisma.customer.findUniqueOrThrow({ where: { email: client.email! } });
      assert.equal(row.clientId, null);
      const { cookie } = { cookie: cookieFrom(await loginRoute(json("/api/customer/auth/login", { email: client.email, password: PASSWORD }))) };
      const { body } = await invoices(cookie);
      assert.deepEqual(body.data, []);
      assert.equal(body.meta?.linked, false);
    } finally {
      await prisma.customer.deleteMany({ where: { email: client.email! } });
    }
  });

  test("signing up or in with an invite never links by itself; explicit acceptance does, once", async () => {
    const client = await testClient("signup-invite");
    const { token } = await createInvite(client.id);
    const preview = await invitePreviewRoute(get(`/api/customer/auth/invite?token=${token}`));
    assert.deepEqual(((await preview.json()) as { data: unknown }).data, { clientName: `TEST ONLY signup-invite` });

    // An `invite` field sent to the auth endpoints is ignored.
    assert.equal((await signup("inv1", { invite: token })).status, 200);
    const { res, cookie } = await login("inv1", { invite: token });
    assert.equal(res.status, 200);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("inv1") } })).clientId, null);

    const accepted = await redeemRoute(json("/api/customer/invite", { token }, cookie));
    assert.equal(accepted.status, 200);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("inv1") } })).clientId, client.id);

    const second = await account("inv2");
    assert.equal((await redeemRoute(json("/api/customer/invite", { token }, second))).status, 400, "single use");
    assert.equal((await invitePreviewRoute(get(`/api/customer/auth/invite?token=${token}`))).status, 404);
  });

  test("an existing account accepts without a duplicate account; a duplicate signup changes nothing", async () => {
    const client = await testClient("existing-invite");
    await signup("existing");
    const { token } = await createInvite(client.id);
    assert.equal((await signup("existing", { invite: token })).status, 200);
    assert.equal(await prisma.customer.count({ where: { email: emailFor("existing") } }), 1);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("existing") } })).clientId, null);
    const { cookie } = await login("existing");
    assert.equal((await redeemRoute(json("/api/customer/invite", { token }, cookie))).status, 200);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("existing") } })).clientId, client.id);
  });

  test("expired, malformed, and unknown invites are refused", async () => {
    const client = await testClient("expired");
    const { token } = await createInvite(client.id, { now: new Date(Date.now() - INVITE_TTL_MS - 1000) });
    await signup("expired");
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("expired") } });
    for (const bad of [token, "short", generatePaymentToken(), null, 42]) {
      assert.equal(await redeemInvite(customer.id, bad), "invalid", String(bad));
    }
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).clientId, null);
  });

  test("an account linked to one client cannot be moved to another; the invite is left unused", async () => {
    const { token } = await createInvite(clientB.id);
    const res = await redeemRoute(json("/api/customer/invite", { token }, cookieA));
    assert.equal(res.status, 409);
    const a = await prisma.customer.findUniqueOrThrow({ where: { email: emailFor("a") } });
    assert.equal(a.clientId, clientA.id);
    assert.equal((await prisma.customerInvite.findUniqueOrThrow({ where: { tokenHash: hashInviteToken(token) } })).usedAt, null);
  });

  test("two accounts racing for one invite: exactly one is linked", async () => {
    const client = await testClient("race");
    const { token } = await createInvite(client.id);
    await Promise.all([signup("race1"), signup("race2")]);
    const ids = await prisma.customer.findMany({ where: { email: { in: [emailFor("race1"), emailFor("race2")] } }, select: { id: true } });
    const results = await Promise.all(ids.map((c) => redeemInvite(c.id, token)));
    assert.deepEqual([...results].sort(), ["invalid", "linked"]);
    assert.equal(await prisma.customer.count({ where: { clientId: client.id } }), 1);
  });
});

// ── Dashboard data, isolation, filters ────────────────────────────────────────

describe("dashboard data and isolation", () => {
  let invA: Record<string, Awaited<ReturnType<typeof testInvoice>>> = {};
  let invB: Awaited<ReturnType<typeof testInvoice>>;

  before(async () => {
    invA = {
      pending: await testInvoice(clientA.id, "a-pending", { paymentToken: null }),
      lateSent: await testInvoice(clientA.id, "a-late-sent", { dueDate: new Date("2026-01-01T00:00:00Z") }),
      overdue: await testInvoice(clientA.id, "a-overdue", { status: "OVERDUE", dueDate: new Date("2026-02-01T00:00:00Z") }),
      paid: await testInvoice(clientA.id, "a-paid", {
        status: "PAID",
        paypalOrderId: `CPTESTPAIDORDER${STAMP}`,
        paypalCaptureId: `CPTESTCAPTURE${STAMP}`,
        paidAt: new Date("2026-10-02T00:00:00Z"),
        paypalEnvironment: "SANDBOX",
        paymentToken: generatePaymentToken(),
      }),
      draft: await testInvoice(clientA.id, "a-draft", { status: "DRAFT" }),
      cancelled: await testInvoice(clientA.id, "a-cancelled", { status: "CANCELLED" }),
    };
    invB = await testInvoice(clientB.id, "b-pending", { paymentToken: generatePaymentToken() });
  });

  test("a customer sees only their own issued invoices", async () => {
    const { res, body } = await invoices(cookieA);
    assert.equal(res.status, 200);
    const numbers = body.data.map((i) => i.invoiceNumber).sort();
    assert.deepEqual(numbers, [invA.lateSent, invA.overdue, invA.paid, invA.pending].map((i) => i.invoiceNumber).sort());
    const forB = (await invoices(cookieB)).body.data.map((i) => i.invoiceNumber);
    assert.deepEqual(forB, [invB.invoiceNumber]);
  });

  test("responses carry no internal IDs, payment references, tokens, or emails", async () => {
    const text = JSON.stringify((await invoices(cookieA)).body) + JSON.stringify(await (await paymentsRoute(get("/api/customer/payments", cookieA))).json());
    for (const leak of [`"id"`, "clientId", "paypal", "capture", "paymentToken", "CPTEST", invA.paid.paymentToken!, emailFor("client-A"), "emailState"]) {
      assert.ok(!text.includes(leak), `must not include ${leak}`);
    }
    const keys = Object.keys((await invoices(cookieA)).body.data[0]).sort();
    assert.deepEqual(keys, ["amount", "currency", "description", "dueDate", "invoiceNumber", "issueDate", "lineItems", "paidAt", "payable", "status"]);
  });

  test("filters: All, Pending, Paid, Overdue; unknown filters are refused", async () => {
    const nums = async (status: string) => (await invoices(cookieA, status)).body.data.map((i) => i.invoiceNumber).sort();
    assert.deepEqual(await nums("pending"), [invA.pending.invoiceNumber]);
    assert.deepEqual(await nums("paid"), [invA.paid.invoiceNumber]);
    assert.deepEqual(await nums("overdue"), [invA.lateSent.invoiceNumber, invA.overdue.invoiceNumber].sort());
    assert.equal((await nums("all")).length, 4);
    assert.equal((await invoices(cookieA, "DRAFT")).res.status, 400);
    assert.equal((await invoices(cookieA, "cancelled")).res.status, 400);
  });

  test("statuses and payment eligibility come from the server", async () => {
    const byNumber = Object.fromEntries((await invoices(cookieA)).body.data.map((i) => [i.invoiceNumber, i]));
    assert.equal(byNumber[invA.pending.invoiceNumber].status, "pending");
    assert.equal(byNumber[invA.pending.invoiceNumber].payable, true);
    assert.equal(byNumber[invA.lateSent.invoiceNumber].status, "overdue");
    assert.equal(byNumber[invA.overdue.invoiceNumber].payable, true);
    assert.equal(byNumber[invA.paid.invoiceNumber].status, "paid");
    assert.equal(byNumber[invA.paid.invoiceNumber].payable, false);
    assert.equal(byNumber[invA.paid.invoiceNumber].paidAt, "2026-10-02T00:00:00.000Z");
  });

  test("empty states: an unlinked account and an empty filter return empty lists", async () => {
    const lonely = await account("lonely");
    for (const status of ["all", "pending", "paid", "overdue"]) {
      const { res, body } = await invoices(lonely, status);
      assert.equal(res.status, 200);
      assert.deepEqual(body.data, []);
      assert.equal(body.meta?.linked, false);
    }
    assert.deepEqual(((await (await paymentsRoute(get("/api/customer/payments", lonely))).json()) as { data: unknown[] }).data, []);
    assert.equal((await pay(lonely, { invoiceNumber: invA.pending.invoiceNumber })).status, 404);
    assert.deepEqual((await invoices(cookieB, "paid")).body.data, []);
  });

  test("payment history lists only this customer's verified payments", async () => {
    const a = (await (await paymentsRoute(get("/api/customer/payments", cookieA))).json()) as { data: Record<string, unknown>[] };
    assert.deepEqual(a.data, [{ invoiceNumber: invA.paid.invoiceNumber, amount: "25.50", currency: "USD", method: "PayPal", paidAt: "2026-10-02T00:00:00.000Z" }]);
    const b = (await (await paymentsRoute(get("/api/customer/payments", cookieB))).json()) as { data: unknown[] };
    assert.deepEqual(b.data, []);
  });

  test("IDOR: another client's, draft, cancelled, and malformed invoice numbers are all 404", async () => {
    for (const invoiceNumber of [invB.invoiceNumber, invA.draft.invoiceNumber, invA.cancelled.invoiceNumber, "INV-DOES-NOT-EXIST", 42, null, "x".repeat(500)]) {
      const res = await pay(cookieA, { invoiceNumber });
      assert.equal(res.status, 404, String(invoiceNumber).slice(0, 30));
    }
    // A client-supplied clientId or invoiceId is ignored.
    assert.equal((await pay(cookieA, { invoiceNumber: invB.invoiceNumber, clientId: clientB.id, invoiceId: invB.id })).status, 404);
    assert.equal((await invoicesRoute(get(`/api/customer/invoices?status=all&clientId=${clientB.id}`, cookieA))).status, 200);
    const unchanged = await prisma.invoice.findUniqueOrThrow({ where: { id: invB.id } });
    assert.equal(unchanged.paypalOrderId, null, "no order was created for another client's invoice");
  });

  test("unauthenticated portal APIs are 401", async () => {
    assert.equal((await invoicesRoute(get("/api/customer/invoices"))).status, 401);
    assert.equal((await paymentsRoute(get("/api/customer/payments"))).status, 401);
    assert.equal((await pay("", { invoiceNumber: invA.pending.invoiceNumber })).status, 401);
    assert.equal((await redeemRoute(json("/api/customer/invite", { token: "x" }))).status, 401);
  });

  test("a paid invoice cannot be paid again (409, nothing changes)", async () => {
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invA.paid.id } });
    const res = await pay(cookieA, { invoiceNumber: invA.paid.invoiceNumber });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /already paid/i);
    assert.deepEqual(await prisma.invoice.findUniqueOrThrow({ where: { id: invA.paid.id } }), before);
  });

  test("returning from PayPal while signed in goes back to the portal without creating a payment token", async () => {
    const res = await paypalReturn(get(`/api/paypal/return?token=CPTESTPAIDORDER${STAMP}`, cookieA));
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.pathname, "/portal");
    assert.equal(location.searchParams.get("invoice"), invA.paid.invoiceNumber);
    assert.equal(location.searchParams.get("payment"), "paid");
    // Another customer (or nobody) is sent to the public pay page instead.
    const other = new URL((await paypalReturn(get(`/api/paypal/return?token=CPTESTPAIDORDER${STAMP}`, cookieB))).headers.get("location")!);
    assert.equal(other.pathname, `/pay/${invA.paid.paymentToken}`);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invA.pending.id } })).paymentToken, null);
  });

  test("public payment links keep working for customers without accounts", async () => {
    const res = await publicPayRoute(new Request(`${BASE}/api/pay/${invB.paymentToken}`), { params: Promise.resolve({ token: invB.paymentToken! }) } as never);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { data: { invoiceNumber: string } }).data.invoiceNumber, invB.invoiceNumber);
  });

  test("amount tampering: the portal order is priced from MySQL", { skip: !PAYPAL_CONFIGURED && "PayPal credentials not set" }, async () => {
    const res = await pay(cookieA, { invoiceNumber: invA.pending.invoiceNumber, amount: "0.01", currency: "JPY", value: "0.01" });
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    assert.deepEqual(Object.keys(data), ["approveUrl"]);
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invA.pending.id } });
    assert.equal(stored.status, "SENT", "starting a payment never marks it paid");
    assert.equal(stored.paymentToken, null, "the portal does not need a payment token");
    const orders = new OrdersController(
      new Client({
        clientCredentialsAuthCredentials: { oAuthClientId: process.env.PAYPAL_CLIENT_ID!, oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET! },
        environment: Environment.Sandbox,
      })
    );
    const { result: order } = await orders.getOrder({ id: stored.paypalOrderId! });
    assert.equal(order.purchaseUnits?.[0]?.amount?.value, "25.50");
    assert.equal(order.purchaseUnits?.[0]?.amount?.currencyCode, "USD");

    // A second click reuses the same order instead of creating another.
    const again = (await (await pay(cookieA, { invoiceNumber: invA.pending.invoiceNumber })).json()) as { data: { approveUrl: string } };
    assert.ok(again.data.approveUrl.includes(stored.paypalOrderId!));
  });
});
