/**
 * End-to-end customer invoice → payment workflow, through the real route
 * handlers and MySQL, with PayPal fully mocked.
 *
 * Owner creates a SENT invoice → the linked customer sees it in the portal →
 * starts payment → a verified webhook marks it PAID exactly once; forged
 * webhooks are refused and suspicious payments are held for owner review.
 *
 * Isolation:
 *  - DB rows are test-owned only (clients "Workflow Test …", invoices
 *    INV-TEST-WF-<stamp>-…, customers wf-…-<stamp>@example.invalid) and are
 *    removed afterwards, children first.
 *  - PayPal is an in-memory fake: OrdersController and the OAuth token fetch
 *    are stubbed, and global fetch only answers the signature-verification
 *    call. Any other outbound request (PayPal, Zapier, email) fails the test.
 *  - PayPal and Zapier credentials are replaced with placeholders in this
 *    process, so nothing real is reachable even if a stub is missed.
 */

import { after, before, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Client, Environment, OrdersController, type Order } from "@paypal/paypal-server-sdk";
import { prisma } from "@/lib/prisma";
import { customerThrottles } from "@/lib/customer-auth";
import { createInvite } from "@/lib/customer-invites";
import { POST as createInvoiceRoute } from "@/app/api/invoices/route";
import { POST as createPaymentLink } from "@/app/api/invoices/[id]/payment-link/route";
import { POST as signupRoute } from "@/app/api/customer/auth/signup/route";
import { POST as loginRoute } from "@/app/api/customer/auth/login/route";
import { POST as redeemRoute } from "@/app/api/customer/invite/route";
import { GET as portalInvoicesRoute } from "@/app/api/customer/invoices/route";
import { POST as portalPayRoute } from "@/app/api/customer/invoices/pay/route";
import { GET as portalPaymentsRoute } from "@/app/api/customer/payments/route";
import { GET as publicPayRoute } from "@/app/api/pay/[token]/route";
import { POST as publicOrderRoute } from "@/app/api/pay/[token]/order/route";
import { POST as webhookRoute } from "@/app/api/paypal/webhook/route";
import { ownerCookie } from "./auth-helpers";
import { cleanupTestRecords } from "./cleanup";

// ── Placeholder credentials (never real) ──────────────────────────────────────

process.env.PAYPAL_CLIENT_ID = "TEST-NOT-A-REAL-CLIENT-ID";
process.env.PAYPAL_CLIENT_SECRET = "TEST-NOT-A-REAL-SECRET";
process.env.PAYPAL_BASE_URL = "https://api-m.sandbox.paypal.com";
process.env.PAYPAL_WEBHOOK_ID = "TEST-WEBHOOK-ID";
for (const key of Object.keys(process.env)) if (key.startsWith("ZAPIER_")) delete process.env[key];

const BASE = "http://localhost:3000";
const STAMP = `${Date.now()}`;
const PASSWORD = "workflow-test-password-1";
const VERIFY_URL = "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature";
/** The only transmission signature the fake PayPal verifier accepts. */
const GENUINE_SIG = "GENUINE-TEST-SIGNATURE";

const created = { clientIds: [] as number[], invoiceIds: [] as number[] };

// ── Fake PayPal ───────────────────────────────────────────────────────────────

const paypal = {
  orders: new Map<string, Order>(),
  /** Capture amount PayPal will report, per order (defaults to the order amount). */
  captureAmount: new Map<string, { currencyCode: string; value: string }>(),
  nextId: 0,
  verifyBodies: [] as string[],
  unexpected: [] as string[],
};

const createOrder = mock.method(OrdersController.prototype, "createOrder", async ({ body }: { body: Order }) => {
  const id = `TESTWF${STAMP}${++paypal.nextId}`;
  const order: Order = {
    id,
    intent: body.intent,
    status: "PAYER_ACTION_REQUIRED" as Order["status"],
    purchaseUnits: structuredClone(body.purchaseUnits),
    links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, method: "GET" as never }],
  };
  paypal.orders.set(id, order);
  return { result: structuredClone(order), statusCode: 201, headers: {}, body: "" };
});

