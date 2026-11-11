/**
 * Deterministic payment-risk rules and owner review records.
 *
 * Every rule here is a fixed comparison of data from MySQL against data
 * PayPal returned to the server (never the browser). Any flag means "hold":
 * the invoice stays unpaid and a PaymentReview row tells the owner why and
 * what to do. Nothing in this module — and no LLM — can mark an invoice PAID;
 * only recordVerifiedPayment in src/lib/paypal.ts does, after these pass.
 */

import { InvoiceStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { lineItemsTotalCents, parseStoredLineItems } from "@/lib/line-items";

/** Invoice statuses that may be paid via PayPal. */
export const PAYABLE_STATUSES: InvoiceStatus[] = [InvoiceStatus.SENT, InvoiceStatus.OVERDUE];

export type RiskCode =
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "LINE_ITEMS_TOTAL_MISMATCH"
  | "LINE_ITEMS_INVALID"
  | "ORDER_MISMATCH"
  | "DUPLICATE_CAPTURE"
  | "ALREADY_PAID_OTHER_CAPTURE"
  | "INVOICE_NOT_PAYABLE"
  | "INVOICE_STATE_CHANGED"
  | "UNKNOWN_ORDER"
  | "REVERSAL_EVENT";

export interface RiskFlag {
  code: RiskCode;
  reason: string;
  recommendedAction: string;
  expected?: string;
  observed?: string;
}

export interface Money {
  currencyCode?: string;
  value?: string;
}

/** The invoice fields the rules read, as stored in MySQL. */
export interface InvoiceFacts {
  id: number;
  invoiceNumber: string;
  amount: { toString(): string };
  currency: string;
  status: string;
  lineItems: unknown;
  paypalCaptureId: string | null;
}

/** Integer hundredths for a non-negative decimal string, or null if malformed. */
export function toCents(value: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : null;
}

function money(currency: string | undefined, value: string | undefined): string {
  const cents = value === undefined ? null : toCents(value);
  return `${currency ?? "???"} ${cents === null ? (value ?? "missing") : (cents / 100).toFixed(2)}`;
}

const invoiceMoney = (invoice: InvoiceFacts) => money(invoice.currency, invoice.amount.toString());

// ── Rules ─────────────────────────────────────────────────────────────────────

/** Stored line items (quantity × rate) must still add up to the stored amount. */
export function checkInvoiceTotals(invoice: InvoiceFacts): RiskFlag[] {
  if (invoice.lineItems === null || invoice.lineItems === undefined) return [];
  const items = parseStoredLineItems(invoice.lineItems);
  if (!items) {
    return [{
      code: "LINE_ITEMS_INVALID",
      reason: `${invoice.invoiceNumber} has stored line items that are malformed, so its total cannot be verified.`,
      recommendedAction: "Check the invoice in the database; recreate it if the line items were altered outside ClearCollect.",
    }];
  }
  const itemsCents = lineItemsTotalCents(items);
  const amountCents = toCents(invoice.amount.toString());
  if (amountCents !== null && itemsCents === amountCents) return [];
  return [{
    code: "LINE_ITEMS_TOTAL_MISMATCH",
    reason: `${invoice.invoiceNumber}'s line items add up to ${money(invoice.currency, (itemsCents / 100).toFixed(2))}, but its amount is ${invoiceMoney(invoice)}.`,
    recommendedAction: "Do not accept payment until the invoice is corrected; the stored amount may have been tampered with.",
    expected: money(invoice.currency, (itemsCents / 100).toFixed(2)),
    observed: invoiceMoney(invoice),
  }];
}

/** The PayPal order itself is priced or referenced differently from the invoice. */
export function orderMismatchFlag(invoice: InvoiceFacts, orderAmount: Money | undefined): RiskFlag {
  return {
    code: "ORDER_MISMATCH",
    reason: `The PayPal order for ${invoice.invoiceNumber} does not match the invoice's reference, amount or currency (order: ${money(orderAmount?.currencyCode, orderAmount?.value)}, invoice: ${invoiceMoney(invoice)}).`,
    recommendedAction: "Check the order in PayPal. Refund any captured funds and ask the client to pay again from the invoice link.",
    expected: invoiceMoney(invoice),
    observed: money(orderAmount?.currencyCode, orderAmount?.value),
  };
}

/**
 * Checks a completed PayPal capture against the invoice it claims to pay.
 * `captureInvoiceId` is the invoice already holding this capture ID, if any.
 */
export function checkCapture(
  invoice: InvoiceFacts,
  capture: { id: string; amount?: Money },
  ctx: { captureInvoiceId: number | null }
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const observed = money(capture.amount?.currencyCode, capture.amount?.value);

  if (capture.amount?.currencyCode !== invoice.currency) {
    flags.push({
      code: "CURRENCY_MISMATCH",
      reason: `Capture ${capture.id} was made in ${capture.amount?.currencyCode ?? "an unknown currency"}, but ${invoice.invoiceNumber} is billed in ${invoice.currency}.`,
      recommendedAction: "Refund the capture in PayPal and ask the client to pay again from the invoice link.",
      expected: invoiceMoney(invoice),
      observed,
    });
  } else {
    const paid = capture.amount.value === undefined ? null : toCents(capture.amount.value);
    if (paid === null || paid !== toCents(invoice.amount.toString())) {
      flags.push({
        code: "AMOUNT_MISMATCH",
        reason: `Capture ${capture.id} is for ${observed}, but ${invoice.invoiceNumber} is for ${invoiceMoney(invoice)}.`,
        recommendedAction: "Do not mark the invoice paid. Refund or top up the difference in PayPal, then confirm with the client.",
        expected: invoiceMoney(invoice),
        observed,
      });
    }
  }

  if (ctx.captureInvoiceId !== null && ctx.captureInvoiceId !== invoice.id) {
    flags.push({
      code: "DUPLICATE_CAPTURE",
      reason: `Capture ${capture.id} is already recorded as payment for another invoice (id ${ctx.captureInvoiceId}).`,
      recommendedAction: "Treat as possible fraud or replay. Verify the capture in PayPal before taking any action.",
    });
  }
  if (invoice.paypalCaptureId && invoice.paypalCaptureId !== capture.id) {
    flags.push({
      code: "ALREADY_PAID_OTHER_CAPTURE",
      reason: `${invoice.invoiceNumber} was already paid by capture ${invoice.paypalCaptureId}; capture ${capture.id} is a second payment.`,
      recommendedAction: "Refund the duplicate capture in PayPal.",
    });
  } else if (!PAYABLE_STATUSES.includes(invoice.status as InvoiceStatus)) {
    flags.push({
      code: "INVOICE_NOT_PAYABLE",
      reason: `Capture ${capture.id} completed for ${invoice.invoiceNumber}, which is ${invoice.status} and cannot be paid.`,
      recommendedAction: "Refund the capture in PayPal, or reopen the invoice and contact the client.",
      observed,
    });
  }

  return [...flags, ...checkInvoiceTotals(invoice)];
}

export function invoiceStateChangedFlag(invoice: InvoiceFacts, captureId: string): RiskFlag {
  return {
    code: "INVOICE_STATE_CHANGED",
    reason: `Capture ${captureId} passed every check, but ${invoice.invoiceNumber} changed while it was being recorded.`,
    recommendedAction: "Open the invoice and the PayPal capture and reconcile them by hand.",
  };
}

export function unknownOrderFlag(orderId: string): RiskFlag {
  return {
    code: "UNKNOWN_ORDER",
    reason: `PayPal sent a verified payment event for order ${orderId}, which is not linked to any invoice.`,
    recommendedAction: "Check the order in PayPal. If ClearCollect did not create it, ignore it; otherwise refund and investigate.",
  };
}

export function reversalFlag(eventType: string, captureId: string | undefined, invoiceNumber: string | null): RiskFlag {
  const what = eventType.replace("PAYMENT.CAPTURE.", "").toLowerCase();
  return {
    code: "REVERSAL_EVENT",
    reason: `PayPal reports capture ${captureId ?? "(unknown)"}${invoiceNumber ? ` for ${invoiceNumber}` : ""} was ${what}.`,
    recommendedAction: "Review the capture in PayPal. ClearCollect did not change the invoice; reopen it or contact the client if funds were returned.",
  };
}

// ── Review records ────────────────────────────────────────────────────────────

export interface ReviewContext {
  invoiceId?: number | null;
  invoiceNumber?: string | null;
  orderId?: string | null;
  captureId?: string | null;
  eventId?: string | null;
}

export interface PaymentReviewInput {
  dedupeKey: string;
  code: RiskCode;
  reason: string;
  recommendedAction: string;
  invoiceId: number | null;
  invoiceNumber: string | null;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  webhookEventId: string | null;
  expected: string | null;
  observed: string | null;
}

const clip = (value: string | null | undefined, max: number) => (value ? value.slice(0, max) : null);

/**
 * One row per flag. The key ignores the webhook event ID (so a redelivery, or
 * the return page and the webhook for the same capture, share one row) except
 * for reversals, where each PayPal event is a separate occurrence.
 */
export function reviewRows(flags: RiskFlag[], ctx: ReviewContext): PaymentReviewInput[] {
  return flags.map((flag) => ({
    dedupeKey: [
      flag.code,
      ctx.invoiceId ?? "-",
      ctx.orderId ?? "-",
      ctx.captureId ?? "-",
      flag.code === "REVERSAL_EVENT" ? (ctx.eventId ?? "-") : "",
    ].join(":").slice(0, 191),
    code: flag.code,
    reason: flag.reason.slice(0, 500),
    recommendedAction: flag.recommendedAction.slice(0, 500),
    invoiceId: ctx.invoiceId ?? null,
    invoiceNumber: clip(ctx.invoiceNumber, 191),
    paypalOrderId: clip(ctx.orderId, 64),
    paypalCaptureId: clip(ctx.captureId, 64),
    webhookEventId: clip(ctx.eventId, 64),
    expected: clip(flag.expected, 64),
    observed: clip(flag.observed, 64),
  }));
}

export interface ReviewStore {
  /** Durably stores the rows; existing dedupe keys are left untouched. Throws on failure. */
  save(rows: PaymentReviewInput[]): Promise<void>;
}

/** True only for a Prisma unique-constraint error on PaymentReview.dedupeKey. */
export function isDedupeKeyConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null || (err as { code?: unknown }).code !== "P2002") return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  // MySQL reports the index name (PaymentReview_dedupeKey_key); others report field names.
  return Array.isArray(target)
    ? target.some((t) => String(t).includes("dedupeKey"))
    : String(target ?? "").includes("dedupeKey");
}

/**
 * Inserts each row; a row whose dedupeKey already exists (redelivery, or a
 * concurrent delivery winning the race) is skipped. Every other error —
 * connection loss, missing table, other constraints — propagates. Rows
 * stored before a failure are skipped as duplicates on the retry.
 */
export async function saveReviewRows(
  rows: PaymentReviewInput[],
  create: (row: PaymentReviewInput) => Promise<unknown>
): Promise<void> {
  for (const row of rows) {
    try {
      await create(row);
    } catch (err) {
      if (!isDedupeKeyConflict(err)) throw err;
    }
  }
}

export const prismaReviewStore: ReviewStore = {
  save: (rows) => saveReviewRows(rows, (data) => prisma.paymentReview.create({ data, select: { id: true } })),
};
