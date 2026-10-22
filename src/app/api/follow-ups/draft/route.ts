/**
 * POST /api/follow-ups/draft — Gemini drafts a reminder for an unpaid invoice.
 * Body: { "invoiceId": number }. The invoice must be SENT/OVERDUE and unpaid;
 * invoice facts come from MySQL, not the browser. Nothing is sent or saved.
 */

import { requireOwner } from "@/lib/auth";
import { AiDraftError } from "@/lib/ai-invoice";
import { FollowUpError, draftReminderWithAi, loadRemindableInvoice } from "@/lib/follow-up";
import { serverErrorResponse } from "@/lib/validation";
import { readJsonBody } from "@/lib/request";

export async function POST(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const invoiceId = (body as { invoiceId?: unknown } | null)?.invoiceId;
  if (typeof invoiceId !== "number" || !Number.isInteger(invoiceId) || invoiceId < 1) {
    return Response.json({ ok: false, errors: [{ field: "invoiceId", message: "invoiceId must be a positive integer" }] }, { status: 422 });
  }

  try {
    const invoice = await loadRemindableInvoice(invoiceId);
    const { subject, message } = await draftReminderWithAi(invoice, Date.now());
    return Response.json({ ok: true, data: { invoiceId, subject, message } });
  } catch (err) {
    if (err instanceof FollowUpError || err instanceof AiDraftError) {
      return Response.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error("[POST /api/follow-ups/draft]", err);
    return serverErrorResponse();
  }
}
