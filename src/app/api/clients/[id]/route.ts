/**
 * PATCH /api/clients/[id] — archive or restore a client.
 * Body: { "archived": boolean }.
 *
 * Only Client.archivedAt changes. Invoices, payments, reminders, and every
 * other relationship are untouched; archived clients are just hidden from
 * client selection for new invoices (GET /api/clients, POST /api/invoices,
 * AI drafting). The update is conditional, so repeated or concurrent
 * requests are harmless.
 */

import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/request";
import { notFoundResponse, serverErrorResponse } from "@/lib/validation";

const CLIENT_SELECT = { id: true, name: true, email: true, company: true, archivedAt: true, _count: { select: { invoices: true } } } as const;

export async function PATCH(request: Request, ctx: RouteContext<"/api/clients/[id]">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const { id: rawId } = await ctx.params;
  const id = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id < 1) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const archived = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { archived?: unknown }).archived : undefined;
  if (typeof archived !== "boolean") {
    return Response.json({ ok: false, errors: [{ field: "archived", message: "archived must be true or false" }] }, { status: 422 });
  }

  try {
    const { count } = await prisma.client.updateMany({
      where: { id, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null },
    });
    const client = await prisma.client.findUnique({ where: { id }, select: CLIENT_SELECT });
    if (!client) return notFoundResponse(`Client ${id} not found`);

    const message =
      count === 1
        ? `${client.name} ${archived ? "archived" : "restored"}.`
        : `${client.name} was already ${archived ? "archived" : "active"}.`;
    return Response.json({ ok: true, message, data: client });
  } catch (err) {
    console.error(`[PATCH /api/clients/${id}]`, err);
    return serverErrorResponse();
  }
}
