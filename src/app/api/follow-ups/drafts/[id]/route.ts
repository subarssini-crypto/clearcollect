/**
 * DELETE /api/follow-ups/drafts/[id] — delete an unsent reminder draft.
 *
 * Only a row whose server-side status is DRAFT is deleted (one conditional
 * statement). Reminders that are being sent, have an uncertain outcome, or
 * were sent/attempted are history and are refused with 409.
 */

import { requireOwner } from "@/lib/auth";
import { rejectCrossSite } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";
import { FollowUpError } from "@/lib/follow-up";
import { deleteReminderDraft } from "@/lib/reminder-drafts";

export async function DELETE(request: Request, ctx: RouteContext<"/api/follow-ups/drafts/[id]">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id < 1) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  try {
    await deleteReminderDraft(id);
    return Response.json({ ok: true, message: "Draft deleted. No reminder was sent.", data: { id } });
  } catch (err) {
    if (err instanceof FollowUpError) return Response.json({ ok: false, error: err.message }, { status: err.status });
    console.error(`[DELETE /api/follow-ups/drafts/${id}]`, err);
    return serverErrorResponse();
  }
}
