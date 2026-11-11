/**
 * Payment-risk rules, review records, verified-webhook handling, and the
 * owner-only demo. No PayPal calls and no database writes: the webhook
 * handler gets in-memory dependencies, and the demo/route tests only read.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "@paypal/paypal-server-sdk";
import { prisma } from "@/lib/prisma";
import { PaymentError, PaymentHoldError, holdPayment, type CaptureOutcome } from "@/lib/paypal";
import {
  checkCapture,
  checkInvoiceTotals,
  isDedupeKeyConflict,
  reviewRows,
  saveReviewRows,
  unknownOrderFlag,
  type InvoiceFacts,
  type PaymentReviewInput,
  type ReviewStore,
} from "@/lib/payment-risk";
import { handleVerifiedEvent, type WebhookDeps, type WebhookEvent } from "@/lib/paypal-webhook";
import { runPaymentDemo } from "@/lib/payment-demo";
import { POST as demoRoute } from "@/app/api/payment-reviews/demo/route";
import { GET as reviewsRoute } from "@/app/api/payment-reviews/route";
import { NextRequest } from "next/server";
import { ownerCookie } from "./auth-helpers";

const invoice = (overrides: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  id: 1,
  invoiceNumber: "INV-2026-001",
  amount: "250.00",
  currency: "USD",
  status: "SENT",
  lineItems: [{ description: "Work", quantity: 2, rate: 125 }],
  paypalCaptureId: null,
  ...overrides,
});
const usd = (value: string) => ({ currencyCode: "USD", value });
const codes = (flags: { code: string }[]) => flags.map((f) => f.code).sort();

/** Same semantics as prismaReviewStore: rows with an existing dedupeKey are skipped. */
class MemoryReviewStore implements ReviewStore {
  rows: PaymentReviewInput[] = [];
  constructor(private fail = false) {}
  async save(rows: PaymentReviewInput[]) {
    if (this.fail) throw new Error("database unavailable");
    for (const row of rows) if (!this.rows.some((r) => r.dedupeKey === row.dedupeKey)) this.rows.push(row);
  }
}

describe("checkCapture", () => {
  test("a matching capture passes every rule", () => {
    assert.deepEqual(checkCapture(invoice(), { id: "CAP1", amount: usd("250.00") }, { captureInvoiceId: null }), []);
    assert.deepEqual(checkCapture(invoice(), { id: "CAP1", amount: usd("250") }, { captureInvoiceId: 1 }), []);
  });

  test("wrong amount or currency is flagged with reason and recommended action", () => {
    const [flag] = checkCapture(invoice(), { id: "CAP1", amount: usd("25.00") }, { captureInvoiceId: null });
    assert.equal(flag.code, "AMOUNT_MISMATCH");
    assert.match(flag.reason, /USD 25\.00.*USD 250\.00/);
    assert.ok(flag.recommendedAction.length > 0);
    assert.deepEqual(codes(checkCapture(invoice(), { id: "CAP1", amount: { currencyCode: "EUR", value: "250.00" } }, { captureInvoiceId: null })), ["CURRENCY_MISMATCH"]);
    assert.deepEqual(codes(checkCapture(invoice(), { id: "CAP1", amount: usd("abc") }, { captureInvoiceId: null })), ["AMOUNT_MISMATCH"]);
    assert.deepEqual(codes(checkCapture(invoice(), { id: "CAP1" }, { captureInvoiceId: null })), ["CURRENCY_MISMATCH"]);
  });

  test("a capture already recorded on another invoice is a duplicate", () => {
    assert.deepEqual(codes(checkCapture(invoice(), { id: "CAP1", amount: usd("250.00") }, { captureInvoiceId: 7 })), ["DUPLICATE_CAPTURE"]);
  });

  test("a second capture for a paid invoice, or any capture for a non-payable one, is flagged", () => {
    const paid = invoice({ status: "PAID", paypalCaptureId: "CAP1" });
    assert.deepEqual(codes(checkCapture(paid, { id: "CAP2", amount: usd("250.00") }, { captureInvoiceId: null })), ["ALREADY_PAID_OTHER_CAPTURE"]);
    for (const status of ["DRAFT", "CANCELLED"]) {
      assert.deepEqual(codes(checkCapture(invoice({ status }), { id: "CAP1", amount: usd("250.00") }, { captureInvoiceId: null })), ["INVOICE_NOT_PAYABLE"]);
    }
  });
});

