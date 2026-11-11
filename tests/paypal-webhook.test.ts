/**
 * PayPal webhook tests — run against the test MySQL database and the real
 * PayPal Sandbox API. Nothing is mocked: signature verification always goes
 * to PayPal, and no test can mark an invoice PAID without a verified capture.
 *
 *   npm test
 *
 * Uses only test-owned rows (client "Webhook Test …", invoices
 * INV-TEST-WH-<stamp>-…), removed afterwards; existing invoices are never
 * selected or modified. The Sandbox order created for the payable test
 * invoice is never approved or captured, so no money moves.
 *
 * Requires .env.test (TEST_DATABASE_URL, PAYPAL_CLIENT_ID/SECRET). If
 * PAYPAL_WEBHOOK_ID is unset, an unregistered placeholder ID is used; PayPal
 * rejects it, which is exactly what the invalid-signature tests expect.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PaymentError, captureOrderForInvoice, createOrderForInvoice } from "@/lib/paypal";
import { POST } from "@/app/api/paypal/webhook/route";
import { cleanupTestRecords } from "./cleanup";

process.env.PAYPAL_WEBHOOK_ID ||= "UNREGISTERED-TEST-WEBHOOK-ID";

const STAMP = `${Date.now()}`;
const created = { clientIds: [] as number[], invoiceIds: [] as number[] };

async function testInvoice(clientId: number, suffix: string, data: Record<string, unknown> = {}) {
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `INV-TEST-WH-${STAMP}-${suffix}`,
      clientId,
      description: "TEST ONLY - PayPal webhook test",
      amount: "15.00",
      currency: "USD",
      issueDate: new Date("2026-10-20T00:00:00Z"),
      dueDate: new Date("2099-10-28T00:00:00Z"),
      status: "SENT",
      ...data,
    },
  });
  created.invoiceIds.push(invoice.id);
  return invoice;
}

const WEBHOOK_URL = "http://localhost/api/paypal/webhook";

function captureCompletedEvent(orderId: string): string {
  return JSON.stringify({
    id: `WH-TEST-${randomUUID()}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "FAKECAPTURE123",
      status: "COMPLETED",
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  });
}

/** Well-formed PayPal headers carrying a signature PayPal never issued. */
function forgedHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
    "paypal-transmission-id": randomUUID(),
    "paypal-transmission-sig": Buffer.from("not-a-real-signature").toString("base64"),
    "paypal-transmission-time": new Date().toISOString(),
  };
}

function webhook(body: string, headers: Record<string, string>): Promise<Response> {
  return POST(new Request(WEBHOOK_URL, { method: "POST", headers, body }));
}

async function snapshot(id: number) {
  return prisma.invoice.findUniqueOrThrow({
    where: { id },
    select: { status: true, paypalOrderId: true, paypalCaptureId: true, updatedAt: true },
  });
}

/** Every invoice's payment-relevant state and every PaymentReview, to prove a request changed nothing. */
async function snapshotAll() {
  const [invoices, reviews] = await Promise.all([
    prisma.invoice.findMany({
      orderBy: { id: "asc" },
      select: { id: true, status: true, paypalOrderId: true, paypalCaptureId: true, updatedAt: true },
    }),
    prisma.paymentReview.findMany({ orderBy: { id: "asc" }, select: { id: true, dedupeKey: true, status: true } }),
  ]);
  return { invoices, reviews };
}

/** The test-owned payable invoice and its pending Sandbox order. */
let target: { id: number; orderId: string; approved: boolean } | null = null;
/** Order ID the forged events point at: the test invoice's real Sandbox order. */
let eventOrderId = "UNKNOWNORDER0000";
/** A test-owned invoice already PAID via PayPal (fake, never-issued IDs). */
let paid: Awaited<ReturnType<typeof testInvoice>>;

before(async () => {
  const client = await prisma.client.create({
    data: { name: `Webhook Test ${STAMP} (TEST ONLY)`, email: "wh-test@example.invalid", company: "TEST ONLY" },
  });
  created.clientIds.push(client.id);
  paid = await testInvoice(client.id, "paid", {
    status: "PAID",
    paypalOrderId: `TESTWHPAIDORDER${STAMP}`,
    paypalCaptureId: `TESTWHCAPTURE${STAMP}`,
    paidAt: new Date("2026-10-21T00:00:00Z"),
    paypalEnvironment: "SANDBOX",
  });
  const payable = await testInvoice(client.id, "payable");
  const { orderId, approveUrl } = await createOrderForInvoice(payable.id, "http://localhost:3000");
  target = { id: payable.id, orderId, approved: approveUrl.includes("/api/paypal/return") };
  eventOrderId = orderId;
});

