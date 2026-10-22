/**
 * POST /api/follow-ups/send — deliver a user-approved reminder.
 * Body: { "invoiceId": number, "subject": string, "message": string }.
 *
 * Re-checks server-side that the invoice exists and is still unpaid, then
 * forwards it to the configured Zapier webhook. Without Zapier configuration
 * it returns demo mode and nothing is sent. `delivered: true` is returned only
 * when Zapier confirms receipt.
 */

import { requireOwner } from "@/lib/auth";
import { FollowUpError, deliverReminder, loadRemindableInvoice, validateSendReminder } from "@/lib/follow-up";
import { serverErrorResponse, validationErrorResponse } from "@/lib/validation";
import { readJsonBody } from "@/lib/request";

export async function POST(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const input = validateSendReminder(body);
  if (!input.ok) return validationErrorResponse(input.errors);

  try {
    const invoice = await loadRemindableInvoice(input.data.invoiceId);
    const result = await deliverReminder(invoice, input.data, Date.now());
    return Response.json({ ok: true, data: result });
  } catch (err) {
    if (err instanceof FollowUpError) {
      return Response.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error("[POST /api/follow-ups/send]", err);
    return serverErrorResponse();
  }
}