describe("checkInvoiceTotals", () => {
  test("line items must add up to the stored amount", () => {
    assert.deepEqual(checkInvoiceTotals(invoice()), []);
    assert.deepEqual(checkInvoiceTotals(invoice({ lineItems: null })), []);
    assert.deepEqual(codes(checkInvoiceTotals(invoice({ amount: "260.00" }))), ["LINE_ITEMS_TOTAL_MISMATCH"]);
    assert.deepEqual(codes(checkInvoiceTotals(invoice({ lineItems: [{ quantity: -1 }] }))), ["LINE_ITEMS_INVALID"]);
  });

  test("a tampered amount also fails at capture time", () => {
    assert.deepEqual(codes(checkCapture(invoice({ amount: "1.00" }), { id: "CAP1", amount: usd("1.00") }, { captureInvoiceId: null })), ["LINE_ITEMS_TOTAL_MISMATCH"]);
  });
});

describe("capture tampering → hold", () => {
  // Capture-level checks run on a completed PayPal capture, which Sandbox can't
  // produce without a buyer; this drives the same checkCapture → holdPayment path.
  const scenarios = [
    { name: "amount differs", capture: { id: "CAP1", amount: usd("25.00") }, holder: null, code: "AMOUNT_MISMATCH", reason: /Capture CAP1 is for USD 25\.00, but INV-2026-001 is for USD 250\.00/, observed: "USD 25.00" },
    { name: "currency differs", capture: { id: "CAP1", amount: { currencyCode: "EUR", value: "250.00" } }, holder: null, code: "CURRENCY_MISMATCH", reason: /made in EUR, but INV-2026-001 is billed in USD/, observed: "EUR 250.00" },
    { name: "capture used by another invoice", capture: { id: "CAP1", amount: usd("250.00") }, holder: 7, code: "DUPLICATE_CAPTURE", reason: /Capture CAP1 is already recorded as payment for another invoice \(id 7\)/, observed: null },
    { name: "line items differ from amount", capture: { id: "CAP1", amount: usd("260.00") }, holder: null, facts: { amount: "260.00" }, code: "LINE_ITEMS_TOTAL_MISMATCH", reason: /line items add up to USD 250\.00, but its amount is USD 260\.00/, observed: "USD 260.00" },
  ] as const;

  for (const s of scenarios) {
    test(`${s.name}: held (409), one ${s.code} review with the right reason, invoice untouched, webhook acks "held"`, async () => {
      const facts = invoice("facts" in s ? s.facts : {});
      const original = structuredClone(facts);
      const store = new MemoryReviewStore();
      const ctx = { invoiceId: facts.id, invoiceNumber: facts.invoiceNumber, orderId: "ORDER1", captureId: s.capture.id };
      const flags = checkCapture(facts, s.capture, { captureInvoiceId: s.holder });
      assert.deepEqual(codes(flags), [s.code]);
      await assert.rejects(holdPayment(flags, ctx, store), (err: unknown) => err instanceof PaymentHoldError && err.status === 409);

      assert.equal(store.rows.length, 1);
      const [row] = store.rows;
      assert.equal(row.code, s.code);
      assert.match(row.reason, s.reason);
      assert.ok(row.recommendedAction.length > 0);
      assert.equal(row.observed, s.observed);
      assert.deepEqual([row.invoiceId, row.paypalOrderId, row.paypalCaptureId], [1, "ORDER1", "CAP1"]);
      assert.deepEqual(facts, original, "rules never mutate the invoice");
      assert.equal(facts.status, "SENT");

      const deps: WebhookDeps = { capture: () => holdPayment(flags, ctx, store), findInvoice: async () => null, reviews: store };
      const event: WebhookEvent = { id: "WH-T", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { supplementary_data: { related_ids: { order_id: "ORDER1" } } } };
      const res = await handleVerifiedEvent(event, deps);
      assert.deepEqual({ status: res.status, result: (await res.json()).result }, { status: 200, result: "held" });
      assert.equal(store.rows.length, 1, "redelivery reuses the same review row");
    });
  }
});

