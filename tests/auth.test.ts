/**
 * Single-owner authentication regression tests.
 *
 * - Every protected API route rejects requests without a valid owner
 *   session (401), and fails closed (503) when auth is not configured.
 *   Rejected requests use bodies that would fail validation anyway, so even
 *   a missing guard could not write data or call Gemini, PayPal, or Zapier.
 * - A signed-in owner can still use those routes. These hit MySQL (reads,
 *   plus one test client that is deleted afterwards) but never Gemini,
 *   PayPal, or Zapier.
 * - PayPal webhook/return/cancel stay reachable without a browser session.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  getAuthConfig,
  hashPassword,
  loginThrottle,
  verifyPassword,
} from "@/lib/auth";
import { safeNextPath } from "@/lib/safe-redirect";
import { proxy } from "@/proxy";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as listClients, POST as createClient } from "@/app/api/clients/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/invoices/route";
import { DELETE as deleteInvoice, GET as getInvoice, PATCH as updateInvoice } from "@/app/api/invoices/[id]/route";
import { POST as createPaypalOrder } from "@/app/api/invoices/[id]/paypal-order/route";
import { POST as aiDraft } from "@/app/api/ai/invoice-draft/route";
import { POST as followUpDraft } from "@/app/api/follow-ups/draft/route";
import { POST as followUpSend } from "@/app/api/follow-ups/send/route";
import { GET as followUpStatus } from "@/app/api/follow-ups/status/route";
import { POST as paypalWebhook } from "@/app/api/paypal/webhook/route";
import { GET as paypalReturn } from "@/app/api/paypal/return/route";
import { GET as paypalCancel } from "@/app/api/paypal/cancel/route";
import { TEST_AUTH_SECRET, TEST_OWNER_PASSWORD, ownerCookie } from "./auth-helpers";
import { setEnvVar } from "../scripts/auth-setup";

const BASE = "http://localhost:3000";
const UNKNOWN_ID = "99999999";
const idCtx = { params: Promise.resolve({ id: UNKNOWN_ID }) };
/** Valid JSON that every protected route rejects with 422 before any side effect. */
const INVALID_BODY = JSON.stringify({ invoiceId: "x", name: "", request: "", status: "PAID" });

after(() => prisma.$disconnect());

type Call = (cookie?: string) => Promise<Response>;

function jsonRequest(path: string, method: string, body: string, cookie?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(`${BASE}${path}`, { method, headers, body });
}

function getRequest(path: string, cookie?: string, method = "GET"): NextRequest {
  return new NextRequest(`${BASE}${path}`, { method, headers: cookie ? { cookie } : {} });
}

const protectedRoutes: [string, Call][] = [
  ["GET /api/clients", (c) => listClients(getRequest("/api/clients", c))],
  ["POST /api/clients", (c) => createClient(jsonRequest("/api/clients", "POST", INVALID_BODY, c))],
  ["GET /api/invoices", (c) => listInvoices(getRequest("/api/invoices", c))],
  ["POST /api/invoices", (c) => createInvoice(jsonRequest("/api/invoices", "POST", INVALID_BODY, c))],
  ["GET /api/invoices/[id]", (c) => getInvoice(getRequest(`/api/invoices/${UNKNOWN_ID}`, c), idCtx as never)],
  ["PATCH /api/invoices/[id]", (c) => updateInvoice(jsonRequest(`/api/invoices/${UNKNOWN_ID}`, "PATCH", INVALID_BODY, c), idCtx as never)],
  ["DELETE /api/invoices/[id]", (c) => deleteInvoice(getRequest(`/api/invoices/${UNKNOWN_ID}`, c, "DELETE"), idCtx as never)],
  ["POST /api/invoices/[id]/paypal-order", (c) => createPaypalOrder(getRequest(`/api/invoices/${UNKNOWN_ID}/paypal-order`, c, "POST"), idCtx as never)],
  ["POST /api/ai/invoice-draft", (c) => aiDraft(jsonRequest("/api/ai/invoice-draft", "POST", INVALID_BODY, c))],
  ["POST /api/follow-ups/draft", (c) => followUpDraft(jsonRequest("/api/follow-ups/draft", "POST", INVALID_BODY, c))],
  ["POST /api/follow-ups/send", (c) => followUpSend(jsonRequest("/api/follow-ups/send", "POST", INVALID_BODY, c))],
  ["GET /api/follow-ups/status", (c) => followUpStatus(getRequest("/api/follow-ups/status", c))],
];

