/**
 * GET /api/customer/invoices?status=all|pending|paid|overdue — the signed-in
 * customer's own invoices (scoped by the client linked to their account).
 */

import { requireCustomer } from "@/lib/customer-auth";
import { listPortalInvoices, parsePortalFilter } from "@/lib/customer-portal";
import { serverErrorResponse } from "@/lib/validation";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireCustomer(request);
  if ("response" in auth) return auth.response;
  try {
    const filter = parsePortalFilter(new URL(request.url).searchParams.get("status"));
    if (!filter) return Response.json({ ok: false, error: "status must be all, pending, paid, or overdue" }, { status: 400 });
    const data = await listPortalInvoices(auth.customer.clientId, filter);
    return Response.json(
      { ok: true, data, meta: { linked: auth.customer.clientId !== null, filter } },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    console.error("[GET /api/customer/invoices]", err);
    return serverErrorResponse();
  }
}
