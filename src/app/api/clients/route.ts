/**
 * GET  /api/clients        — list all clients (with invoice count)
 * POST /api/clients        — create a new client
 */

import { prisma } from "@/lib/prisma";
import {
  validateCreateClient,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/validation";

export async function GET(): Promise<Response> {
  try {
    const clients = await prisma.client.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { invoices: true } },
      },
    });
    return Response.json({ ok: true, data: clients });
  } catch (err) {
    console.error("[GET /api/clients]", err);
    return serverErrorResponse();
  }
}

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

  const result = validateCreateClient(body);
  if (!result.ok) return validationErrorResponse(result.errors);

  try {
    const client = await prisma.client.create({ data: result.data });
    return Response.json({ ok: true, data: client }, { status: 201 });
  } catch (err: unknown) {
    console.error("[POST /api/clients]", err);
    return serverErrorResponse();
  }
}