mock.method(OrdersController.prototype, "getOrder", async ({ id }: { id: string }) => {
  const order = paypal.orders.get(id);
  if (!order) throw new Error(`fake PayPal: unknown order ${id}`);
  return { result: structuredClone(order), statusCode: 200, headers: {}, body: "" };
});

const captureOrder = mock.method(OrdersController.prototype, "captureOrder", async ({ id }: { id: string }) => {
  const order = paypal.orders.get(id);
  if (!order || order.status !== "APPROVED") throw new Error(`fake PayPal: order ${id} is not approved`);
  const unit = order.purchaseUnits![0];
  order.status = "COMPLETED" as Order["status"];
  unit.payments = {
    captures: [{
      id: `TESTCAP${id}`,
      status: "COMPLETED" as never,
      amount: paypal.captureAmount.get(id) ?? unit.amount,
      createTime: "2026-11-09T10:00:00Z",
    }],
  };
  return { result: structuredClone(order), statusCode: 201, headers: {}, body: "" };
});

// The OAuth manager class isn't exported; reach its prototype through a throwaway client.
const authManagerProto = Object.getPrototypeOf(
  new Client({ clientCredentialsAuthCredentials: { oAuthClientId: "x", oAuthClientSecret: "y" }, environment: Environment.Sandbox })
    .clientCredentialsAuthManager
);
mock.method(authManagerProto, "fetchToken", async () => ({
  accessToken: "TEST-ACCESS-TOKEN",
  tokenType: "Bearer",
  expiresIn: BigInt(3600),
  expiry: BigInt(Math.round(Date.now() / 1000) + 3600),
}));

const fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== VERIFY_URL) {
    paypal.unexpected.push(url);
    throw new Error(`unexpected network call in test: ${url}`);
  }
  const body = String(init?.body);
  paypal.verifyBodies.push(body);
  const { transmission_sig, webhook_id } = JSON.parse(body) as { transmission_sig: string; webhook_id: string };
  const ok = transmission_sig === GENUINE_SIG && webhook_id === "TEST-WEBHOOK-ID";
  return Response.json({ verification_status: ok ? "SUCCESS" : "FAILURE" });
});

/** The buyer approves the order on PayPal's side. */
function buyerApproves(orderId: string) {
  const order = paypal.orders.get(orderId);
  assert.ok(order, `fake order ${orderId} exists`);
  order.status = "APPROVED" as Order["status"];
}

// ── Request helpers ───────────────────────────────────────────────────────────

const emailFor = (label: string) => `wf-${label}-${STAMP}@example.invalid`;
const idCtx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) }) as never;
const tokenCtx = (token: string) => ({ params: Promise.resolve({ token }) }) as never;

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const cookieFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function customerAccount(label: string, clientId: number): Promise<string> {
  const email = emailFor(label);
  assert.equal((await signupRoute(postJson("/api/customer/auth/signup", { name: `Workflow ${label}`, email, password: PASSWORD }))).status, 200);
  const res = await loginRoute(postJson("/api/customer/auth/login", { email, password: PASSWORD }));
  assert.equal(res.status, 200);
  const cookie = cookieFrom(res);
  const { token } = await createInvite(clientId);
  assert.equal((await redeemRoute(postJson("/api/customer/invite", { token }, { cookie }))).status, 200);
  return cookie;
}

let owner = "";
async function ownerCreatesInvoice(body: Record<string, unknown>) {
  const res = await createInvoiceRoute(postJson("/api/invoices", body, { cookie: owner }));
  const json = (await res.json()) as { ok: boolean; data?: { id: number; invoiceNumber: string } };
  if (json.data?.id) created.invoiceIds.push(json.data.id);
  return { res, json };
}
const invoiceBody = (suffix: string, clientId: number, extra: Record<string, unknown> = {}) => ({
  invoiceNumber: `INV-TEST-WF-${STAMP}-${suffix}`,
  clientId,
  description: "TEST ONLY - payment workflow test",
  amount: 80,
  currency: "USD",
  issueDate: "2026-11-01T00:00:00.000Z",
  dueDate: "2099-12-01T00:00:00.000Z",
  status: "SENT",
  ...extra,
});

