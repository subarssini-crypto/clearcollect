/**
 * POST /api/ai/invoice-draft — generate an invoice draft from a natural-
 * language request for the user to review, or clarification questions when
 * financially significant details are missing. Never writes to the database;
 * saving still goes through POST /api/invoices.
 *
 * Body: {
 *   "request": string,
 *   "selectedClientId"?: number | null,  // client chosen in the form (default client)
 *   "issueDate"?: string | null,         // dates the user set by hand (YYYY-MM-DD)
 *   "dueDate"?: string | null,
 *   "clarification"?: {                  // answers to field questions, matched by id
 *     "pending": object, "answers": [{ "id": string, "answer": string }], "earlierAnswers"?: string[]
 *   }
 * }
 * Response data: { kind: "draft", ... } | { kind: "clarification", questions }
 */

import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/request";
import { AiDraftError, generateInvoiceDraft } from "@/lib/ai-invoice";
import { MAX_DRAFT_REQUEST_LENGTH, isIsoDate, parseClarificationInput, resolveClarification } from "@/lib/invoice-draft";
import { serverErrorResponse, validationErrorResponse, type ValidationError } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = (parsed.body ?? {}) as Record<string, unknown>;

  const errors: ValidationError[] = [];
  const text = body.request;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_DRAFT_REQUEST_LENGTH) {
    errors.push({ field: "request", message: `request must be 1–${MAX_DRAFT_REQUEST_LENGTH} characters` });
  }
  const selected = body.selectedClientId ?? null;
  if (selected !== null && (typeof selected !== "number" || !Number.isInteger(selected) || selected < 1)) {
    errors.push({ field: "selectedClientId", message: "selectedClientId must be a positive integer or null" });
  }
  for (const field of ["issueDate", "dueDate"] as const) {
    const value = body[field] ?? null;
    if (value !== null && !isIsoDate(value)) errors.push({ field, message: `${field} must be YYYY-MM-DD or null` });
  }
  const clarification = parseClarificationInput(body.clarification);
  if (!clarification.ok) errors.push(...clarification.errors);
  if (errors.length > 0 || !clarification.ok) return validationErrorResponse(errors);

  // Answers to field questions are applied without calling Gemini.
  if (!clarification.data && !process.env.GEMINI_API_KEY) {
    return Response.json({ ok: false, error: "AI drafting is not configured on the server" }, { status: 503 });
  }

  try {
    const clients = await prisma.client.findMany({
      select: { id: true, name: true, company: true },
      orderBy: { name: "asc" },
    });
    const selectedClientId = selected as number | null;
    if (selectedClientId !== null && !clients.some((c) => c.id === selectedClientId)) {
      return validationErrorResponse([
        { field: "selectedClientId", message: "The selected client no longer exists. Reload the page and select a client." },
      ]);
    }

    const ctx = {
      request: (text as string).trim(),
      clients,
      selectedClientId,
      today: new Date().toISOString().slice(0, 10),
      formDates: { issueDate: body.issueDate as string | null, dueDate: body.dueDate as string | null },
    };
    if (clarification.data) {
      const resolved = resolveClarification(clarification.data, ctx);
      if (!resolved.ok) return validationErrorResponse(resolved.errors);
      return Response.json({ ok: true, data: resolved.data });
    }
    const outcome = await generateInvoiceDraft(ctx);
    return Response.json({ ok: true, data: outcome });
  } catch (err) {
    if (err instanceof AiDraftError) {
      return Response.json({ ok: false, error: err.message, errors: err.errors }, { status: err.status });
    }
    console.error("[POST /api/ai/invoice-draft]", err);
    return serverErrorResponse();
  }
}
