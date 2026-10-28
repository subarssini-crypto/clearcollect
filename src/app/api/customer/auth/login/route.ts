/**
 * POST /api/customer/auth/login — sign in to the Customer Portal.
 * Body: { email, password }
 *
 * Wrong email and wrong password get the same 401. Signing in never links a
 * client: an invited customer is sent on to /portal/invite to accept explicitly.
 */

import { loginCustomer } from "@/lib/customer-auth";
import { readJsonBody } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const parsed = await readJsonBody(request, 8 * 1024);
  if (!parsed.ok) return parsed.response;
  const body = (typeof parsed.body === "object" && parsed.body !== null ? parsed.body : {}) as Record<string, unknown>;

  try {
    const headers = new Headers({ "cache-control": "no-store" });
    const result = await loginCustomer(request, headers, body.email, body.password);
    if (result.kind === "throttled") return result.response;
    if (result.kind === "invalid") {
      return Response.json({ ok: false, error: "Incorrect email or password" }, { status: 401 });
    }
    return Response.json({ ok: true }, { headers });
  } catch (err) {
    console.error("[POST /api/customer/auth/login]", err);
    return serverErrorResponse();
  }
}
