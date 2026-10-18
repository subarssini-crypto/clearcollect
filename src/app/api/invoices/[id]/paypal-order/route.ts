/**
 * POST /api/invoices/[id]/paypal-order — create (or reuse) a PayPal order for
 * an invoice and return its approval URL.
 *
 * The request body is ignored: amount and currency always come from MySQL.
 */

import {
  createOrderForInvoice,
  describePaymentError,
  getAppOrigin,
} from "@/lib/paypal";

export async function POST(
  request: Request,
  ctx: RouteContext<"/api/invoices/[id]/paypal-order">
): Promise<Response> {
  const { id: rawId } = await ctx.params;
  const id = parseInt(rawId, 10);
  if (!Number.isInteger(id) || id < 1) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  try {
    const { approveUrl, orderId } = await createOrderForInvoice(id, getAppOrigin(request.url));
    return Response.json({ ok: true, data: { approveUrl, orderId } });
  } catch (err) {
    const { status, message } = describePaymentError(err);
    if (status >= 500) console.error(`[POST /api/invoices/${id}/paypal-order]`, err);
    return Response.json({ ok: false, error: message }, { status });
  }
}
