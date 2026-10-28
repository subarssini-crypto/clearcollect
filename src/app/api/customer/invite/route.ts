/**
 * POST /api/customer/invite — redeem an owner invite for the signed-in
 * customer. Body: { token }
 */

import { requireCustomer } from "@/lib/customer-auth";
import { REDEEM_MESSAGES, redeemInvite } from "@/lib/customer-invites";
import { readJsonBody } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const parsed = await readJsonBody(request, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  try {
    const auth = await requireCustomer(request);
    if ("response" in auth) return auth.response;
    const token = typeof parsed.body === "object" && parsed.body !== null ? (parsed.body as { token?: unknown }).token : undefined;
    const result = await redeemInvite(auth.customer.id, token);
    if (result === "linked") return Response.json({ ok: true, data: { result, message: REDEEM_MESSAGES.linked } });
    return Response.json({ ok: false, data: { result }, error: REDEEM_MESSAGES[result] }, { status: result === "invalid" ? 400 : 409 });
  } catch (err) {
    console.error("[POST /api/customer/invite]", err);
    return serverErrorResponse();
  }
}
