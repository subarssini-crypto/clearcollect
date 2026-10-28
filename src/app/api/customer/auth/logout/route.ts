/**
 * POST /api/customer/auth/logout — end the customer's sessions (all devices)
 * and clear the cookie. Never touches the owner session.
 */

import { endCustomerSession } from "@/lib/customer-auth";
import { rejectCrossSite } from "@/lib/request";
import { serverErrorResponse } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const headers = new Headers({ "cache-control": "no-store" });
    await endCustomerSession(request, headers);
    return Response.json({ ok: true }, { headers });
  } catch (err) {
    console.error("[POST /api/customer/auth/logout]", err);
    return serverErrorResponse();
  }
}
