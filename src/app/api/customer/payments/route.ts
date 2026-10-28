/**
 * GET /api/customer/payments — verified payment history for the signed-in
 * customer's own invoices (no PayPal references or internal IDs).
 */

import { requireCustomer } from "@/lib/customer-auth";
import { listPortalPayments } from "@/lib/customer-portal";
import { serverErrorResponse } from "@/lib/validation";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireCustomer(request);
  if ("response" in auth) return auth.response;
  try {
    const data = await listPortalPayments(auth.customer.clientId);
    return Response.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[GET /api/customer/payments]", err);
    return serverErrorResponse();
  }
}
