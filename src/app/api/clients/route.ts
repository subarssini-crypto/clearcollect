/**
 * GET  /api/clients        — list active clients (with invoice count);
 *                            ?archived=true lists archived clients instead
 * POST /api/clients        — create a new client
 */

import { requireOwner } from "@/lib/auth";
import { inviteEmailStatus, inviteStatus } from "@/lib/customer-invites";
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

  const archivedParam = new URL(request.url).searchParams.get("archived");
  if (archivedParam !== null && archivedParam !== "true" && archivedParam !== "false") {
    return Response.json(
      { ok: false, errors: [{ field: "archived", message: "archived must be true or false" }] },
      { status: 400 }
    );
  }
  const archived = archivedParam === "true";

  try {
    const clients = await prisma.client.findMany({
      // Active clients by default, so archived ones never appear in client selection.
      where: { archivedAt: archived ? { not: null } : null },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { invoices: true, customers: true } },
        customerInvites: {
          select: { usedAt: true, revokedAt: true, expiresAt: true, emailState: true, emailStateAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    // Customer Portal summary for the Clients page: linked accounts and the latest invite's state.
    const now = new Date();
    const data = clients.map(({ customerInvites, ...client }) => ({
      ...client,
      portal: {
        linkedAccounts: client._count.customers,
        latestInvite: customerInvites[0]
          ? { status: inviteStatus(customerInvites[0], now), email: inviteEmailStatus(customerInvites[0], now) }
          : null,
      },
    }));
    return Response.json({ ok: true, data });
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