describe("review records", () => {
  test("redelivery of the same problem maps to the same row; reversals are per event", () => {
    const flag = unknownOrderFlag("ORDER1");
    const a = reviewRows([flag], { orderId: "ORDER1", eventId: "WH-1" });
    const b = reviewRows([flag], { orderId: "ORDER1", eventId: "WH-2" });
    assert.equal(a[0].dedupeKey, b[0].dedupeKey);
    const reversal = { code: "REVERSAL_EVENT" as const, reason: "r", recommendedAction: "a" };
    assert.notEqual(
      reviewRows([reversal], { captureId: "CAP1", eventId: "WH-1" })[0].dedupeKey,
      reviewRows([reversal], { captureId: "CAP1", eventId: "WH-2" })[0].dedupeKey
    );
  });

  test("holdPayment stores the review before throwing PaymentHoldError", async () => {
    const store = new MemoryReviewStore();
    await assert.rejects(holdPayment([unknownOrderFlag("O1")], { orderId: "O1" }, store), (err: unknown) => {
      assert.ok(err instanceof PaymentHoldError);
      assert.equal(err.status, 409);
      return true;
    });
    assert.equal(store.rows.length, 1);
  });

  test("if the review cannot be stored, the error is transient (503), not a hold", async () => {
    await assert.rejects(holdPayment([unknownOrderFlag("O1")], { orderId: "O1" }, new MemoryReviewStore(true)), (err: unknown) => {
      assert.ok(err instanceof PaymentError && !(err instanceof PaymentHoldError));
      assert.equal(err.status, 503);
      return true;
    });
  });
});

describe("saveReviewRows (prismaReviewStore write path)", () => {
  const p2002 = (target: unknown) => Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });
  /** Behaves like INSERT into PaymentReview with its unique dedupeKey index. */
  function fakeTable(fail?: () => Error) {
    const rows: PaymentReviewInput[] = [];
    const create = async (row: PaymentReviewInput) => {
      if (fail) throw fail();
      if (rows.some((r) => r.dedupeKey === row.dedupeKey)) throw p2002("PaymentReview_dedupeKey_key");
      rows.push(row);
    };
    return { rows, store: { save: (r: PaymentReviewInput[]) => saveReviewRows(r, create) } satisfies ReviewStore };
  }
  const rowsFor = (eventId: string) => reviewRows([unknownOrderFlag("ORPHAN1")], { orderId: "ORPHAN1", eventId });

  test("only a dedupeKey unique conflict counts as a duplicate", () => {
    assert.equal(isDedupeKeyConflict(p2002("PaymentReview_dedupeKey_key")), true);
    assert.equal(isDedupeKeyConflict(p2002(["dedupeKey"])), true);
    assert.equal(isDedupeKeyConflict(p2002("PRIMARY")), false);
    assert.equal(isDedupeKeyConflict(p2002(undefined)), false);
    assert.equal(isDedupeKeyConflict(Object.assign(new Error("FK"), { code: "P2003", meta: { target: "dedupeKey" } })), false);
    assert.equal(isDedupeKeyConflict(new Error("dedupeKey")), false);
  });

  test("duplicate and concurrent deliveries store one row without error", async () => {
    const { rows, store } = fakeTable();
    await store.save(rowsFor("WH-1"));
    await store.save(rowsFor("WH-2")); // redelivery
    await Promise.all([store.save(rowsFor("WH-3")), store.save(rowsFor("WH-4"))]);
    assert.equal(rows.length, 1);
  });

  test("a partial earlier write is completed on retry", async () => {
    const { rows, store } = fakeTable();
    const two = [...rowsFor("WH-1"), ...reviewRows([unknownOrderFlag("ORPHAN2")], { orderId: "ORPHAN2" })];
    await store.save(two.slice(0, 1));
    await store.save(two);
    assert.equal(rows.length, 2);
  });

  test("genuine database errors propagate, including other unique conflicts", async () => {
    for (const fail of [() => new Error("Can't reach database server"), () => p2002("PRIMARY"), () => Object.assign(new Error("table missing"), { code: "P2021" })]) {
      await assert.rejects(fakeTable(fail).store.save(rowsFor("WH-1")));
    }
  });

  test("a genuine write failure makes the webhook return 503 and holdPayment a transient error", async () => {
    const { store } = fakeTable(() => new Error("Can't reach database server"));
    const event: WebhookEvent = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { supplementary_data: { related_ids: { order_id: "ORPHAN1" } } } };
    const deps: WebhookDeps = { capture: async () => { throw new PaymentError("No invoice", 404); }, findInvoice: async () => null, reviews: store };
    assert.equal((await handleVerifiedEvent(event, deps)).status, 503);
    await assert.rejects(holdPayment([unknownOrderFlag("O1")], { orderId: "O1" }, store), (err: unknown) => err instanceof PaymentError && !(err instanceof PaymentHoldError) && err.status === 503);
  });

  test("a duplicate delivery through the webhook is acknowledged, not retried", async () => {
    const { rows, store } = fakeTable();
    const deps: WebhookDeps = { capture: async () => { throw new PaymentError("No invoice", 404); }, findInvoice: async () => null, reviews: store };
    for (const id of ["WH-1", "WH-1", "WH-2"]) {
      const event: WebhookEvent = { id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { supplementary_data: { related_ids: { order_id: "ORPHAN1" } } } };
      const res = await handleVerifiedEvent(event, deps);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).result, "flagged");
    }
    assert.equal(rows.length, 1);
  });
});

