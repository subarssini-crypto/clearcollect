/**
 * GET /api/paypal/return?token=<orderId> — PayPal redirects the payer here
 * after approval. The order is captured and verified server-side; the query
 * string is only used to identify which order to check. The payer is then
 * sent back to the invoice's public payment page, which shows the status
 * from MySQL (the `payment` parameter is display-only).
 */

import { type NextRequest } from "next/server";
import { captureOrderForInvoice, describePaymentError } from "@/lib/paypal";
import { payPageRedirect } from "@/lib/payment-link";

const ORDER_ID_PATTERN = /^[A-Z0-9]{1,36}$/i;

export async function GET(request: NextRequest): Promise<Response> {
  const orderId = request.nextUrl.searchParams.get("token");

  if (!orderId || !ORDER_ID_PATTERN.test(orderId)) {
    return payPageRedirect(request, null, "error");
  }

  let result = "error";
  try {
    result = (await captureOrderForInvoice(orderId)).status;
  } catch (err) {
    const { status } = describePaymentError(err);
    if (status >= 409) console.error(`[GET /api/paypal/return] order ${orderId}`, err);
  }
  return payPageRedirect(request, orderId, result);
}
