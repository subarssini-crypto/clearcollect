/**
 * GET /api/customer/auth/invite?token=… — public preview of an invite: the
 * inviting client's display name, or 404 for unknown/expired/used invites.
 * Reveals nothing without the unguessable token.
 */

import { previewInvite } from "@/lib/customer-invites";
import { serverErrorResponse } from "@/lib/validation";

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex" };
  try {
    const invite = await previewInvite(token);
    if (!invite) {
      return Response.json({ ok: false, error: "This invite link is invalid, expired, or already used." }, { status: 404, headers });
    }
    return Response.json({ ok: true, data: invite }, { headers });
  } catch (err) {
    console.error("[GET /api/customer/auth/invite]", err);
    return serverErrorResponse();
  }
}
