/**
 * GET /api/paypal/return?token=<orderId> — PayPal redirects the payer here
 * after approval. The order is captured and verified server-side; the query
 * string is only used to identify which order to check.
 */

import { type NextRequest } from "next/server";
import { captureOrderForInvoice, describePaymentError, getAppOrigin } from "@/lib/paypal";

export async function GET(request: NextRequest): Promise<Response> {
  const target = new URL("/invoices", getAppOrigin(request.url));
  const orderId = request.nextUrl.searchParams.get("token");

  if (!orderId || !/^[A-Z0-9]{1,36}$/i.test(orderId)) {
    target.searchParams.set("payment", "error");
    return Response.redirect(target, 303);
  }

  try {
    const outcome = await captureOrderForInvoice(orderId);
    target.searchParams.set("payment", outcome.status);
    target.searchParams.set("invoice", outcome.invoiceNumber);
  } catch (err) {
    const { status } = describePaymentError(err);
    if (status >= 409) console.error(`[GET /api/paypal/return] order ${orderId}`, err);
    target.searchParams.set("payment", "error");
  }
  return Response.redirect(target, 303);
}
