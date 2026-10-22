/**
 * POST /api/paypal/webhook — PayPal webhook receiver.
 *
 * 1. Verifies the signature with PayPal's verify-webhook-signature API.
 * 2. Uses the event only to identify the order; the order, capture, amount,
 *    and invoice association are re-fetched from PayPal and verified by
 *    captureOrderForInvoice before the invoice is marked PAID.
 * 3. Processing is idempotent: duplicate deliveries of an already-paid
 *    order are acknowledged without changes.
 *
 * Response codes: 401 for unverified requests, 200 for handled or
 * intentionally ignored events, 5xx for transient failures so PayPal retries.
 */

import { ApiError } from "@paypal/paypal-server-sdk";
import {
  PaymentError,
  captureOrderForInvoice,
  describePaymentError,
  verifyWebhookSignature,
} from "@/lib/paypal";
import { readBodyText } from "@/lib/request";

const MAX_BODY_BYTES = 256 * 1024;
const ORDER_ID_PATTERN = /^[A-Z0-9]{1,36}$/i;

type WebhookEvent = {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
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

function ack(eventId: string | undefined, result: string): Response {
  return Response.json({ ok: true, eventId, result });
}

export async function POST(request: Request): Promise<Response> {
  // Read incrementally so an oversized body is never fully buffered.
  const rawBody = await readBodyText(request, MAX_BODY_BYTES);
  if (rawBody === null) {
    return Response.json({ ok: false, error: "Payload too large" }, { status: 413 });
  }

  let verified: boolean;
  try {
    verified = await verifyWebhookSignature(request.headers, rawBody);
  } catch (err) {
    console.error("[paypal webhook] signature verification error", err);
    const { status } = describePaymentError(err);
    return Response.json({ ok: false, error: "Verification failed" }, { status: Math.max(status, 500) });
  }
  if (!verified) {
    console.warn("[paypal webhook] rejected unverified request");
    return Response.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  }

  const event = JSON.parse(rawBody) as WebhookEvent;
  const tag = `[paypal webhook] ${event.event_type ?? "unknown"} ${event.id ?? ""}`.trim();

  const orderId = orderIdFor(event);
  if (orderId === undefined) {
    // Verified but not a payment-completing event (PENDING, DENIED, REFUNDED, …).
    if (event.event_type?.startsWith("PAYMENT.CAPTURE.")) {
      console.info(`${tag}: capture ${event.resource?.id ?? "?"} is ${event.resource?.status ?? "?"}; no invoice change`);
    }
    return ack(event.id, "ignored");
  }
  if (!ORDER_ID_PATTERN.test(orderId)) {
    console.warn(`${tag}: missing or malformed order ID`);
    return ack(event.id, "ignored");
  }

  try {
    const outcome = await captureOrderForInvoice(orderId);
    console.info(`${tag}: order ${orderId} → invoice ${outcome.invoiceNumber} ${outcome.status}`);
    return ack(event.id, outcome.status);
  } catch (err) {
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