describe("verified webhook handling", () => {
  const completed = (orderId: string, id = "WH-1"): WebhookEvent => ({
    id,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "CAP1", status: "COMPLETED", supplementary_data: { related_ids: { order_id: orderId } } },
  });
  function deps(capture: (orderId: string) => Promise<CaptureOutcome>, reviews = new MemoryReviewStore()): WebhookDeps & { reviews: MemoryReviewStore } {
    return { capture, reviews, findInvoice: async ({ captureId }) => (captureId === "CAP1" ? { id: 5, invoiceNumber: "INV-2026-005" } : null) };
  }
  const result = async (res: Response) => ({ status: res.status, result: (await res.json()).result });

  test("verified payment → paid; duplicate delivery → 200 already_processed, logged as no-op, no review", async (t) => {
    let calls = 0;
    const d = deps(async () => ({ status: "paid", invoiceNumber: "INV-2026-005", ...(calls++ > 0 && { alreadyPaid: true }) }));
    const info = t.mock.method(console, "info", () => {});
    assert.deepEqual(await result(await handleVerifiedEvent(completed("ORDER1"), d)), { status: 200, result: "paid" });
    assert.deepEqual(await result(await handleVerifiedEvent(completed("ORDER1"), d)), { status: 200, result: "already_processed" });
    const [first, second] = info.mock.calls.map((c) => String(c.arguments[0]));
    assert.match(first, /invoice INV-2026-005 paid$/);
    assert.match(second, /already paid; duplicate delivery, no change$/);
    assert.doesNotMatch(second, /INV-2026-005 paid/);
    assert.equal(d.reviews.rows.length, 0);
  });

  test("held payment is acknowledged (no PayPal retry loop)", async () => {
    const d = deps(async () => { throw new PaymentHoldError([unknownOrderFlag("x")]); });
    assert.deepEqual(await result(await handleVerifiedEvent(completed("ORDER1"), d)), { status: 200, result: "held" });
  });

  test("unknown order is recorded once across redeliveries", async () => {
    const d = deps(async () => { throw new PaymentError("No invoice", 404); });
    for (const id of ["WH-1", "WH-2"]) {
      assert.deepEqual(await result(await handleVerifiedEvent(completed("ORPHAN1", id), d)), { status: 200, result: "flagged" });
    }
    assert.equal(d.reviews.rows.length, 1);
    assert.equal(d.reviews.rows[0].code, "UNKNOWN_ORDER");
  });

  test("a review that cannot be stored returns 5xx so PayPal retries", async () => {
    const d = deps(async () => { throw new PaymentError("No invoice", 404); }, new MemoryReviewStore(true));
    assert.equal((await handleVerifiedEvent(completed("ORPHAN1"), d)).status, 503);
  });

  test("refund/reversal on a paid invoice is flagged and never captured", async () => {
    let captured = false;
    const d = deps(async () => { captured = true; return { status: "paid", invoiceNumber: "" }; });
    const event: WebhookEvent = { id: "WH-9", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "CAP1", status: "REVERSED" } };
    assert.deepEqual(await result(await handleVerifiedEvent(event, d)), { status: 200, result: "flagged" });
    assert.equal(captured, false);
    assert.equal(d.reviews.rows[0].invoiceId, 5);
    const refund: WebhookEvent = { id: "WH-10", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REFUND1", links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP1" }] } };
    await handleVerifiedEvent(refund, d);
    assert.equal(d.reviews.rows[1].paypalCaptureId, "CAP1");
  });

  const reversals: [string, WebhookEvent, RegExp][] = [
    ["REFUNDED", { id: "WH-R1", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REFUND1", status: "COMPLETED", links: [{ rel: "up", href: "https://api.paypal.com/v2/payments/captures/CAP1" }] } }, /capture CAP1 for INV-2026-005 was refunded\./],
    ["REVERSED", { id: "WH-R2", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "CAP1", status: "REVERSED" } }, /capture CAP1 for INV-2026-005 was reversed\./],
    ["DENIED", { id: "WH-R3", event_type: "PAYMENT.CAPTURE.DENIED", resource: { id: "CAP1", status: "DENIED" } }, /capture CAP1 for INV-2026-005 was denied\./],
  ];
  for (const [kind, event, reason] of reversals) {
    test(`${kind}: one REVERSAL_EVENT review with the right reason; redelivery adds none; invoice only read, never captured`, async () => {
      const lookups: unknown[] = [];
      const d = deps(async () => { throw new Error("capture must not be called for a reversal"); });
      const findInvoice = d.findInvoice;
      d.findInvoice = async (where) => { lookups.push(where); return findInvoice(where); };
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await result(await handleVerifiedEvent(event, d)), { status: 200, result: "flagged" });
      }
      assert.equal(d.reviews.rows.length, 1, "redeliveries of the same event share one review");
      const [row] = d.reviews.rows;
      assert.equal(row.code, "REVERSAL_EVENT");
      assert.match(row.reason, reason);
      assert.match(row.recommendedAction, /did not change the invoice/);
      assert.deepEqual([row.invoiceId, row.invoiceNumber, row.paypalCaptureId, row.webhookEventId], [5, "INV-2026-005", "CAP1", event.id]);
      assert.ok(lookups.every((w) => JSON.stringify(w) === '{"captureId":"CAP1"}'), "only a read lookup by capture ID");
    });
  }

  test("a new reversal event for the same capture is a separate review", async () => {
    const d = deps(async () => { throw new Error("not called"); });
    for (const id of ["WH-A", "WH-B"]) {
      await handleVerifiedEvent({ id, event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "CAP1" } }, d);
    }
    assert.deepEqual(d.reviews.rows.map((r) => r.webhookEventId), ["WH-A", "WH-B"]);
  });

  test("reversal for an unknown capture is still recorded, without an invoice; a malformed capture ID is not stored", async () => {
    const d = deps(async () => { throw new Error("not called"); });
    assert.equal((await handleVerifiedEvent({ id: "WH-U", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "CAPX" } }, d)).status, 200);
    assert.deepEqual([d.reviews.rows[0].invoiceId, d.reviews.rows[0].paypalCaptureId], [null, "CAPX"]);
    assert.match(d.reviews.rows[0].reason, /capture CAPX was reversed\./);
    const bad: WebhookEvent = { id: "WH-M", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { links: [{ rel: "up", href: "https://x/captures/' OR 1=1" }] } };
    assert.equal((await handleVerifiedEvent(bad, d)).status, 200);
    assert.equal(d.reviews.rows[1].paypalCaptureId, null);
    assert.match(d.reviews.rows[1].reason, /capture \(unknown\) was refunded\./);
  });

  test("a reversal review that cannot be stored returns 503 so PayPal retries", async () => {
    const d = deps(async () => { throw new Error("not called"); }, new MemoryReviewStore(true));
    for (const [, event] of reversals) assert.equal((await handleVerifiedEvent(event, d)).status, 503);
  });

  test("transient failures still return 5xx; business-rule failures are acknowledged", async () => {
    const transient = deps(async () => { throw new ApiError({ request: {}, response: { statusCode: 503, headers: {}, body: "" } } as never, "down"); });
    assert.ok((await handleVerifiedEvent(completed("ORDER1"), transient)).status >= 500);
    const permanent = deps(async () => { throw new PaymentError("A CANCELLED invoice cannot be paid", 409); });
    assert.deepEqual(await result(await handleVerifiedEvent(completed("ORDER1"), permanent)), { status: 200, result: "not_applied" });
  });
});

