/**
 * GET  /api/clients        — list all clients (with invoice count)
 * POST /api/clients        — create a new client
 */

import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/request";
import {
  validateCreateClient,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/validation";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

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
  const denied = await requireOwner(request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

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
