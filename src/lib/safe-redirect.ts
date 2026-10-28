/**
 * Validates a post-login `next` target. Only same-origin paths are allowed,
 * so /login?next=https://evil.example (or //evil.example, /\evil.example)
 * cannot turn the login page into an open redirect.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  try {
    const base = "http://clearcollect.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base || url.pathname === "/login") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** Post-login target for the Customer Portal: a safe path inside /portal, else /portal. */
export function safePortalPath(raw: string | null | undefined): string {
  const path = safeNextPath(raw, "/portal");
  const pathname = path.split(/[?#]/)[0];
  const inPortal = pathname === "/portal" || pathname.startsWith("/portal/");
  return inPortal && !["/portal/login", "/portal/signup"].includes(pathname) ? path : "/portal";
}
