/**
 * GET /api/paypal/cancel?token=<orderId> — PayPal redirects here when the
 * payer cancels. No invoice state changes; the unapproved order simply
 * expires or is reused on the next payment attempt. The payer goes back to
 * the invoice's public payment page.
 */

import { type NextRequest } from "next/server";
import { payPageRedirect } from "@/lib/payment-link";

export async function GET(request: NextRequest): Promise<Response> {
  return payPageRedirect(request, request.nextUrl.searchParams.get("token"), "cancelled");
}