async function portalInvoices(cookie: string) {
  const res = await portalInvoicesRoute(new NextRequest(`${BASE}/api/customer/invoices?status=all`, { headers: { cookie } }));
  return { res, data: ((await res.json()) as { data: Record<string, unknown>[] }).data };
}
const portalPay = (cookie: string, body: unknown) => portalPayRoute(postJson("/api/customer/invoices/pay", body, cookie ? { cookie } : {}));

function webhookHeaders(sig = GENUINE_SIG): Record<string, string> {
  return {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
    "paypal-transmission-id": randomUUID(),
    "paypal-transmission-sig": sig,
    "paypal-transmission-time": new Date().toISOString(),
  };
}
function captureCompleted(orderId: string, eventId = `WH-TEST-WF-${randomUUID()}`): string {
  return JSON.stringify({
    id: eventId,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: `TESTCAP${orderId}`, status: "COMPLETED", supplementary_data: { related_ids: { order_id: orderId } } },
  });
}
async function deliver(body: string, headers = webhookHeaders()) {
  const res = await webhookRoute(new Request(`${BASE}/api/paypal/webhook`, { method: "POST", headers, body }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; result?: string; error?: string } };
}

const paymentState = (id: number) =>
  prisma.invoice.findUniqueOrThrow({
    where: { id },
    select: { status: true, amount: true, currency: true, paypalOrderId: true, paypalCaptureId: true, paidAt: true, paypalEnvironment: true, updatedAt: true },
  });

// ── Fixtures ──────────────────────────────────────────────────────────────────

let clientA: { id: number };
let clientB: { id: number };
let cookieA = "";
let cookieB = "";
/** EUR invoice for client A, created by the owner through the API. */
let invA: { id: number; invoiceNumber: string };
/** Client B's invoice — client A must never reach it. */
let invB: { id: number; invoiceNumber: string };
let orderA = "";

before(async () => {
  owner = await ownerCookie();
  customerThrottles.reset();
  for (const label of ["A", "B"]) {
    const client = await prisma.client.create({
      data: { name: `Workflow Test ${label} ${STAMP} (TEST ONLY)`, email: emailFor(`client-${label}`), company: "TEST ONLY" },
    });
    created.clientIds.push(client.id);
    if (label === "A") clientA = client; else clientB = client;
  }
  cookieA = await customerAccount("a", clientA.id);
  cookieB = await customerAccount("b", clientB.id);
});

beforeEach(() => customerThrottles.reset());

after(async () => {
  // Removes only what this file created, children first.
  let customerIds: number[] = [];
  await cleanupTestRecords(
    async () => {
      const customers = await prisma.customer.findMany({ where: { email: { startsWith: "wf-", endsWith: `-${STAMP}@example.invalid` } }, select: { id: true } });
      customerIds = customers.map((c) => c.id);
    },
    () => prisma.paymentReview.deleteMany({ where: { invoiceId: { in: created.invoiceIds } } }),
    () => prisma.paymentReview.deleteMany({ where: { paypalOrderId: `TESTWFUNKNOWN${STAMP}`, invoiceId: null } }),
    () => prisma.customerInvite.deleteMany({ where: { OR: [{ clientId: { in: created.clientIds } }, { usedByCustomerId: { in: customerIds } }] } }),
    () => prisma.customer.deleteMany({ where: { id: { in: customerIds } } }),
    () => prisma.invoice.deleteMany({ where: { id: { in: created.invoiceIds }, invoiceNumber: { startsWith: `INV-TEST-WF-${STAMP}-` } } }),
    () => prisma.client.deleteMany({ where: { id: { in: created.clientIds }, name: { startsWith: "Workflow Test" } } }),
    () => customerThrottles.reset(),
    () => mock.restoreAll(),
  );
  assert.deepEqual(paypal.unexpected, [], "no real network call was attempted");
});