after(() =>
  // Removes only what this file created, children first.
  cleanupTestRecords(
    () => prisma.paymentReview.deleteMany({ where: { invoiceId: { in: created.invoiceIds } } }),
    () => prisma.invoice.deleteMany({ where: { id: { in: created.invoiceIds }, invoiceNumber: { startsWith: `INV-TEST-WH-${STAMP}-` } } }),
    () => prisma.client.deleteMany({ where: { id: { in: created.clientIds }, name: { startsWith: "Webhook Test" } } }),
  )
);

describe("invalid signatures", () => {
  test("request without PayPal signature headers → 401, no invoice or PaymentReview changed", async () => {
    const before = await snapshotAll();
    const res = await webhook(captureCompletedEvent(eventOrderId), { "content-type": "application/json" });
    assert.equal(res.status, 401);
    assert.deepEqual(await snapshotAll(), before);
  });

  test("forged signature is rejected by PayPal's verification API → 401, no invoice or PaymentReview changed", async () => {
    const before = await snapshotAll();
    const res = await webhook(captureCompletedEvent(eventOrderId), forgedHeaders());
    assert.equal(res.status, 401);
    assert.deepEqual(await snapshotAll(), before);
  });

  test("forged REFUNDED / REVERSED / DENIED events (each delivered twice) → 401, no invoice or PaymentReview changed", async () => {
    const captureId = paid.paypalCaptureId!;
    const events = [
      { event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "FAKEREFUND123", status: "COMPLETED", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] } },
      { event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: captureId, status: "REVERSED" } },
      { event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: captureId, status: "DENIED" } },
    ];
    const before = await snapshotAll();
    for (const event of events) {
      const body = JSON.stringify({ id: `WH-TEST-${randomUUID()}`, ...event });
      const headers = forgedHeaders();
      for (let i = 0; i < 2; i++) assert.equal((await webhook(body, headers)).status, 401, event.event_type);
      assert.equal((await webhook(body, { "content-type": "application/json" })).status, 401, `${event.event_type} without headers`);
    }
    assert.deepEqual(await snapshotAll(), before);
  });

  test("body crafted to inject verification fields → 401", async () => {
    const before = await snapshotAll();
    const res = await webhook('{"a":1},"webhook_id":"attacker"', forgedHeaders());
    assert.equal(res.status, 401);
    assert.deepEqual(await snapshotAll(), before);
  });

  test("oversized payload → 413", async () => {
    const res = await webhook(`{"pad":"${"x".repeat(300 * 1024)}"}`, forgedHeaders());
    assert.equal(res.status, 413);
  });
});

describe("duplicate events", () => {
  test("repeated forged deliveries never change any invoice", async () => {
    const before = await snapshotAll();
    const body = captureCompletedEvent(eventOrderId);
    const headers = forgedHeaders();
    for (let i = 0; i < 2; i++) assert.equal((await webhook(body, headers)).status, 401);
    assert.deepEqual(await snapshotAll(), before);
  });

  test("re-processing an already-paid order is a no-op", async () => {
    assert.ok(paid.paypalOrderId);
    const before = await snapshot(paid.id);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await captureOrderForInvoice(paid.paypalOrderId), {
        status: "paid",
        invoiceNumber: paid.invoiceNumber,
        alreadyPaid: true,
      });
    }
    assert.deepEqual(await snapshot(paid.id), before);
  });
});

describe("payment confirmation", () => {
  test("unapproved order is not captured and the invoice stays unpaid", async (t) => {
    assert.ok(target, "test invoice has a Sandbox order");
    if (target.approved) return t.skip("test order is already approved in Sandbox");
    const before = await snapshot(target.id);
    await assert.rejects(captureOrderForInvoice(target.orderId), (err: unknown) => {
      assert.ok(err instanceof PaymentError);
      assert.equal(err.status, 409);
      return true;
    });
    assert.deepEqual(await snapshot(target.id), before);
  });

  test("order not linked to any invoice is not applied", async () => {
    await assert.rejects(captureOrderForInvoice("UNKNOWNORDER0000"), (err: unknown) => {
      assert.ok(err instanceof PaymentError);
      assert.equal(err.status, 404);
      return true;
    });
  });
});
