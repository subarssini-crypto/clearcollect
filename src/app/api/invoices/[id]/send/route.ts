/**
 * GET  /api/invoices/[id]/send — preview the invoice email (recipient, subject,
 *                                message, delivery mode). Sends and changes nothing.
 * POST /api/invoices/[id]/send — email a saved DRAFT invoice to its client via Zapier.
 *      Body: { "confirmResend"?: boolean } — required as true only when an
 *      earlier send timed out, was interrupted, or was already accepted.
 *
 * The recipient is always the client's email stored in MySQL; the browser
 * cannot supply one. The invoice becomes SENT only after Zapier accepts the
 * email (see src/lib/invoice-email.ts). This is separate from payment
 * reminders (/api/follow-ups/send), which only cover SENT/OVERDUE invoices.
 */

import { requireOwner } from "@/lib/auth";
import { readJsonBody } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";
import { InvoiceEmailError, previewInvoiceEmail, sendInvoiceEmail } from "@/lib/invoice-email";

async function parseId(ctx: RouteContext<"/api/invoices/[id]/send">): Promise<number | null> {
  const { id } = await ctx.params;
  const parsed = parseInt(id, 10);
  return Number.isInteger(parsed) && parsed > 0 && String(parsed) === id ? parsed : null;
}

function errorResponse(err: unknown, label: string): Response {
  if (err instanceof InvoiceEmailError) {
    return Response.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
  }
  console.error(label, err);
  return serverErrorResponse();
}

export async function GET(request: Request, ctx: RouteContext<"/api/invoices/[id]/send">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const id = await parseId(ctx);
  if (id === null) return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });

  try {
    return Response.json({ ok: true, data: await previewInvoiceEmail(id) });
  } catch (err) {
    return errorResponse(err, `[GET /api/invoices/${id}/send]`);
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/invoices/[id]/send">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const id = await parseId(ctx);
  if (id === null) return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ ok: false, errors: [{ field: "body", message: "Request body must be a JSON object" }] }, { status: 422 });
  }
  const confirmResend = (body as { confirmResend?: unknown }).confirmResend;
  if (confirmResend !== undefined && typeof confirmResend !== "boolean") {
    return Response.json({ ok: false, errors: [{ field: "confirmResend", message: "confirmResend must be a boolean" }] }, { status: 422 });
  }

  try {
    return Response.json({ ok: true, data: await sendInvoiceEmail(id, { confirmResend: confirmResend === true }) });
  } catch (err) {
    return errorResponse(err, `[POST /api/invoices/${id}/send]`);
  }
}