// ── 1–2. Owner creates a SENT invoice ─────────────────────────────────────────

describe("1–2. owner creates an invoice for an existing customer", () => {
  test("POST /api/invoices with status SENT → 201, stored as SENT with the given amount, currency and client", async () => {
    const { res, json } = await ownerCreatesInvoice(
      invoiceBody("a", clientA.id, { amount: 1234.5, currency: "EUR", lineItems: [{ description: "Consulting", quantity: 2, rate: 617.25 }] })
    );
    assert.equal(res.status, 201);
    invA = json.data!;
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invA.id } });
    assert.equal(stored.status, "SENT");
    assert.equal(stored.clientId, clientA.id);
    assert.equal(stored.amount.toFixed(2), "1234.50");
    assert.equal(stored.currency, "EUR");
    assert.equal(stored.invoiceNumber, `INV-TEST-WF-${STAMP}-a`);
    assert.deepEqual([stored.paypalOrderId, stored.paypalCaptureId, stored.paidAt], [null, null, null]);

    const b = await ownerCreatesInvoice(invoiceBody("b", clientB.id, { amount: 50 }));
    assert.equal(b.res.status, 201);
    invB = b.json.data!;
    assert.equal(fetchMock.mock.callCount(), 0, "creating an invoice sends no email or webhook");
  });

  test("PAID cannot be set at creation, unauthenticated creation is refused, and unknown clients are rejected", async () => {
    assert.equal((await ownerCreatesInvoice(invoiceBody("paid", clientA.id, { status: "PAID" }))).res.status, 422);
    assert.equal((await createInvoiceRoute(postJson("/api/invoices", invoiceBody("anon", clientA.id)))).status, 401);
    assert.equal((await ownerCreatesInvoice(invoiceBody("noclient", 2_000_000_000))).res.status, 422);
    assert.equal(await prisma.invoice.count({ where: { invoiceNumber: { in: ["paid", "anon", "noclient"].map((s) => `INV-TEST-WF-${STAMP}-${s}`) } } }), 0);
  });
});

// ── 3–4. Portal visibility and IDOR ───────────────────────────────────────────

describe("3–4. customer portal shows the invoice only to the linked customer", () => {
  test("customer A sees their new invoice with server-computed amount, currency and status", async () => {
    const { res, data } = await portalInvoices(cookieA);
    assert.equal(res.status, 200);
    assert.deepEqual(data.map((i) => i.invoiceNumber), [invA.invoiceNumber]);
    assert.equal(data[0].amount, "1234.50");
    assert.equal(data[0].currency, "EUR");
    assert.equal(data[0].status, "pending");
    assert.equal(data[0].payable, true);
    assert.deepEqual((await portalInvoices(cookieB)).data.map((i) => i.invoiceNumber), [invB.invoiceNumber]);
  });

  test("IDOR: customer A cannot start payment on B's invoice, even with injected IDs; no PayPal call is made", async () => {
    const before = createOrder.mock.callCount();
    for (const body of [
      { invoiceNumber: invB.invoiceNumber },
      { invoiceNumber: invB.invoiceNumber, clientId: clientB.id, invoiceId: invB.id },
    ]) {
      const res = await portalPay(cookieA, body);
      assert.equal(res.status, 404);
      assert.doesNotMatch(await res.text(), /Workflow Test B|example\.invalid|TEST ONLY/);
    }
    const injected = await portalInvoicesRoute(new NextRequest(`${BASE}/api/customer/invoices?status=all&clientId=${clientB.id}`, { headers: { cookie: cookieA } }));
    assert.deepEqual(((await injected.json()) as { data: { invoiceNumber: string }[] }).data.map((i) => i.invoiceNumber), [invA.invoiceNumber]);
    assert.equal(createOrder.mock.callCount(), before);
    assert.equal((await paymentState(invB.id)).paypalOrderId, null);
  });

  test("signed-out callers get 401", async () => {
    assert.equal((await portalInvoicesRoute(new NextRequest(`${BASE}/api/customer/invoices`))).status, 401);
    assert.equal((await portalPay("", { invoiceNumber: invA.invoiceNumber })).status, 401);
  });
});

