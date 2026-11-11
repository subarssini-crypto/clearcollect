/**
 * GET /api/payment-reviews?status=OPEN|REVIEWED|all — payments held for owner
 * review (src/lib/payment-risk.ts), newest first, at most 100. Read-only.
 */

import type { NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentReviewStatus } from "@/generated/prisma/enums";
import { serverErrorResponse } from "@/lib/validation";

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const raw = request.nextUrl.searchParams.get("status") ?? PaymentReviewStatus.OPEN;
  if (raw !== "all" && !Object.values(PaymentReviewStatus).includes(raw as PaymentReviewStatus)) {
    return Response.json({ ok: false, error: "status must be OPEN, REVIEWED or all" }, { status: 400 });
  }

  try {
    const data = await prisma.paymentReview.findMany({
      where: raw === "all" ? {} : { status: raw as PaymentReviewStatus },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return Response.json({ ok: true, data });
  } catch (err) {
    console.error("[GET /api/payment-reviews]", err);
    return serverErrorResponse();
  }
}
