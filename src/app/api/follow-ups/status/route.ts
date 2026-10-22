/**
 * GET /api/follow-ups/status — which delivery mode is active
 * ("zapier" | "demo" | "misconfigured"). Never returns the URL or secret.
 */

import { requireOwner } from "@/lib/auth";
import { getZapierConfig } from "@/lib/follow-up";

export async function GET(request: Request): Promise<Response> {
  // The session check reads the request's cookies, which also keeps this
  // handler out of build-time prerendering: configuration is evaluated per
  // request, so changes apply without a rebuild.
  const denied = await requireOwner(request);
  if (denied) return denied;

  const config = getZapierConfig();
  const delivery = config.state === "configured" ? "zapier" : config.state;
  return Response.json({ ok: true, data: { delivery, aiConfigured: Boolean(process.env.GEMINI_API_KEY) } });
}
