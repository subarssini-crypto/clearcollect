/**
 * POST /api/customer/auth/reset-password — set a new password with a reset link.
 * Body: { token, password }
 *
 * Valid once, until the link expires; a successful reset signs the account
 * out everywhere and does not sign in (see src/lib/customer-password-reset.ts).
 */

import { RESET_INVALID_MESSAGE, resetPasswordWithToken } from "@/lib/customer-password-reset";
import { readJsonBody } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const parsed = await readJsonBody(request, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = (typeof parsed.body === "object" && parsed.body !== null ? parsed.body : {}) as Record<string, unknown>;
  const headers = { "cache-control": "no-store" };

  try {
    const result = await resetPasswordWithToken(body.token, body.password);
    switch (result.kind) {
      case "ok":
        return Response.json({ ok: true, message: "Your password has been reset. Sign in with your new password." }, { headers });
      case "invalid_password":
        return Response.json({ ok: false, errors: [{ field: "password", message: result.message }] }, { status: 422, headers });
      case "throttled":
        return Response.json(
          { ok: false, error: "Too many password reset attempts. Try again later." },
          { status: 429, headers: { ...headers, "retry-after": String(result.retryAfter) } }
        );
      default:
        return Response.json({ ok: false, error: RESET_INVALID_MESSAGE }, { status: 400, headers });
    }
  } catch (err) {
    console.error("[POST /api/customer/auth/reset-password]", err);
    return serverErrorResponse();
  }
}