// ── 5–7. Payment link, order pricing, invalid requests ────────────────────────

describe("5–7. secure payment link and PayPal order creation", () => {
  test("customer retrieves a PayPal approval link; the order is priced from MySQL, ignoring tampered body fields", async () => {
    const res = await portalPay(cookieA, { invoiceNumber: invA.invoiceNumber, amount: "0.01", currency: "JPY", value: "0.01", invoiceId: invB.id });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const { data } = (await res.json()) as { data: Record<string, string> };
    assert.deepEqual(Object.keys(data), ["approveUrl"]);

    assert.equal(createOrder.mock.callCount(), 1);
    const [request] = createOrder.mock.calls[0].arguments as [{ body: Order; paypalRequestId: string }];
    assert.equal(request.body.intent, "CAPTURE");
    assert.equal(request.body.purchaseUnits?.length, 1);
    const unit = request.body.purchaseUnits![0];
    assert.deepEqual(unit.amount, { currencyCode: "EUR", value: "1234.50" });
    assert.equal(unit.referenceId, String(invA.id));
    assert.equal(unit.customId, String(invA.id));
    assert.equal((unit as { invoiceId?: string }).invoiceId, invA.invoiceNumber);

    const stored = await paymentState(invA.id);
    orderA = stored.paypalOrderId!;
    assert.ok(orderA);
    assert.equal(data.approveUrl, `https://www.sandbox.paypal.com/checkoutnow?token=${orderA}`);
    assert.equal(stored.status, "SENT", "starting a payment never marks it paid");
  });

  test("a second click reuses the same order instead of creating another", async () => {
    const res = await portalPay(cookieA, { invoiceNumber: invA.invoiceNumber });
    assert.equal(res.status, 200);
    assert.match(((await res.json()) as { data: { approveUrl: string } }).data.approveUrl, new RegExp(`token=${orderA}$`));
    assert.equal(createOrder.mock.callCount(), 1);
    assert.equal((await paymentState(invA.id)).paypalOrderId, orderA);
  });

  test("owner-issued public payment link resolves to the same invoice and the same order", async () => {
    const linkRes = await createPaymentLink(new Request(`${BASE}/api/invoices/${invA.id}/payment-link`, { method: "POST", headers: { cookie: owner } }), idCtx(invA.id));
    assert.equal(linkRes.status, 200);
    const { url } = ((await linkRes.json()) as { data: { url: string } }).data;
    const token = new URL(url).pathname.split("/").pop()!;
    const view = (await (await publicPayRoute(new Request(`${BASE}/api/pay/${token}`), tokenCtx(token))).json()) as { data: Record<string, unknown> };
    assert.equal(view.data.invoiceNumber, invA.invoiceNumber);
    assert.equal(view.data.amount, "1234.50");

    const order = await publicOrderRoute(postJson(`/api/pay/${token}/order`, { amount: "0.01" }), tokenCtx(token));
    assert.equal(order.status, 200);
    assert.equal(createOrder.mock.callCount(), 1, "tampered public request reuses the MySQL-priced order");
  });

  test("invalid payment requests are rejected without creating orders", async () => {
    const before = createOrder.mock.callCount();
    for (const body of [{}, { invoiceNumber: 42 }, { invoiceNumber: null }, { invoiceNumber: "x".repeat(500) }, { invoiceNumber: "INV-DOES-NOT-EXIST" }]) {
      assert.equal((await portalPay(cookieA, body)).status, 404, JSON.stringify(body).slice(0, 40));
    }
    const malformed = await portalPayRoute(postJson("/api/customer/invoices/pay", "{not json", { cookie: cookieA }));
    assert.ok(malformed.status >= 400 && malformed.status < 500, `malformed JSON → ${malformed.status}`);
    const huge = await portalPay(cookieA, { invoiceNumber: invA.invoiceNumber, pad: "x".repeat(8 * 1024) });
    assert.ok(huge.status >= 400 && huge.status < 500, `oversized body → ${huge.status}`);

    const bogus = "A".repeat(43);
    assert.equal((await publicOrderRoute(postJson(`/api/pay/${bogus}/order`, {}), tokenCtx(bogus))).status, 404);
    assert.equal((await publicOrderRoute(postJson("/api/pay/x/order", {}, { "sec-fetch-site": "cross-site" }), tokenCtx("x"))).status, 403);
    assert.equal(createOrder.mock.callCount(), before);
  });
});

