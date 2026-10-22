/**
 * GET /api/auth/status — lets /login show a setup-required state.
 * Public, read-only, and reveals only two booleans: whether owner sign-in
 * is configured on the server and whether this browser is signed in. Never
 * returns secret values, hashes, or which setting is wrong.
 */

import { getAuthConfig, isOwnerRequest } from "@/lib/auth";

export async function GET(request: Request): Promise<Response> {
  // Reading the session cookie also keeps this out of build-time prerendering.
  const signedIn = await isOwnerRequest(request);
  const configured = getAuthConfig().ok;
  return Response.json(
    { ok: true, data: { configured, signedIn } },
    { headers: { "cache-control": "no-store" } }
  );
}
