/**
 * Public payment link tests (/pay/<token>, /api/pay/<token>[/order]).
 *
 * Runs against the real MySQL database with test-owned rows only (prefixed
 * INV-TEST-PAY-<stamp>, removed afterwards). Tests that create PayPal orders
 * use the Sandbox API and are skipped without PayPal credentials; orders are
 * never approved or captured, so no money moves and no email is sent.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { Client, Environment, OrdersController } from "@paypal/paypal-server-sdk";
import { prisma } from "@/lib/prisma";
import { generatePaymentToken, getPublicInvoice, isWellFormedPaymentToken } from "@/lib/payment-link";
import { PaymentHoldError, captureOrderForInvoice } from "@/lib/paypal";
import type { PaymentReviewInput } from "@/lib/payment-risk";
import { proxy } from "@/proxy";
import { GET as getPublic } from "@/app/api/pay/[token]/route";
import { POST as createPublicOrder } from "@/app/api/pay/[token]/order/route";
import { POST as createPaymentLink } from "@/app/api/invoices/[id]/payment-link/route";
import { GET as paypalReturn } from "@/app/api/paypal/return/route";
import { GET as paypalCancel } from "@/app/api/paypal/cancel/route";
import { ownerCookie } from "./auth-helpers";
import { cleanupTestRecords } from "./cleanup";

const BASE = "http://localhost:3000";
const STAMP = `${Date.now()}`;
const PAYPAL_CONFIGURED = !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
const created = { clientIds: [] as number[], invoiceIds: [] as number[] };
let cookie = "";

const tokenCtx = (token: string) => ({ params: Promise.resolve({ token }) }) as never;
const idCtx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) }) as never;

const viewInvoice = (token: string) => getPublic(new Request(`${BASE}/api/pay/${token}`), tokenCtx(token));
const startPayment = (token: string, body?: unknown) =>
  createPublicOrder(
    new Request(`${BASE}/api/pay/${token}/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    tokenCtx(token)
  );

async function testClient(label: string) {
  const client = await prisma.client.create({
    data: { name: `Pay Link Test ${label} ${STAMP} (TEST ONLY)`, email: `pay-${label}@example.invalid`, company: "TEST ONLY" },
  });
  created.clientIds.push(client.id);
  return client;
}

async function testInvoice(clientId: number, suffix: string, data: Record<string, unknown> = {}) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-TEST-PAY-${STAMP}-${suffix}`,
      clientId,
      description: "TEST ONLY - payment link test",
      amount: "12.34",
      currency: "USD",
      issueDate: new Date("2026-10-20T00:00:00Z"),
      dueDate: new Date("2099-10-28T00:00:00Z"),
      status: "SENT",
      paymentToken: generatePaymentToken(),
      ...data,
    },
  });
  created.invoiceIds.push(invoice.id);
  return invoice as typeof invoice & { paymentToken: string };
}

let clientA: Awaited<ReturnType<typeof testClient>>;
let clientB: Awaited<ReturnType<typeof testClient>>;

before(async () => {
  cookie = await ownerCookie();
  clientA = await testClient("A");
  clientB = await testClient("B");
});

after(() =>
  // Removes only what this file created.
  cleanupTestRecords(
    () => prisma.paymentReview.deleteMany({ where: { invoiceId: { in: created.invoiceIds } } }),
    () => prisma.invoice.deleteMany({ where: { id: { in: created.invoiceIds }, invoiceNumber: { startsWith: `INV-TEST-PAY-${STAMP}-` } } }),
    () => prisma.client.deleteMany({ where: { id: { in: created.clientIds }, name: { startsWith: "Pay Link Test" } } }),
  )
);

describe("invalid tokens", () => {
  test("tokens are 256-bit and well-formed; malformed ones are rejected without a lookup", () => {
    const token = generatePaymentToken();
    assert.ok(isWellFormedPaymentToken(token));
    assert.notEqual(token, generatePaymentToken());
    for (const bad of ["", "1", "abc", `${token}x`, token.slice(1), `${token.slice(0, 42)}/`, "' OR 1=1 --", null, 42]) {
      assert.equal(isWellFormedPaymentToken(bad), false, String(bad));
    }
  });

  test("malformed, unknown, DRAFT, and CANCELLED tokens all get the same 404 and reveal nothing", async () => {
    const draft = await testInvoice(clientA.id, "draft", { status: "DRAFT" });
    const cancelled = await testInvoice(clientA.id, "cancelled", { status: "CANCELLED" });
    const bodies = new Set<string>();
    for (const token of ["not-a-token", generatePaymentToken(), draft.paymentToken, cancelled.paymentToken]) {
      const res = await viewInvoice(token);
      assert.equal(res.status, 404, token);
      const text = await res.text();
      assert.doesNotMatch(text, /INV-TEST|TEST ONLY|example\.invalid/);
      bodies.add(text);
      assert.equal((await startPayment(token)).status, 404, token);
    }
    assert.equal(bodies.size, 1, "every invalid link looks the same");
    const after = await prisma.invoice.findMany({ where: { id: { in: [draft.id, cancelled.id] } }, select: { paypalOrderId: true } });
    assert.ok(after.every((i) => i.paypalOrderId === null), "no order is created for an invalid link");
  });
});

describe("privacy", () => {
  test("the public view exposes only invoice facts, never emails, IDs, tokens, or PayPal references", async () => {
    const invoice = await testInvoice(clientA.id, "privacy", { paypalOrderId: `TESTORDER${STAMP}` });
    const res = await viewInvoice(invoice.paymentToken);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    const { data } = JSON.parse(text) as { data: Record<string, unknown> };
    assert.deepEqual(Object.keys(data).sort(), [
      "amount", "clientCompany", "clientName", "currency", "description", "dueDate",
      "invoiceNumber", "issueDate", "lineItems", "overdue", "paidAt", "state",
    ]);
    assert.equal(data.invoiceNumber, invoice.invoiceNumber);
    assert.equal(data.amount, "12.34");
    for (const secret of ["pay-A@example.invalid", `TESTORDER${STAMP}`, invoice.paymentToken, `"id"`, `"clientId"`]) {
      assert.ok(!text.includes(secret), `response must not contain ${secret}`);
    }
  });

  test("one client's token never returns another client's invoice", async () => {
    const a = await testInvoice(clientA.id, "iso-a");
    const b = await testInvoice(clientB.id, "iso-b");
    const viewA = (await getPublicInvoice(a.paymentToken))!;
    const viewB = (await getPublicInvoice(b.paymentToken))!;
    assert.equal(viewA.invoiceNumber, a.invoiceNumber);
    assert.equal(viewB.invoiceNumber, b.invoiceNumber);
    assert.match(viewA.clientName, /Pay Link Test A/);
    assert.match(viewB.clientName, /Pay Link Test B/);
  });
});

describe("payment eligibility", () => {
  test("SENT and OVERDUE invoices are payable; PAID shows Paid", async () => {
    const sent = await testInvoice(clientA.id, "sent");
    const overdue = await testInvoice(clientA.id, "overdue", { status: "OVERDUE" });
    const paid = await testInvoice(clientA.id, "paid", {
      status: "PAID",
      paypalOrderId: `TESTPAIDORDER${STAMP}`,
      paypalCaptureId: `TESTPAIDCAPTURE${STAMP}`,
      paidAt: new Date("2026-10-21T00:00:00Z"),
    });
    assert.equal((await getPublicInvoice(sent.paymentToken))?.state, "payable");
    const overdueView = await getPublicInvoice(overdue.paymentToken);
    assert.equal(overdueView?.state, "payable");
    assert.equal(overdueView?.overdue, true);
    const paidView = await getPublicInvoice(paid.paymentToken);
    assert.equal(paidView?.state, "paid");
    assert.equal(paidView?.paidAt, "2026-10-21T00:00:00.000Z");
  });

  test("a PAID invoice cannot start another payment (409, no PayPal call, nothing changed)", async () => {
    const paid = await testInvoice(clientA.id, "paid-again", {
      status: "PAID",
      paypalOrderId: `TESTPAIDORDER2${STAMP}`,
      paypalCaptureId: `TESTPAIDCAPTURE2${STAMP}`,
    });
    const res = await startPayment(paid.paymentToken);
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /already paid/i);
    const now = await prisma.invoice.findUniqueOrThrow({ where: { id: paid.id } });
    assert.equal(now.paypalOrderId, paid.paypalOrderId);
    assert.equal(now.paypalCaptureId, paid.paypalCaptureId);
  });
});

describe("duplicate payments", () => {
  test("returning again for an already-paid order is a no-op that shows Paid", async () => {
    const orderId = `TESTPAIDORDER3${STAMP}`;
    const paid = await testInvoice(clientA.id, "paid-return", { status: "PAID", paypalOrderId: orderId, paypalCaptureId: `TESTCAP3${STAMP}` });
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: paid.id } });
    const res = await paypalReturn(new NextRequest(`${BASE}/api/paypal/return?token=${orderId}`));
    assert.equal(res.status, 303);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.pathname, `/pay/${paid.paymentToken}`);
    assert.equal(location.searchParams.get("payment"), "paid");
    assert.deepEqual(await prisma.invoice.findUniqueOrThrow({ where: { id: paid.id } }), before);
  });

  test("cancel returns to the invoice's own pay page without changing it", async () => {
    const orderId = `TESTCANCELORDER${STAMP}`;
    const invoice = await testInvoice(clientA.id, "cancel", { paypalOrderId: orderId });
    const res = await paypalCancel(new NextRequest(`${BASE}/api/paypal/cancel?token=${orderId}`));
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.pathname, `/pay/${invoice.paymentToken}`);
    assert.equal(location.searchParams.get("payment"), "cancelled");
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, "SENT");
  });

  test("concurrent Pay clicks never hand out two payable orders", { skip: !PAYPAL_CONFIGURED && "PayPal credentials not set" }, async () => {
    const invoice = await testInvoice(clientA.id, "concurrent");
    const responses = await Promise.all([startPayment(invoice.paymentToken), startPayment(invoice.paymentToken)]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ data?: { approveUrl: string }; error?: string }>));
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    assert.ok(stored.paypalOrderId);
    assert.equal(stored.status, "SENT", "creating an order never marks the invoice paid");

    assert.ok(responses.some((r) => r.status === 200));
    responses.forEach((res, i) => {
      if (res.status === 200) {
        assert.ok(bodies[i].data!.approveUrl.includes(stored.paypalOrderId!), "every approval URL is for the one stored order");
      } else {
        // The loser of the race gets no approval URL (PayPal does not dedupe in-flight requests).
        assert.equal(res.status, 409);
        assert.match(bodies[i].error ?? "", /retry/i);
        assert.equal(bodies[i].data, undefined);
      }
    });

    // A retry reuses the stored order instead of creating another.
    const retry = (await (await startPayment(invoice.paymentToken)).json()) as { data: { approveUrl: string } };
    assert.ok(retry.data.approveUrl.includes(stored.paypalOrderId!));
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).paypalOrderId, stored.paypalOrderId);
  });
});

describe("amount tampering", { skip: !PAYPAL_CONFIGURED && "PayPal credentials not set" }, () => {
  function sandboxOrders() {
    const client = new Client({
      clientCredentialsAuthCredentials: { oAuthClientId: process.env.PAYPAL_CLIENT_ID!, oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET! },
      environment: Environment.Sandbox,
    });
    return new OrdersController(client);
  }

  test("the order is priced from MySQL; a client-supplied amount/currency is ignored", async () => {
    const invoice = await testInvoice(clientA.id, "tamper");
    const res = await startPayment(invoice.paymentToken, { amount: "0.01", currency: "JPY", value: "0.01", invoiceId: 1 });
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    assert.deepEqual(Object.keys(data), ["approveUrl"]);
    const { paypalOrderId } = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const { result: order } = await sandboxOrders().getOrder({ id: paypalOrderId! });
    assert.deepEqual(order.purchaseUnits?.[0]?.amount && { value: order.purchaseUnits[0].amount.value, currency: order.purchaseUnits[0].amount.currencyCode }, { value: "12.34", currency: "USD" });
    assert.equal(order.purchaseUnits?.[0]?.referenceId, String(invoice.id));
  });

  test("an order no longer matching the stored amount is held for review before capture", async () => {
    const invoice = await testInvoice(clientA.id, "tamper-db");
    assert.equal((await startPayment(invoice.paymentToken)).status, 200);
    const { paypalOrderId } = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    // Simulate the stored amount changing after the order was priced.
    await prisma.invoice.update({ where: { id: invoice.id }, data: { amount: "99.99" } });
    const reviews: PaymentReviewInput[] = [];
    const store = { save: async (rows: PaymentReviewInput[]) => void reviews.push(...rows) };
    await assert.rejects(captureOrderForInvoice(paypalOrderId!, store), (err) => err instanceof PaymentHoldError && err.status === 409);
    assert.deepEqual(reviews.map((r) => [r.code, r.invoiceId]), [["ORDER_MISMATCH", invoice.id]]);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, "SENT");
  });

  const paymentState = (id: number) =>
    prisma.invoice.findUniqueOrThrow({
      where: { id },
      select: { status: true, amount: true, currency: true, lineItems: true, paypalOrderId: true, paypalCaptureId: true, paidAt: true, paypalEnvironment: true, updatedAt: true },
    });
  /** Captures with an in-memory review store; asserts a 409 hold and an unchanged invoice. */
  async function expectHeld(orderId: string, invoiceId: number) {
    const before = await paymentState(invoiceId);
    const reviews: PaymentReviewInput[] = [];
    await assert.rejects(captureOrderForInvoice(orderId, { save: async (rows) => void reviews.push(...rows) }), (err) => err instanceof PaymentHoldError && err.status === 409);
    const after = await paymentState(invoiceId);
    assert.deepEqual(after, before, "invoice unchanged");
    assert.equal(after.status, "SENT");
    assert.equal(after.paypalCaptureId, null);
    return reviews;
  }

  test("invoice currency changed after the order was priced → held as ORDER_MISMATCH", async () => {
    const invoice = await testInvoice(clientA.id, "tamper-cur");
    assert.equal((await startPayment(invoice.paymentToken)).status, 200);
    const { paypalOrderId } = await prisma.invoice.update({ where: { id: invoice.id }, data: { currency: "EUR" } });
    const reviews = await expectHeld(paypalOrderId!, invoice.id);
    assert.deepEqual(reviews.map((r) => [r.code, r.invoiceId, r.paypalOrderId]), [["ORDER_MISMATCH", invoice.id, paypalOrderId]]);
    assert.match(reviews[0].reason, /order: USD 12\.34, invoice: EUR 12\.34/);
    assert.deepEqual([reviews[0].expected, reviews[0].observed], ["EUR 12.34", "USD 12.34"]);
  });

  test("PayPal order created for a different invoice → held as ORDER_MISMATCH", async () => {
    const victim = await testInvoice(clientA.id, "tamper-ord-a");
    const other = await testInvoice(clientA.id, "tamper-ord-b");
    assert.equal((await startPayment(other.paymentToken)).status, 200);
    // Re-point the order (same amount and currency) at another invoice.
    const { paypalOrderId } = await prisma.invoice.findUniqueOrThrow({ where: { id: other.id } });
    await prisma.invoice.update({ where: { id: other.id }, data: { paypalOrderId: null } });
    await prisma.invoice.update({ where: { id: victim.id }, data: { paypalOrderId } });
    const reviews = await expectHeld(paypalOrderId!, victim.id);
    assert.deepEqual(reviews.map((r) => [r.code, r.invoiceId]), [["ORDER_MISMATCH", victim.id]]);
    assert.match(reviews[0].reason, new RegExp(`PayPal order for ${victim.invoiceNumber} does not match the invoice's reference`));
    assert.equal((await paymentState(other.id)).status, "SENT");
  });

  test("stored line items no longer add up to the amount → held as LINE_ITEMS_TOTAL_MISMATCH before capture", async () => {
    const invoice = await testInvoice(clientA.id, "tamper-lines");
    assert.equal((await startPayment(invoice.paymentToken)).status, 200);
    const { paypalOrderId } = await prisma.invoice.update({ where: { id: invoice.id }, data: { lineItems: [{ description: "Work", quantity: 1, rate: 10 }] } });
    const reviews = await expectHeld(paypalOrderId!, invoice.id);
    assert.deepEqual(reviews.map((r) => [r.code, r.invoiceId]), [["LINE_ITEMS_TOTAL_MISMATCH", invoice.id]]);
    assert.match(reviews[0].reason, /line items add up to USD 10\.00, but its amount is USD 12\.34/);
    assert.deepEqual([reviews[0].expected, reviews[0].observed], ["USD 10.00", "USD 12.34"]);
  });
});