// ── 8–10. Webhooks ────────────────────────────────────────────────────────────

describe("8–10. PayPal webhook", () => {
  test("10. forged, missing, and malformed signatures → 401; nothing captured or changed", async () => {
    buyerApproves(orderA);
    const before = await paymentState(invA.id);
    const verifyCalls = fetchMock.mock.callCount();

    assert.equal((await deliver(captureCompleted(orderA), webhookHeaders("FORGED-SIGNATURE"))).status, 401);
    assert.equal(fetchMock.mock.callCount(), verifyCalls + 1, "forged signature was checked with PayPal");
    assert.equal((await deliver(captureCompleted(orderA), { "content-type": "application/json" })).status, 401);
    assert.equal((await deliver('{"a":1},"webhook_id":"attacker"')).status, 401);
    assert.equal(fetchMock.mock.callCount(), verifyCalls + 1, "missing headers / non-object bodies are refused before any network call");

    assert.equal(captureOrder.mock.callCount(), 0, "no capture on an unverified event");
    assert.deepEqual(await paymentState(invA.id), before);
    assert.equal(await prisma.paymentReview.count({ where: { invoiceId: invA.id } }), 0);
  });

  test("8. a verified PAYMENT.CAPTURE.COMPLETED webhook marks the invoice PAID with the verified capture", async () => {
    const res = await deliver(captureCompleted(orderA, `WH-TEST-WF-${STAMP}-paid`));
    assert.deepEqual([res.status, res.body.result], [200, "paid"]);
    const verified = JSON.parse(paypal.verifyBodies.at(-1)!) as { webhook_id: string; webhook_event: { id: string } };
    assert.equal(verified.webhook_id, "TEST-WEBHOOK-ID");
    assert.equal(verified.webhook_event.id, `WH-TEST-WF-${STAMP}-paid`, "the raw event is embedded unmodified");

    assert.equal(captureOrder.mock.callCount(), 1);
    const stored = await paymentState(invA.id);
    assert.equal(stored.status, "PAID");
    assert.equal(stored.paypalCaptureId, `TESTCAP${orderA}`);
    assert.equal(stored.paidAt?.toISOString(), "2026-11-09T10:00:00.000Z");
    assert.equal(stored.paypalEnvironment, "SANDBOX");
    assert.equal(await prisma.paymentReview.count({ where: { invoiceId: invA.id } }), 0);

    const portal = (await portalInvoices(cookieA)).data[0];
    assert.deepEqual([portal.status, portal.payable], ["paid", false]);
  });

  test("9. duplicate deliveries (same event, new event, ORDER.APPROVED) create no second payment", async () => {
    const before = await paymentState(invA.id);
    const body = captureCompleted(orderA, `WH-TEST-WF-${STAMP}-paid`);
    const headers = webhookHeaders();
    for (const [b, h] of [[body, headers], [body, headers], [captureCompleted(orderA), webhookHeaders()]] as const) {
      const res = await deliver(b, h);
      assert.deepEqual([res.status, res.body.result], [200, "already_processed"]);
    }
    const approved = JSON.stringify({ id: `WH-TEST-WF-${randomUUID()}`, event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: orderA, status: "APPROVED" } });
    assert.deepEqual((await deliver(approved)).body.result, "already_processed");

    assert.equal(captureOrder.mock.callCount(), 1, "PayPal capture happened exactly once");
    assert.deepEqual(await paymentState(invA.id), before, "invoice untouched by redelivery");
    assert.equal(await prisma.invoice.count({ where: { paypalCaptureId: `TESTCAP${orderA}` } }), 1);
    assert.equal(await prisma.paymentReview.count({ where: { invoiceId: invA.id } }), 0);

    const payments = (await (await portalPaymentsRoute(new NextRequest(`${BASE}/api/customer/payments`, { headers: { cookie: cookieA } }))).json()) as { data: unknown[] };
    assert.equal(payments.data.length, 1);
    const again = await portalPay(cookieA, { invoiceNumber: invA.invoiceNumber });
    assert.equal(again.status, 409, "a paid invoice cannot start another payment");
  });
});