function loginWith(password: unknown, headers: Record<string, string> = {}, url = `${BASE}/api/auth/login`) {
  return login(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  }));
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const cookie = await ownerCookie();

describe("password hashing", () => {
  test("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("a-long-demo-password");
    assert.match(hash, /^scrypt:32768:8:1:[\w-]+:[\w-]+$/);
    assert.ok(!hash.includes("$"), "hash must survive .env variable expansion");
    assert.equal(await verifyPassword("a-long-demo-password", hash), true);
    assert.equal(await verifyPassword("a-long-demo-passwore", hash), false);
    assert.equal(await verifyPassword("", hash), false);
  });

  test("each hash uses a fresh salt", async () => {
    assert.notEqual(await hashPassword("same"), await hashPassword("same"));
  });

  test("malformed or hostile hashes never verify", async () => {
    for (const bad of ["", "plaintext", "scrypt:1:8:1:AAAA:BBBB", "scrypt:1073741824:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAA"]) {
      assert.equal(await verifyPassword("x", bad), false, bad);
    }
  });
});

describe("getAuthConfig", () => {
  test("requires a 32+ character secret and a valid hash", async () => {
    const hash = await hashPassword("pw");
    assert.equal(getAuthConfig({ OWNER_PASSWORD_HASH: hash }).ok, false);
    assert.equal(getAuthConfig({ AUTH_SECRET: "short", OWNER_PASSWORD_HASH: hash }).ok, false);
    assert.equal(getAuthConfig({ AUTH_SECRET: TEST_AUTH_SECRET }).ok, false);
    assert.equal(getAuthConfig({ AUTH_SECRET: TEST_AUTH_SECRET, OWNER_PASSWORD_HASH: "hunter2" }).ok, false);
    assert.equal(getAuthConfig({ AUTH_SECRET: TEST_AUTH_SECRET, OWNER_PASSWORD_HASH: hash }).ok, true);
  });
});

describe("protected API routes reject unauthenticated requests", () => {
  for (const [name, call] of protectedRoutes) {
    test(`${name}: no session → 401`, async () => {
      const res = await call();
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { error: string }).error, "Authentication required");
    });

    test(`${name}: forged or garbage session cookie → 401`, async () => {
      for (const forged of [`${SESSION_COOKIE}=owner`, `${SESSION_COOKIE}=${"A".repeat(200)}`, `${SESSION_COOKIE}=`]) {
        assert.equal((await call(forged)).status, 401, forged);
      }
    });
  }

  test("a session sealed with a different AUTH_SECRET → 401", async () => {
    const foreign = await withEnv({ AUTH_SECRET: "another-secret-another-secret-another-secret" }, ownerCookie);
    for (const [name, call] of protectedRoutes) {
      assert.equal((await call(foreign)).status, 401, name);
    }
  });

  test("changing the owner password signs out existing sessions → 401", async () => {
    const newHash = await hashPassword("a-brand-new-password");
    await withEnv({ OWNER_PASSWORD_HASH: newHash }, async () => {
      for (const [name, call] of protectedRoutes) {
        assert.equal((await call(cookie)).status, 401, name);
      }
    });
  });

  test("an expired session → 401", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + (SESSION_TTL_SECONDS + 120) * 1000 });
    for (const [name, call] of protectedRoutes) {
      assert.equal((await call(cookie)).status, 401, name);
    }
  });

  test("auth not configured → 503 for everyone (fails closed)", async () => {
    await withEnv({ AUTH_SECRET: undefined, OWNER_PASSWORD_HASH: undefined }, async () => {
      for (const [name, call] of protectedRoutes) {
        assert.equal((await call(cookie)).status, 503, name);
      }
      assert.equal((await loginWith(TEST_OWNER_PASSWORD)).status, 503);
    });
  });
});

