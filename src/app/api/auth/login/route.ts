/**
 * POST /api/auth/login — exchange the owner password for a session cookie.
 * Body: { "password": string }
 *
 * Same cross-site and JSON guards as every other endpoint, so another site
 * cannot sign the browser in (login CSRF). Repeated failures are throttled.
 */

import { getAuthConfig, loginThrottle, MAX_PASSWORD_LENGTH, startOwnerSession, verifyPassword } from "@/lib/auth";
import { readJsonBody } from "@/lib/request";

export async function POST(request: Request): Promise<Response> {
  const parsed = await readJsonBody(request, 4 * 1024);
  if (!parsed.ok) return parsed.response;

  const config = getAuthConfig();
  if (!config.ok) {
    console.error(`[auth] ${config.reason}`);
    return Response.json({ ok: false, error: "Authentication is not configured on the server" }, { status: 503 });
  }

  const retryAfter = loginThrottle.retryAfter();
  if (retryAfter > 0) {
    return Response.json(
      { ok: false, error: "Too many failed sign-in attempts. Try again later." },
      { status: 429, headers: { "retry-after": String(retryAfter) } }
    );
  }

  const password = (parsed.body as { password?: unknown } | null)?.password;
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return Response.json(
      { ok: false, errors: [{ field: "password", message: "password is required" }] },
      { status: 422 }
    );
  }

  if (!(await verifyPassword(password, config.passwordHash))) {
    loginThrottle.recordFailure();
    console.warn("[auth] failed sign-in attempt");
    return Response.json({ ok: false, error: "Incorrect password" }, { status: 401 });
  }

  loginThrottle.reset();
  const headers = new Headers({ "cache-control": "no-store" });
  await startOwnerSession(request, headers, config);
  return Response.json({ ok: true }, { headers });
}