// ── 11. Suspicious payments are held ──────────────────────────────────────────

describe("11. suspicious payments are held for owner review", () => {
  async function startPaidFlow(suffix: string) {
    const { json } = await ownerCreatesInvoice(invoiceBody(suffix, clientA.id));
    const invoice = json.data!;
    assert.equal((await portalPay(cookieA, { invoiceNumber: invoice.invoiceNumber })).status, 200);
    const orderId = (await paymentState(invoice.id)).paypalOrderId!;
    buyerApproves(orderId);
    return { invoice, orderId };
  }
  const reviewsFor = (invoiceId: number) =>
    prisma.paymentReview.findMany({ where: { invoiceId }, select: { code: true, status: true, expected: true, observed: true, paypalOrderId: true } });

  test("capture for the wrong amount → 200 held, invoice stays SENT, one OPEN AMOUNT_MISMATCH review (also on redelivery)", async () => {
    const { invoice, orderId } = await startPaidFlow("short");
    paypal.captureAmount.set(orderId, { currencyCode: "USD", value: "8.00" });
    const body = captureCompleted(orderId);
    for (let i = 0; i < 2; i++) {
      const res = await deliver(body);
      assert.deepEqual([res.status, res.body.result], [200, "held"]);
    }
    const stored = await paymentState(invoice.id);
    assert.equal(stored.status, "SENT");
    assert.equal(stored.paypalCaptureId, null);
    assert.deepEqual(await reviewsFor(invoice.id), [{ code: "AMOUNT_MISMATCH", status: "OPEN", expected: "USD 80.00", observed: "USD 8.00", paypalOrderId: orderId }]);
  });

  test("invoice amount changed after the order was priced → held as ORDER_MISMATCH before any capture", async () => {
    const { invoice, orderId } = await startPaidFlow("changed");
    await prisma.invoice.update({ where: { id: invoice.id }, data: { amount: "999.00" } });
    const captures = captureOrder.mock.callCount();
    const res = await deliver(captureCompleted(orderId));
    assert.deepEqual([res.status, res.body.result], [200, "held"]);
    assert.equal(captureOrder.mock.callCount(), captures, "no money moved");
    assert.equal((await paymentState(invoice.id)).status, "SENT");
    assert.deepEqual((await reviewsFor(invoice.id)).map((r) => [r.code, r.status]), [["ORDER_MISMATCH", "OPEN"]]);
  });

  test("verified event for an order no invoice knows about → flagged, no invoice changed", async () => {
    const before = await prisma.invoice.findMany({ where: { id: { in: created.invoiceIds } }, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } });
    const unknown = `TESTWFUNKNOWN${STAMP}`;
    const res = await deliver(captureCompleted(unknown));
    assert.deepEqual([res.status, res.body.result], [200, "flagged"]);
    const review = await prisma.paymentReview.findFirst({ where: { paypalOrderId: unknown } });
    assert.equal(review?.code, "UNKNOWN_ORDER");
    await prisma.paymentReview.deleteMany({ where: { paypalOrderId: unknown, invoiceId: null } });
    assert.deepEqual(await prisma.invoice.findMany({ where: { id: { in: created.invoiceIds } }, orderBy: { id: "asc" }, select: { id: true, status: true, updatedAt: true } }), before);
  });
});