describe("signed-in owner can still perform permitted actions", () => {
  test("every protected route gets past auth (to validation, lookup, or success)", async () => {
    for (const [name, call] of protectedRoutes) {
      const res = await call(cookie);
      assert.ok(![401, 403, 503].includes(res.status), `${name} → ${res.status}`);
    }
  });

  test("list clients and invoices", async () => {
    const clients = await listClients(getRequest("/api/clients", cookie));
    assert.equal(clients.status, 200);
    assert.ok(Array.isArray(((await clients.json()) as { data: unknown }).data));
    const invoices = await listInvoices(getRequest("/api/invoices?limit=1", cookie));
    assert.equal(invoices.status, 200);
  });

  test("create a client (deleted afterwards)", async () => {
    const res = await createClient(jsonRequest("/api/clients", "POST", JSON.stringify({ name: "Auth Test Client (delete me)" }), cookie));
    assert.equal(res.status, 201);
    const { data } = (await res.json()) as { data: { id: number; name: string } };
    try {
      assert.equal(data.name, "Auth Test Client (delete me)");
    } finally {
      await prisma.client.delete({ where: { id: data.id } });
    }
  });

  test("invoice lookups, payment, and follow-ups reach business logic", async () => {
    assert.equal((await getInvoice(getRequest(`/api/invoices/${UNKNOWN_ID}`, cookie), idCtx as never)).status, 404);
    const patch = jsonRequest(`/api/invoices/${UNKNOWN_ID}`, "PATCH", JSON.stringify({ description: "x" }), cookie);
    assert.equal((await updateInvoice(patch, idCtx as never)).status, 404);
    assert.equal((await deleteInvoice(getRequest(`/api/invoices/${UNKNOWN_ID}`, cookie, "DELETE"), idCtx as never)).status, 404);
    const order = getRequest(`/api/invoices/${UNKNOWN_ID}/paypal-order`, cookie, "POST");
    assert.equal((await createPaypalOrder(order, idCtx as never)).status, 404);
    const draft = jsonRequest("/api/follow-ups/draft", "POST", JSON.stringify({ invoiceId: Number(UNKNOWN_ID) }), cookie);
    assert.equal((await followUpDraft(draft)).status, 404);
    assert.equal((await followUpStatus(getRequest("/api/follow-ups/status", cookie))).status, 200);
  });

  test("PAID still cannot be set through the API, even when signed in", async () => {
    const res = await updateInvoice(jsonRequest(`/api/invoices/${UNKNOWN_ID}`, "PATCH", JSON.stringify({ status: "PAID" }), cookie), idCtx as never);
    assert.equal(res.status, 422);
  });
});

