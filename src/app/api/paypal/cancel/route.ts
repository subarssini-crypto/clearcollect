/**
 * GET /api/paypal/cancel — PayPal redirects here when the payer cancels.
 * No invoice state changes; the unapproved order simply expires or is
 * reused on the next payment attempt.
 */

import { getAppOrigin } from "@/lib/paypal";

export async function GET(request: Request): Promise<Response> {
  const target = new URL("/invoices", getAppOrigin(request.url));
  target.searchParams.set("payment", "cancelled");
  return Response.redirect(target, 303);
}
