/**
 * GET  /api/follow-ups/drafts — saved, unsent reminder drafts.
 * POST /api/follow-ups/drafts — save a draft.
 *      Body: { "invoiceId": number, "subject": string, "message": string, "draftId"?: number }.
 *      Only for invoices that can receive reminders (unpaid SENT/OVERDUE).
 *
 * Nothing here sends anything. Sent reminders are history and never appear
 * as drafts (see src/lib/reminder-drafts.ts).
 */

import { requireOwner } from "@/lib/auth";
import { readJsonBody } from "@/lib/request";
import { serverErrorResponse, validationErrorResponse } from "@/lib/validation";
import { FollowUpError } from "@/lib/follow-up";
import { DraftValidationError, prismaReminderStore, saveReminderDraft } from "@/lib/reminder-drafts";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  try {
    return Response.json({ ok: true, data: await prismaReminderStore.listDrafts() });
  } catch (err) {
    console.error("[GET /api/follow-ups/drafts]", err);
    return serverErrorResponse();
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { id } = await saveReminderDraft(parsed.body);
    return Response.json({ ok: true, data: { id }, message: "Draft saved. Nothing was sent." });
  } catch (err) {
    if (err instanceof DraftValidationError) return validationErrorResponse(err.errors);
    if (err instanceof FollowUpError) return Response.json({ ok: false, error: err.message }, { status: err.status });
    console.error("[POST /api/follow-ups/drafts]", err);
    return serverErrorResponse();
  }
}
