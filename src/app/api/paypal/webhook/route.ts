/**
 * POST /api/paypal/webhook — PayPal webhook receiver.
 *
 * 1. Verifies the signature with PayPal's verify-webhook-signature API.
 * 2. Uses the event only to identify the order; the order, capture, amount,
 *    and invoice association are re-fetched from PayPal and verified by
 *    captureOrderForInvoice before the invoice is marked PAID.
 * 3. Processing is idempotent: duplicate deliveries of an already-paid
 *    order are acknowledged without changes.
 * 4. Suspicious verified events (mismatches, duplicate captures, unknown
 *    orders, refunds/reversals) are stored once as PaymentReview rows
 *    (src/lib/paypal-webhook.ts) and acknowledged.
 *
 * Response codes: 401 for unverified requests, 200 for handled, recorded, or
 * intentionally ignored events, 5xx for transient failures (including a
 * review that could not be stored) so PayPal retries.
 */

import { describePaymentError, verifyWebhookSignature } from "@/lib/paypal";
import { handleVerifiedEvent, type WebhookEvent } from "@/lib/paypal-webhook";
import { readBodyText } from "@/lib/request";

const MAX_BODY_BYTES = 256 * 1024;

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

  try {
    return await handleVerifiedEvent(JSON.parse(rawBody) as WebhookEvent);
  } catch (err) {
    console.error("[paypal webhook] processing failed", err);
    return Response.json({ ok: false, error: "Processing failed" }, { status: 500 });
  }
}
