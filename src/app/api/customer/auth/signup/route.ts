/**
 * POST /api/customer/auth/signup — create a Customer Portal account.
 * Body: { name, email, password }
 *
 * Always answers the same way for a valid request (whether or not the email
 * is already registered) and never signs in, so it cannot be used to discover
 * accounts. Signing up never links a client: invitations are accepted
 * explicitly afterwards on /portal/invite (see customer-invites).
 */

import { SIGNUP_ACCEPTED_MESSAGE, signupCustomer, validateSignup } from "@/lib/customer-auth";
import { readJsonBody } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const parsed = await readJsonBody(request, 8 * 1024);
  if (!parsed.ok) return parsed.response;

  const input = validateSignup(parsed.body);
  if (!input.ok) return Response.json({ ok: false, errors: input.errors }, { status: 422 });

  try {
    const result = await signupCustomer(input);
    if (result.kind === "throttled") return result.response;
    return Response.json({ ok: true, message: SIGNUP_ACCEPTED_MESSAGE }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[POST /api/customer/auth/signup]", err);
    return serverErrorResponse();
  }
}
