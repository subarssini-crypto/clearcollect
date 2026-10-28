/**
 * Owner-only Customer Portal invite management for one client.
 *
 * GET  /api/clients/[id]/invites — the client's invites with derived status
 *      (pending/accepted/expired/revoked), email status, linked accounts, and
 *      whether invitation email delivery is configured.
 * POST /api/clients/[id]/invites — body { "send": boolean, "regenerate"?: boolean }
 *      Creates a single-use, 7-day invite (409 if one is already pending,
 *      unless regenerate revokes it first), optionally emails it via Zapier,
 *      and returns the link once. Only a hash of the token is stored.
 *
 * The link origin is APP_URL (or localhost in development), never the Host
 * header; the email recipient is always the client's stored email.
 */

import { requireOwner } from "@/lib/auth";
import { InviteError, createInvite, inviteUrl, listInvites, toInviteView } from "@/lib/customer-invites";
import { inviteEmailDelivery, sendInviteEmail, type InviteEmailOutcome } from "@/lib/customer-invite-email";
import { describePaymentError, getPaymentReturnOrigin } from "@/lib/paypal";
import { readJsonBody } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";

const NO_STORE = { "cache-control": "no-store" };

function parseId(raw: string): number | null {
  const id = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(request: Request, ctx: RouteContext<"/api/clients/[id]/invites">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });

  try {
    const data = await listInvites(id);
    if (!data) return Response.json({ ok: false, error: `Client ${id} not found` }, { status: 404 });
    const delivery = inviteEmailDelivery();
    return Response.json({ ok: true, data: { ...data, delivery: { mode: delivery.mode, detail: delivery.detail } } }, { headers: NO_STORE });
  } catch (err) {
    console.error(`[GET /api/clients/${id}/invites]`, err);
    return serverErrorResponse();
  }
}

export async function POST(request: Request, ctx: RouteContext<"/api/clients/[id]/invites">): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });

  const parsed = await readJsonBody(request, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = (typeof parsed.body === "object" && parsed.body !== null && !Array.isArray(parsed.body) ? parsed.body : null) as Record<string, unknown> | null;
  if (!body || typeof body.send !== "boolean" || (body.regenerate !== undefined && typeof body.regenerate !== "boolean")) {
    return Response.json({ ok: false, errors: [{ field: "send", message: "send must be true or false; regenerate is an optional boolean" }] }, { status: 422 });
  }

  try {
    const origin = getPaymentReturnOrigin(request.url);
    const { token, invite, client } = await createInvite(id, { regenerate: body.regenerate === true });
    const url = inviteUrl(origin, token);
    const email: InviteEmailOutcome = body.send
      ? await sendInviteEmail(invite, client, url)
      : { result: "not_requested", detail: "No email was sent. Copy the link and share it with your client." };
    const current = (await listInvites(id))?.invites.find((i) => i.id === invite.id) ?? toInviteView(invite);
    return Response.json({ ok: true, data: { invite: current, url, email } }, { status: 201, headers: NO_STORE });
  } catch (err) {
    if (err instanceof InviteError) return Response.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    const { status, message } = describePaymentError(err); // APP_URL problems
    if (status >= 500) console.error(`[POST /api/clients/${id}/invites]`, err);
    return Response.json({ ok: false, error: message }, { status });
  }
}
