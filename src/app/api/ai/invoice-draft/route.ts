/**
 * POST /api/ai/invoice-draft — generate an invoice draft from a natural-
 * language request for the user to review. Never writes to the database;
 * saving still goes through POST /api/invoices.
 *
 * Body: { "request": string }
 */

import { prisma } from "@/lib/prisma";
import { AiDraftError, generateInvoiceDraft } from "@/lib/ai-invoice";
import { MAX_DRAFT_REQUEST_LENGTH } from "@/lib/invoice-draft";
import { serverErrorResponse } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, errors: [{ field: "body", message: "Request body must be valid JSON" }] },
      { status: 400 }
    );
  }

  const text = (body as { request?: unknown } | null)?.request;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_DRAFT_REQUEST_LENGTH) {
    return Response.json(
      {
        ok: false,
        errors: [{ field: "request", message: `request must be 1–${MAX_DRAFT_REQUEST_LENGTH} characters` }],
      },
      { status: 422 }
    );
  }

  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ ok: false, error: "AI drafting is not configured on the server" }, { status: 503 });
  }

  try {
    const clients = await prisma.client.findMany({
      select: { id: true, name: true, company: true },
      orderBy: { name: "asc" },
    });
    const today = new Date().toISOString().slice(0, 10);
    const draft = await generateInvoiceDraft(text.trim(), clients, today);
    return Response.json({ ok: true, data: draft });
  } catch (err) {
    if (err instanceof AiDraftError) {
      return Response.json({ ok: false, error: err.message, errors: err.errors }, { status: err.status });
    }
    console.error("[POST /api/ai/invoice-draft]", err);
    return serverErrorResponse();
  }
}
