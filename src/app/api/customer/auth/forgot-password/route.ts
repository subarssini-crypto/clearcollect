/**
 * POST /api/customer/auth/forgot-password — request a password reset link.
 * Body: { email }
 *
 * Answers the same way for every valid email, registered or not, and sends
 * the email only after the response (next/server `after`), so neither the body
 * nor the response time reveals whether an account exists.
 */

import { after } from "next/server";
import { normalizeEmail } from "@/lib/customer-auth";
import { RESET_REQUESTED_MESSAGE, sendPasswordResetEmail, throttleResetRequest } from "@/lib/customer-password-reset";
import { getPaymentReturnOrigin } from "@/lib/paypal";
import { readJsonBody } from "@/lib/request";

export async function POST(request: Request): Promise<Response> {
  const parsed = await readJsonBody(request, 4 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = (typeof parsed.body === "object" && parsed.body !== null ? parsed.body : {}) as Record<string, unknown>;

  const email = normalizeEmail(body.email);
  if (!email) return Response.json({ ok: false, errors: [{ field: "email", message: "Enter a valid email address" }] }, { status: 422 });

  const retryAfter = throttleResetRequest(email);
  if (retryAfter > 0) {
    return Response.json(
      { ok: false, error: "Too many password reset requests. Try again later." },
      { status: 429, headers: { "retry-after": String(retryAfter) } }
    );
  }

  let origin: string | null = null;
  try {
    origin = getPaymentReturnOrigin(request.url); // APP_URL, or localhost in development; never the Host header
  } catch {
    origin = null; // logged by sendPasswordResetEmail only if the account exists
  }
  after(() => sendPasswordResetEmail(email, origin));
  return Response.json({ ok: true, message: RESET_REQUESTED_MESSAGE }, { headers: { "cache-control": "no-store" } });
}
