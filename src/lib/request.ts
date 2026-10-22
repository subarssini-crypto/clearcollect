/**
 * Request guards for API route handlers.
 *
 * - Cross-site protection: browsers label every request with Sec-Fetch-Site.
 *   Anything other than a same-origin (or user-initiated) request is refused,
 *   and JSON endpoints require Content-Type: application/json. A cross-site
 *   page can only send that content type after a CORS preflight, which this
 *   app never approves — so another website cannot drive these endpoints
 *   (e.g. a text/plain form POST to http://localhost:3000/api/follow-ups/send).
 *   Non-browser clients (curl, server-to-server) send no Sec-Fetch-Site.
 * - Size limits: bodies are read incrementally and abandoned once they exceed
 *   the limit, instead of buffering an arbitrarily large payload in memory.
 */

export const MAX_JSON_BODY_BYTES = 100 * 1024;

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

function errorResponse(status: number, message: string): Response {
  // Both shapes used by existing routes: `error` and `errors[]`.
  return Response.json({ ok: false, error: message, errors: [{ field: "body", message }] }, { status });
}

/** Returns a 403 response for a cross-site browser request, otherwise null. */
export function rejectCrossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && !ALLOWED_FETCH_SITES.has(site.toLowerCase())) {
    return errorResponse(403, "Cross-site requests are not allowed");
  }
  return null;
}

/** Reads the body as UTF-8 text, or returns null if it exceeds `maxBytes`. */
export async function readBodyText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Validates origin and content type, then reads and parses a JSON body within
 * the size limit. On failure returns the error response to send.
 */
export async function readJsonBody(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonBodyResult> {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return { ok: false, response: crossSite };

  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return { ok: false, response: errorResponse(415, "Content-Type must be application/json") };
  }

  const text = await readBodyText(request, maxBytes);
  if (text === null) {
    return { ok: false, response: errorResponse(413, `Request body must be ${maxBytes} bytes or fewer`) };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: errorResponse(400, "Request body must be valid JSON") };
  }
}
