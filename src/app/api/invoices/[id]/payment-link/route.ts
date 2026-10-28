/**
 * POST /api/invoices/[id]/payment-link — owner only: return the client's
 * public payment page URL for an issued invoice, creating its token on first
 * use. The link origin is APP_URL (or a local dev origin), never the Host header.
 */

import { requireOwner } from "@/lib/auth";
import { ensurePaymentToken, paymentPageUrl } from "@/lib/payment-link";
import { PAYABLE_STATUSES, describePaymentError, getPaymentReturnOrigin } from "@/lib/paypal";
import { prisma } from "@/lib/prisma";
import { rejectCrossSite } from "@/lib/request";
import { InvoiceStatus } from "@/generated/prisma/enums";

export async function POST(request: Request, ctx: RouteContext<"/api/invoices/[id]/payment-link">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  const { id: rawId } = await ctx.params;
  const id = parseInt(rawId, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== rawId) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  try {
    const origin = getPaymentReturnOrigin(request.url);
    const invoice = await prisma.invoice.findUnique({ where: { id }, select: { status: true } });
    if (!invoice) return Response.json({ ok: false, error: `Invoice ${id} not found` }, { status: 404 });
    if (invoice.status !== InvoiceStatus.PAID && !PAYABLE_STATUSES.includes(invoice.status)) {
      return Response.json(
        { ok: false, error: `A ${invoice.status} invoice has no payment link; send the invoice first` },
        { status: 409 }
      );
    }
    const token = await ensurePaymentToken(id);
    if (!token) return Response.json({ ok: false, error: `Invoice ${id} not found` }, { status: 404 });
    return Response.json({ ok: true, data: { url: paymentPageUrl(origin, token) } });
  } catch (err) {
    const { status, message } = describePaymentError(err);
    if (status >= 500) console.error(`[POST /api/invoices/${id}/payment-link]`, err);
    return Response.json({ ok: false, error: message }, { status });
  }
}