describe("login and logout", () => {
  test("correct password → session cookie with safe attributes", async () => {
    const res = await loginWith(TEST_OWNER_PASSWORD);
    assert.equal(res.status, 200);
    const [setCookie] = res.headers.getSetCookie();
    assert.ok(setCookie.startsWith(`${SESSION_COOKIE}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
    assert.match(setCookie, /Max-Age=\d+/i);
    assert.doesNotMatch(setCookie, new RegExp(TEST_OWNER_PASSWORD));
  });

  test("the cookie is Secure on any non-loopback host", async () => {
    const res = await loginWith(TEST_OWNER_PASSWORD, {}, "https://demo.example.com/api/auth/login");
    assert.match(res.headers.getSetCookie()[0], /Secure/i);
  });

  test("wrong, missing, or oversized password → no cookie", async () => {
    loginThrottle.reset();
    const wrong = await loginWith("not-the-password");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.getSetCookie().length, 0);
    assert.equal((await loginWith(undefined)).status, 422);
    assert.equal((await loginWith("")).status, 422);
    assert.equal((await loginWith(42)).status, 422);
    loginThrottle.reset();
  });

  test("cross-site and non-JSON login attempts are refused (login CSRF)", async () => {
    assert.equal((await loginWith(TEST_OWNER_PASSWORD, { "sec-fetch-site": "cross-site" })).status, 403);
    const form = await login(new Request(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${TEST_OWNER_PASSWORD}`,
    }));
    assert.equal(form.status, 415);
  });

  test("repeated failures are throttled, even for the correct password", async () => {
    loginThrottle.reset();
    try {
      for (let i = 0; i < loginThrottle.MAX_FAILURES; i++) {
        assert.equal((await loginWith(`wrong-${i}`)).status, 401);
      }
      const blocked = await loginWith(TEST_OWNER_PASSWORD);
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
      assert.equal(blocked.headers.getSetCookie().length, 0);
    } finally {
      loginThrottle.reset();
    }
  });

  test("logout expires the cookie; cross-site logout is refused", async () => {
    const res = await logout(new Request(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie } }));
    assert.equal(res.status, 200);
    assert.match(res.headers.getSetCookie()[0], new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`, "i"));
    const crossSite = await logout(new Request(`${BASE}/api/auth/logout`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    assert.equal(crossSite.status, 403);
  });
});

describe("PayPal callbacks work without a browser session", () => {
  test("webhook still requires a valid PayPal signature, not a session", async () => {
    await withEnv({ PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID || "UNREGISTERED-TEST-WEBHOOK-ID" }, async () => {
      const res = await paypalWebhook(jsonRequest("/api/paypal/webhook", "POST", JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" })));
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as { error: string }).error, "Invalid signature");
    });
  });

  test("return and cancel redirect the payer without a session", async () => {
    const ret = await paypalReturn(getRequest("/api/paypal/return?token=bad-token!"));
    assert.equal(ret.status, 303);
    assert.match(ret.headers.get("location") ?? "", /\/invoices\?payment=error$/);
    const cancel = await paypalCancel(getRequest("/api/paypal/cancel"));
    assert.equal(cancel.status, 303);
  });
});

describe("proxy", () => {
  const passesThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

  test("signed-out page visits redirect to /login, keeping the target", async () => {
    const res = await proxy(getRequest("/invoices?payment=paid&invoice=INV-1"));
    assert.equal(res.status, 307);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.pathname, "/login");
    assert.equal(location.searchParams.get("next"), "/invoices?payment=paid&invoice=INV-1");
  });

  test("signed-in page visits pass through; /login redirects home", async () => {
    assert.ok(passesThrough(await proxy(getRequest("/follow-ups", cookie))));
    const res = await proxy(getRequest("/login", cookie));
    assert.equal(new URL(res.headers.get("location")!).pathname, "/");
  });

  test("signed-out API calls get 401; public endpoints pass through", async () => {
    assert.equal((await proxy(getRequest("/api/clients"))).status, 401);
    assert.ok(passesThrough(await proxy(getRequest("/api/clients", cookie))));
    for (const path of ["/login", "/api/auth/login", "/api/paypal/webhook", "/api/paypal/return?token=X", "/api/paypal/cancel"]) {
      assert.ok(passesThrough(await proxy(getRequest(path))), path);
    }
  });
});

describe("safeNextPath (no open redirect after login)", () => {
  test("keeps same-origin paths", () => {
    assert.equal(safeNextPath("/invoices?payment=paid"), "/invoices?payment=paid");
    assert.equal(safeNextPath("/follow-ups"), "/follow-ups");
  });

  test("rejects external, protocol-relative, and odd targets", () => {
    for (const bad of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/login", "invoices"]) {
      assert.equal(safeNextPath(bad), "/", String(bad));
    }
  });
});

describe("auth:setup .env update", () => {
  test("replaces existing assignments and keeps everything else", () => {
    const before = 'DATABASE_URL="mysql://x"\r\nAUTH_SECRET="old"\r\n# AUTH_SECRET in a comment stays\r\nGEMINI_API_KEY="k"\r\n';
    assert.equal(
      setEnvVar(before, "AUTH_SECRET", "new"),
      'DATABASE_URL="mysql://x"\r\nAUTH_SECRET="new"\r\n# AUTH_SECRET in a comment stays\r\nGEMINI_API_KEY="k"\r\n'
    );
  });

  test("appends when missing, with or without a trailing newline", () => {
    assert.equal(setEnvVar("", "OWNER_PASSWORD_HASH", "h"), 'OWNER_PASSWORD_HASH="h"\n');
    assert.equal(setEnvVar("A=1", "OWNER_PASSWORD_HASH", "h"), 'A=1\nOWNER_PASSWORD_HASH="h"\n');
    assert.equal(setEnvVar("A=1\n", "OWNER_PASSWORD_HASH", "h"), 'A=1\nOWNER_PASSWORD_HASH="h"\n');
  });
});
