/**
 * POST /api/payment-reviews/demo — owner-only demo of the payment-risk rules
 * on mock invoices held in memory (src/lib/payment-demo.ts). No database
 * writes, no PayPal calls, no emails; results are labelled as demo data.
 */

import { requireOwner } from "@/lib/auth";
import { rejectCrossSite } from "@/lib/request";
import { runPaymentDemo } from "@/lib/payment-demo";

export async function POST(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  return Response.json({
    ok: true,
    demo: true,
    notice: "DEMO — mock data only. No real invoice, payment, or email was touched.",
    ...(await runPaymentDemo()),
  });
}
