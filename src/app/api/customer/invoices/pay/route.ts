/**
 * POST /api/customer/invoices/pay — start PayPal payment for one of the
 * signed-in customer's invoices. Body: { invoiceNumber }
 *
 * Reuses the existing server-side order flow (src/lib/paypal.ts): amount and
 * currency come from MySQL, PAID/DRAFT/CANCELLED invoices are refused, and the
 * invoice becomes PAID only after a verified capture.
 */

import { requireCustomer } from "@/lib/customer-auth";
import { PortalError, startPortalPayment } from "@/lib/customer-portal";
import { describePaymentError, getPaymentReturnOrigin } from "@/lib/paypal";
import { readJsonBody } from "@/lib/request";

export async function POST(request: Request): Promise<Response> {
  const parsed = await readJsonBody(request, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  const headers = { "cache-control": "no-store" };
  try {
    const auth = await requireCustomer(request);
    if ("response" in auth) return auth.response;
    const origin = getPaymentReturnOrigin(request.url);
    const body = parsed.body;
    const invoiceNumber = typeof body === "object" && body !== null ? (body as { invoiceNumber?: unknown }).invoiceNumber : undefined;
    const { approveUrl } = await startPortalPayment(auth.customer.clientId, invoiceNumber, origin);
    return Response.json({ ok: true, data: { approveUrl } }, { headers });
  } catch (err) {
    if (err instanceof PortalError) return Response.json({ ok: false, error: err.message }, { status: err.status, headers });
    const { status, message } = describePaymentError(err);
    if (status === 404) return Response.json({ ok: false, error: "Invoice not found" }, { status, headers });
    if (status >= 500) console.error("[POST /api/customer/invoices/pay]", err);
    const error = status >= 500 ? "Payment could not be started. Please try again later." : message;
    return Response.json({ ok: false, error }, { status, headers });
  }
}
