/**
 * Single-owner authentication for the hackathon demo.
 *
 * There are no user accounts: one owner password unlocks the whole app, and
 * every signed-in session is that owner. All clients and invoices are shared
 * data. This is NOT multi-tenant and must not be presented as isolating
 * separate businesses.
 *
 * - The password is never stored: OWNER_PASSWORD_HASH holds a scrypt hash
 *   (generate it with `npm run auth:setup`).
 * - A successful login issues an iron-session cookie, encrypted and
 *   integrity-protected with AUTH_SECRET, HttpOnly and SameSite=Lax, valid
 *   for SESSION_TTL_SECONDS. It records a fingerprint of the password hash,
 *   so changing the password signs out every existing session.
 * - Every protected route handler calls requireOwner() itself. src/proxy.ts
 *   adds page redirects and a second check in front of /api, but is never
 *   the only gate.
 * - Missing or weak configuration fails closed (503), never open.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { getIronSession, webCookies, type SessionOptions } from "iron-session";

export const SESSION_COOKIE = "cc_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;
export const MAX_PASSWORD_LENGTH = 1024;

type OwnerSession = { owner?: true; pwv?: string };

export type AuthConfig =
  | { ok: true; secret: string; passwordHash: string }
  | { ok: false; reason: string };

// ── Password hashing (scrypt) ─────────────────────────────────────────────
// Format: scrypt:<N>:<r>:<p>:<salt base64url>:<key base64url>. No "$", which
// Next's .env loader would try to expand.

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;

function scryptAsync(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...options, maxmem: 128 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join(":");
}

function parseHash(stored: string): { N: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Bounds keep a malformed hash from requesting absurd CPU or memory.
  if (!Number.isInteger(Math.log2(N)) || N < 2 ** 14 || N > 2 ** 20) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");
  if (salt.length < 16 || key.length !== KEY_LENGTH) return null;
  return { N, r, p, salt, key };
}

export function isValidPasswordHash(stored: string): boolean {
  return parseHash(stored) !== null;
}

/** Constant-time check of `password` against a stored scrypt hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  const { salt, key, ...params } = parsed;
  const candidate = await scryptAsync(password, salt, params);
  return timingSafeEqual(candidate, key);
}

// ── Configuration ─────────────────────────────────────────────────────────

/** Reads auth settings per call, so tests and config changes apply immediately. */
export function getAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const secret = env.AUTH_SECRET ?? "";
  const passwordHash = (env.OWNER_PASSWORD_HASH ?? "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, reason: `AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters` };
  }
  if (!isValidPasswordHash(passwordHash)) {
    return { ok: false, reason: "OWNER_PASSWORD_HASH is missing or malformed (run npm run auth:setup)" };
  }
  return { ok: true, secret, passwordHash };
}

/** Short fingerprint of the password hash; rotating the password invalidates sessions. */
function passwordVersion(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("base64url").slice(0, 16);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function sessionOptions(config: { secret: string }, requestUrl: string): SessionOptions {
  return {
    cookieName: SESSION_COOKIE,
    password: config.secret,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // Plain http is only acceptable on this machine; tunnels and
      // deployments are https, where the cookie must never travel in clear.
      secure: !LOOPBACK_HOSTS.has(new URL(requestUrl).hostname),
    },
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────

function authResponse(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

/** True when the request carries a valid, unexpired owner session. */
export async function isOwnerRequest(request: Request, config = getAuthConfig()): Promise<boolean> {
  if (!config.ok) return false;
  const session = await getIronSession<OwnerSession>(
    webCookies(request, new Headers()),
    sessionOptions(config, request.url)
  );
  return session.owner === true && session.pwv === passwordVersion(config.passwordHash);
}

/**
 * Route-handler guard: returns the error response to send (401, or 503 when
 * auth is not configured), or null when the owner is signed in.
 */
export async function requireOwner(request: Request): Promise<Response | null> {
  // Touch the request first: under Cache Components this stops build-time
  // prerendering, so no response (not even a 503) is ever baked in statically.
  const hasCookie = request.headers.has("cookie");
  const config = getAuthConfig();
  if (!config.ok) {
    console.error(`[auth] ${config.reason}`);
    return authResponse(503, "Authentication is not configured on the server");
  }
  if (!hasCookie || !(await isOwnerRequest(request, config))) {
    return authResponse(401, "Authentication required");
  }
  return null;
}

/** Writes a fresh owner session cookie to `headers`. */
export async function startOwnerSession(
  request: Request,
  headers: Headers,
  config: { secret: string; passwordHash: string }
): Promise<void> {
  const session = await getIronSession<OwnerSession>(webCookies(request, headers), sessionOptions(config, request.url));
  session.owner = true;
  session.pwv = passwordVersion(config.passwordHash);
  await session.save();
}

/** Writes an expired session cookie to `headers`. */
export function endOwnerSession(request: Request, headers: Headers): void {
  const secure = LOOPBACK_HOSTS.has(new URL(request.url).hostname) ? "" : "; Secure";
  headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
}

// ── Login throttling ──────────────────────────────────────────────────────
// One owner, one in-memory counter: after MAX_FAILURES wrong passwords in a
// window, login is refused until the window ends. Deliberately global (not
// per IP, which a client can spoof via X-Forwarded-For); the trade-off is that
// an attacker can delay the owner's login, but cannot brute-force it.

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
let failures: number[] = [];

export const loginThrottle = {
  /** Seconds until another attempt is allowed, or 0. */
  retryAfter(now = Date.now()): number {
    failures = failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    if (failures.length < MAX_FAILURES) return 0;
    return Math.ceil((failures[0] + FAILURE_WINDOW_MS - now) / 1000);
  },
  recordFailure(now = Date.now()): void {
    failures.push(now);
  },
  reset(): void {
    failures = [];
  },
  MAX_FAILURES,
};