describe("authorization", () => {
  const passesThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";
  const anon = (path: string, method = "GET") => new NextRequest(`${BASE}${path}`, { method });

  test("the public page and its API need no session; nothing else under them is public", async () => {
    const token = generatePaymentToken();
    assert.ok(passesThrough(await proxy(anon(`/pay/${token}`))));
    assert.ok(passesThrough(await proxy(anon(`/api/pay/${token}`))));
    assert.ok(passesThrough(await proxy(anon(`/api/pay/${token}/order`, "POST"))));
    assert.equal((await proxy(anon(`/api/pay/${token}/other`))).status, 401);
    assert.equal((await proxy(anon(`/pay/${token}/extra`))).status, 307);
    assert.equal((await proxy(anon("/invoices"))).status, 307);
    assert.equal((await proxy(anon("/api/invoices"))).status, 401);
  });

  test("only the owner can get a payment link, and only for issued invoices", async () => {
    const sent = await testInvoice(clientA.id, "link-sent", { paymentToken: null });
    const draft = await testInvoice(clientA.id, "link-draft", { status: "DRAFT", paymentToken: null });
    const post = (id: number, c?: string) =>
      createPaymentLink(new Request(`${BASE}/api/invoices/${id}/payment-link`, { method: "POST", headers: c ? { cookie: c } : {} }), idCtx(id));

    assert.equal((await post(sent.id)).status, 401);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: sent.id } })).paymentToken, null, "no token for anonymous callers");

    const res = await post(sent.id, cookie);
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as { data: { url: string } };
    const { paymentToken } = await prisma.invoice.findUniqueOrThrow({ where: { id: sent.id } });
    assert.ok(isWellFormedPaymentToken(paymentToken));
    const origin = process.env.APP_URL?.trim() ? new URL(process.env.APP_URL).origin : BASE;
    assert.equal(data.url, `${origin}/pay/${paymentToken}`);
    // Stable: asking again returns the same link.
    assert.equal(((await (await post(sent.id, cookie)).json()) as { data: { url: string } }).data.url, data.url);

    assert.equal((await post(draft.id, cookie)).status, 409);
  });
});