describe("owner-only demo", () => {
  test("valid, wrong-amount and duplicate scenarios give the expected labelled decisions", async () => {
    const { results, reviews } = await runPaymentDemo();
    assert.ok(results.every((r) => r.demo === true && r.invoiceNumber.startsWith("DEMO-")));
    assert.deepEqual(
      results.map((r) => [r.scenario, r.decision, r.invoiceStatusAfter]),
      [
        ["Valid payment", "approved", "PAID"],
        ["Wrong amount", "held", "SENT"],
        ["Duplicate delivery (same invoice)", "already_recorded", "PAID"],
        ["Duplicate payment (capture reused)", "held", "SENT"],
      ]
    );
    assert.deepEqual(reviews.map((r) => r.code), ["AMOUNT_MISMATCH", "DUPLICATE_CAPTURE"]);
    assert.deepEqual(results.map((r) => r.flags.map((f) => f.code)), [[], ["AMOUNT_MISMATCH"], [], ["DUPLICATE_CAPTURE"]]);
  });

  test("duplicate delivery is a no-op: no flags, no review, invoice keeps its first payment", async () => {
    const { results, reviews } = await runPaymentDemo();
    const [valid, , duplicate] = results;
    assert.equal(duplicate.scenario, "Duplicate delivery (same invoice)");
    assert.deepEqual(
      [duplicate.decision, duplicate.invoiceNumber, duplicate.captureId, duplicate.invoiceStatusAfter],
      ["already_recorded", valid.invoiceNumber, valid.captureId, "PAID"]
    );
    assert.deepEqual(duplicate.flags, [], "no risk reason (e.g. INVOICE_NOT_PAYABLE) is shown for a no-op");
    assert.ok(reviews.every((r) => r.invoiceNumber !== duplicate.invoiceNumber), "no PaymentReview for the duplicated invoice");
    assert.match(duplicate.explanation, /already recorded; nothing changes/);
  });

  test("demo route requires the owner and changes nothing in the database", async () => {
    const url = "http://localhost:3000/api/payment-reviews/demo";
    assert.equal((await demoRoute(new Request(url, { method: "POST" }))).status, 401);
    assert.equal((await reviewsRoute(new NextRequest("http://localhost:3000/api/payment-reviews"))).status, 401);

    const snapshot = () => prisma.invoice.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, paypalCaptureId: true, updatedAt: true } });
    const before = await snapshot();
    const res = await demoRoute(new Request(url, { method: "POST", headers: { cookie: await ownerCookie(), "sec-fetch-site": "same-origin" } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.demo, true);
    assert.match(body.notice, /^DEMO/);
    assert.deepEqual(await snapshot(), before);
    await prisma.$disconnect();
  });
});
