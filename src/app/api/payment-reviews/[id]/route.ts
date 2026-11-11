/**
 * PATCH /api/payment-reviews/[id] { "status": "REVIEWED" } — the owner marks a
 * held payment as reviewed. This never changes the invoice: an invoice can
 * only become PAID through verified PayPal capture (src/lib/paypal.ts).
 */

import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/request";
import { PaymentReviewStatus } from "@/generated/prisma/enums";
import { notFoundResponse, serverErrorResponse } from "@/lib/validation";

export async function PATCH(request: Request, ctx: RouteContext<"/api/payment-reviews/[id]">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id < 1) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  if ((parsed.body as { status?: unknown } | null)?.status !== PaymentReviewStatus.REVIEWED) {
    return Response.json({ ok: false, error: 'status must be "REVIEWED"' }, { status: 400 });
  }

  try {
    const { count } = await prisma.paymentReview.updateMany({
      where: { id, status: PaymentReviewStatus.OPEN },
      data: { status: PaymentReviewStatus.REVIEWED, reviewedAt: new Date() },
    });
    if (count === 0 && !(await prisma.paymentReview.findUnique({ where: { id }, select: { id: true } }))) {
      return notFoundResponse(`Review ${id} not found`);
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error(`[PATCH /api/payment-reviews/${id}]`, err);
    return serverErrorResponse();
  }
}
