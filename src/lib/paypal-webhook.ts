/**
 * Handling of PayPal webhook events whose signature has already been verified
 * (see src/app/api/paypal/webhook/route.ts). Dependencies are injectable so
 * the decision logic can be tested without PayPal or the database.
 *
 * Response contract: 200 only once the event is fully processed, deliberately
 * ignored, or durably recorded as a PaymentReview; 5xx for anything transient
 * (including a failed review write) so PayPal retries.
 */

import { ApiError } from "@paypal/paypal-server-sdk";
import { prisma } from "@/lib/prisma";
import {
  PaymentError,
  PaymentHoldError,
  captureOrderForInvoice,
  describePaymentError,
  type CaptureOutcome,
} from "@/lib/paypal";
import {
  prismaReviewStore,
  reversalFlag,
  reviewRows,
  unknownOrderFlag,
  type ReviewContext,
  type ReviewStore,
  type RiskFlag,
} from "@/lib/payment-risk";

const PAYPAL_ID_PATTERN = /^[A-Z0-9]{1,36}$/i;

/** Verified events that report funds returned or never received. */
const REVERSAL_EVENTS = new Set(["PAYMENT.CAPTURE.REVERSED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.DENIED"]);

export type WebhookEvent = {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    supplementary_data?: { related_ids?: { order_id?: string } };
    links?: { rel?: string; href?: string }[];
  };
};

export interface WebhookDeps {
  capture(orderId: string): Promise<CaptureOutcome>;
  findInvoice(where: { captureId?: string; orderId?: string }): Promise<{ id: number; invoiceNumber: string } | null>;
  reviews: ReviewStore;
}

const defaultDeps: WebhookDeps = {
  capture: (orderId) => captureOrderForInvoice(orderId),
  findInvoice: ({ captureId, orderId }) =>
    prisma.invoice.findFirst({
      where: captureId ? { paypalCaptureId: captureId } : { paypalOrderId: orderId },
      select: { id: true, invoiceNumber: true },
    }),
  reviews: prismaReviewStore,
};

/** Event types that can lead to a PAID invoice, and where their order ID lives. */
function orderIdFor(event: WebhookEvent): string | undefined {
  switch (event.event_type) {
    case "CHECKOUT.ORDER.APPROVED":
      // Payer approved but may never have returned to the site — capture now.
      return event.resource?.id;
    case "PAYMENT.CAPTURE.COMPLETED":
      return event.resource?.supplementary_data?.related_ids?.order_id;
    default:
      return undefined;
  }
}

/** Capture ID of a reversal event: a refund resource links "up" to its capture. */
function reversedCaptureId(event: WebhookEvent): string | undefined {
  const id =
    event.event_type === "PAYMENT.CAPTURE.REFUNDED"
      ? event.resource?.links?.find((l) => l.rel === "up")?.href?.split("/").pop()
      : event.resource?.id;
  return id && PAYPAL_ID_PATTERN.test(id) ? id : undefined;
}

function ack(eventId: string | undefined, result: string): Response {
  return Response.json({ ok: true, eventId, result });
}

/** Stores review rows; null on success, a 5xx response if they could not be stored. */
async function flag(deps: WebhookDeps, flags: RiskFlag[], ctx: ReviewContext, tag: string): Promise<Response | null> {
  try {
    await deps.reviews.save(reviewRows(flags, ctx));
    console.warn(`${tag}: flagged ${flags.map((f) => f.code).join(", ")} for owner review`);
    return null;
  } catch (err) {
    console.error(`${tag}: could not record payment review`, err);
    return Response.json({ ok: false, error: "Processing failed" }, { status: 503 });
  }
}

export async function handleVerifiedEvent(event: WebhookEvent, deps: WebhookDeps = defaultDeps): Promise<Response> {
  const tag = `[paypal webhook] ${event.event_type ?? "unknown"} ${event.id ?? ""}`.trim();
  const eventId = event.id?.slice(0, 64) ?? null;

  if (event.event_type && REVERSAL_EVENTS.has(event.event_type)) {
    const captureId = reversedCaptureId(event);
    const rawOrderId = event.resource?.supplementary_data?.related_ids?.order_id;
    const orderId = rawOrderId && PAYPAL_ID_PATTERN.test(rawOrderId) ? rawOrderId : undefined;
    const invoice =
      (captureId ? await deps.findInvoice({ captureId }) : null) ??
      (orderId ? await deps.findInvoice({ orderId }) : null);
    const failed = await flag(
      deps,
      [reversalFlag(event.event_type, captureId, invoice?.invoiceNumber ?? null)],
      { invoiceId: invoice?.id, invoiceNumber: invoice?.invoiceNumber, orderId, captureId, eventId },
      tag
    );
    return failed ?? ack(event.id, "flagged");
  }

  const orderId = orderIdFor(event);
  if (orderId === undefined) {
    // Verified but not a payment-completing event (PENDING, …).
    if (event.event_type?.startsWith("PAYMENT.CAPTURE.")) {
      console.info(`${tag}: capture ${event.resource?.id ?? "?"} is ${event.resource?.status ?? "?"}; no invoice change`);
    }
    return ack(event.id, "ignored");
  }
  if (!PAYPAL_ID_PATTERN.test(orderId)) {
    console.warn(`${tag}: missing or malformed order ID`);
    return ack(event.id, "ignored");
  }

  try {
    const outcome = await deps.capture(orderId);
    if (outcome.alreadyPaid) {
      console.info(`${tag}: order ${orderId} → invoice ${outcome.invoiceNumber} already paid; duplicate delivery, no change`);
      return ack(event.id, "already_processed");
    }
    console.info(`${tag}: order ${orderId} → invoice ${outcome.invoiceNumber} ${outcome.status}`);
    return ack(event.id, outcome.status);
  } catch (err) {
    // The review row was stored before PaymentHoldError was thrown.
    if (err instanceof PaymentHoldError) return ack(event.id, "held");
    if (err instanceof PaymentError && err.status === 404) {
      const failed = await flag(deps, [unknownOrderFlag(orderId)], { orderId, eventId }, tag);
      return failed ?? ack(event.id, "flagged");
    }
    // Business-rule failures won't change on retry: acknowledge and log.
    const permanent =
      (err instanceof PaymentError && err.status < 500) ||
      (err instanceof ApiError && err.statusCode >= 400 && err.statusCode < 500);
    if (permanent) {
      console.warn(`${tag}: order ${orderId} not applied — ${describePaymentError(err).message}`);
      return ack(event.id, "not_applied");
    }
    console.error(`${tag}: order ${orderId} processing failed`, err);
    const { status } = describePaymentError(err);
    return Response.json({ ok: false, error: "Processing failed" }, { status: Math.max(status, 500) });
  }
}
