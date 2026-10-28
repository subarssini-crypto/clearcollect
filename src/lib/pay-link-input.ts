const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The payment token from a pasted /pay/<token> link on this site (or a bare
 * token), else null. Invoice numbers and IDs are never accepted: on their own
 * they grant no access.
 */
export function extractPayToken(raw: string, origin: string): string | null {
  const value = raw.trim();
  if (TOKEN.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin !== origin) return null;
    const match = /^\/pay\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
