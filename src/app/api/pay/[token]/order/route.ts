/**
 * POST /api/pay/[token]/order — public: create (or reuse) the PayPal order
 * for the invoice behind a payment link and return its approval URL.
 *
 * The request body is ignored: amount and currency always come from MySQL,
 * and createOrderForInvoice refuses PAID, DRAFT, and CANCELLED invoices.
 * Duplicate clicks resolve to one PayPal order (PayPal-Request-Id), and the
 * invoice is marked PAID only by captureOrderForInvoice after verification.
 */

import { invoiceIdForToken } from "@/lib/payment-link";
import { createOrderForInvoice, describePaymentError, getPaymentReturnOrigin } from "@/lib/paypal";
import { rejectCrossSite } from "@/lib/request";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, ctx: RouteContext<"/api/pay/[token]/order">): Promise<Response> {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  const { token } = await ctx.params;
  const notFound = Response.json({ ok: false, error: "This payment link is not valid." }, { status: 404, headers: NO_STORE });

  try {
    const origin = getPaymentReturnOrigin(request.url);
    const invoiceId = await invoiceIdForToken(token);
    if (invoiceId === null) return notFound;
    const { approveUrl } = await createOrderForInvoice(invoiceId, origin);
    return Response.json({ ok: true, data: { approveUrl } }, { headers: NO_STORE });
  } catch (err) {
    const { status, message } = describePaymentError(err);
    if (status === 404) return notFound;
    if (status >= 500) console.error("[POST /api/pay/[token]/order]", err);
    // Server-side problems get a generic message; payment-state errors (409) are safe to show.
    const error = status >= 500 ? "Payment could not be started. Please try again later." : message;
    return Response.json({ ok: false, error }, { status, headers: NO_STORE });
  }
}
