/**
 * DELETE /api/clients/[id]/invites/[inviteId] — owner only: revoke an unused
 * invite so its link stops working. The row is kept as history. The invite
 * must belong to the client in the path (no cross-client IDOR); accepted
 * invites cannot be revoked (unlinking an account is a separate decision).
 */

import { requireOwner } from "@/lib/auth";
import { InviteError, revokeInvite, toInviteView } from "@/lib/customer-invites";
import { rejectCrossSite } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/clients/[id]/invites/[inviteId]">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  const params = await ctx.params;
  const clientId = parseId(params.id);
  const inviteId = parseId(params.inviteId);
  if (clientId === null || inviteId === null) {
    return Response.json({ ok: false, error: "ids must be positive integers" }, { status: 400 });
  }

  try {
    const row = await revokeInvite(clientId, inviteId);
    return Response.json({ ok: true, data: { invite: toInviteView(row) } });
  } catch (err) {
    if (err instanceof InviteError) return Response.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    console.error(`[DELETE /api/clients/${clientId}/invites/${inviteId}]`, err);
    return serverErrorResponse();
  }
}
