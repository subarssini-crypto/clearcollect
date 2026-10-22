/**
 * POST /api/auth/logout — clear the owner session cookie.
 * Cross-site requests are refused so another site cannot sign the owner out.
 */

import { endOwnerSession } from "@/lib/auth";
import { rejectCrossSite } from "@/lib/request";

export async function POST(request: Request): Promise<Response> {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  const headers = new Headers({ "cache-control": "no-store" });
  endOwnerSession(request, headers);
  return Response.json({ ok: true }, { headers });
}
