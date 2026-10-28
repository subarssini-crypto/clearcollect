/**
 * GET /api/pay/[token] — public, client-facing view of one invoice (see
 * src/lib/payment-link.ts). No owner session: the unguessable token is the
 * credential. Unknown, malformed, DRAFT, and CANCELLED all get the same 404.
 */

import { getPublicInvoice } from "@/lib/payment-link";
import { serverErrorResponse } from "@/lib/validation";

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export async function GET(_request: Request, ctx: RouteContext<"/api/pay/[token]">): Promise<Response> {
  const { token } = await ctx.params;
  try {
    const invoice = await getPublicInvoice(token);
    if (!invoice) {
      return Response.json({ ok: false, error: "This payment link is not valid." }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ ok: true, data: invoice }, { headers: NO_STORE });
  } catch (err) {
    console.error("[GET /api/pay/[token]]", err);
    return serverErrorResponse();
  }
}
