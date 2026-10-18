/**
 * PayPal webhook tests — run against the real MySQL database and the real
 * PayPal Sandbox API. Nothing is mocked: signature verification always goes
 * to PayPal, and no test can mark an invoice PAID without a verified capture.
 *
 *   npm test
 *
 * Requires .env (DATABASE_URL, PAYPAL_CLIENT_ID/SECRET). If PAYPAL_WEBHOOK_ID
 * is unset, an unregistered placeholder ID is used; PayPal rejects it, which
 * is exactly what the invalid-signature tests expect.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { PaymentError, captureOrderForInvoice, createOrderForInvoice } from "@/lib/paypal";
import { POST } from "@/app/api/paypal/webhook/route";

process.env.PAYPAL_WEBHOOK_ID ||= "UNREGISTERED-TEST-WEBHOOK-ID";

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

/** Every invoice's payment-relevant state, to prove a request changed nothing. */
async function snapshotAll() {
  return prisma.invoice.findMany({
    orderBy: { id: "asc" },
    select: { id: true, status: true, paypalOrderId: true, paypalCaptureId: true, updatedAt: true },
  });
}

/** A payable invoice with a pending Sandbox order (existing order is reused). */
let target: { id: number; orderId: string; approved: boolean } | null = null;
/** Order ID the forged events point at: a real one when available. */
let eventOrderId = "UNKNOWNORDER0000";

before(async () => {
  const invoice = await prisma.invoice.findFirst({ where: { status: { in: ["SENT", "OVERDUE"] } } });
  if (invoice) {
    const { orderId, approveUrl } = await createOrderForInvoice(invoice.id, "http://localhost:3000");
    target = { id: invoice.id, orderId, approved: approveUrl.includes("/api/paypal/return") };
    eventOrderId = orderId;
  } else {
    const any = await prisma.invoice.findFirst({ where: { paypalOrderId: { not: null } } });
    if (any?.paypalOrderId) eventOrderId = any.paypalOrderId;
  }
});

after(() => prisma.$disconnect());

describe("invalid signatures", () => {
  test("request without PayPal signature headers → 401, no invoice changed", async () => {
    const before = await snapshotAll();
    const res = await webhook(captureCompletedEvent(eventOrderId), { "content-type": "application/json" });
    assert.equal(res.status, 401);
    assert.deepEqual(await snapshotAll(), before);
  });

  test("forged signature is rejected by PayPal's verification API → 401, no invoice changed", async () => {
    const before = await snapshotAll();
    const res = await webhook(captureCompletedEvent(eventOrderId), forgedHeaders());
    assert.equal(res.status, 401);
    assert.deepEqual(await snapshotAll(), before);
  });

  test("body crafted to inject verification fields → 401", async () => {
    const res = await webhook('{"a":1},"webhook_id":"attacker"', forgedHeaders());
    assert.equal(res.status, 401);
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

  test("re-processing an already-paid order is a no-op", async (t) => {
    const paid = await prisma.invoice.findFirst({
      where: { status: "PAID", paypalOrderId: { not: null }, paypalCaptureId: { not: null } },
    });
    if (!paid?.paypalOrderId) return t.skip("no invoice paid via PayPal yet");
    const before = await snapshot(paid.id);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await captureOrderForInvoice(paid.paypalOrderId), {
        status: "paid",
        invoiceNumber: paid.invoiceNumber,
      });
    }
    assert.deepEqual(await snapshot(paid.id), before);
  });
});

describe("payment confirmation", () => {
  test("unapproved order is not captured and the invoice stays unpaid", async (t) => {
    if (!target) return t.skip("no SENT/OVERDUE invoice to test with");
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
