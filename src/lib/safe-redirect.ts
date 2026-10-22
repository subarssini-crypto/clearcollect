/**
 * Validates a post-login `next` target. Only same-origin paths are allowed,
 * so /login?next=https://evil.example (or //evil.example, /\evil.example)
 * cannot turn the login page into an open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  try {
    const base = "http://clearcollect.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base || url.pathname === "/login") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
