/**
 * Customer Portal authentication — separate from the single owner login
 * (src/lib/auth.ts).
 *
 * - Passwords use the same scrypt hashing as the owner password.
 * - Sessions are iron-session cookies named cc_customer, sealed with a key
 *   derived from AUTH_SECRET for this purpose only, so an owner cookie can
 *   never be read as a customer cookie or the other way round. A session
 *   stores only the customer's row ID and sessionVersion; every request
 *   reloads the customer from MySQL, and logout bumps sessionVersion so all
 *   earlier cookies stop working.
 * - No account enumeration: signup answers the same way whether or not the
 *   email is registered (and never signs in), login failures share one
 *   message, and unknown emails still pay for a password hash.
 * - Login failures are limited per email and globally; signups globally.
 * - Forgotten passwords: src/lib/customer-password-reset.ts.
 * - An account's Client link is never derived from its email; see
 *   src/lib/customer-invites.ts.
 */

import { createHash } from "node:crypto";
import { getIronSession, webCookies, type SessionOptions } from "iron-session";
import { prisma } from "@/lib/prisma";
import { MAX_PASSWORD_LENGTH, MIN_SECRET_LENGTH, SESSION_TTL_SECONDS, hashPassword, secureCookieFor, verifyPassword } from "@/lib/auth";
import { createLimiter } from "@/lib/rate-limit";
import { validRecipient } from "@/lib/zapier";

export const CUSTOMER_COOKIE = "cc_customer";
export const MIN_CUSTOMER_PASSWORD_LENGTH = 8;
export const MAX_NAME_LENGTH = 100;

type CustomerSession = { cid?: number; sv?: number };

export type SessionCustomer = { id: number; name: string; email: string; clientId: number | null };

// ── Configuration ─────────────────────────────────────────────────────────

function customerSessionKey(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.AUTH_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return null;
  return createHash("sha256").update(`clearcollect:customer-session:v1:${secret}`).digest("hex");
}

function sessionOptions(key: string, requestUrl: string): SessionOptions {
  return {
    cookieName: CUSTOMER_COOKIE,
    password: key,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: { httpOnly: true, sameSite: "lax", path: "/", secure: secureCookieFor(requestUrl) },
  };
}

function jsonError(status: number, error: string, headers?: HeadersInit): Response {
  return Response.json({ ok: false, error }, { status, headers });
}

// ── Sessions ──────────────────────────────────────────────────────────────

/** The signed-in customer, or null (no/invalid/expired/revoked session). */
export async function getCustomer(request: Request): Promise<SessionCustomer | null> {
  const key = customerSessionKey();
  if (!key || !request.headers.has("cookie")) return null;
  const session = await getIronSession<CustomerSession>(webCookies(request, new Headers()), sessionOptions(key, request.url));
  if (!Number.isSafeInteger(session.cid) || !Number.isSafeInteger(session.sv)) return null;
  const customer = await prisma.customer.findUnique({
    where: { id: session.cid },
    select: { id: true, name: true, email: true, clientId: true, sessionVersion: true },
  });
  if (!customer || customer.sessionVersion !== session.sv) return null;
  return { id: customer.id, name: customer.name, email: customer.email, clientId: customer.clientId };
}

/**
 * Route guard: the signed-in customer, or the response to send (401, or 503
 * when AUTH_SECRET is not configured).
 */
export async function requireCustomer(request: Request): Promise<{ customer: SessionCustomer } | { response: Response }> {
  // Touch the request first (as requireOwner does): under Cache Components this
  // stops build-time prerendering, so no response is ever baked in statically.
  request.headers.has("cookie");
  if (!customerSessionKey()) return { response: jsonError(503, "Customer sign-in is not configured on the server") };
  const customer = await getCustomer(request);
  return customer ? { customer } : { response: jsonError(401, "Please sign in to the Customer Portal") };
}

async function startCustomerSession(request: Request, headers: Headers, customer: { id: number; sessionVersion: number }): Promise<void> {
  const key = customerSessionKey();
  if (!key) throw new Error("customer session key unavailable");
  const session = await getIronSession<CustomerSession>(webCookies(request, headers), sessionOptions(key, request.url));
  session.cid = customer.id;
  session.sv = customer.sessionVersion;
  await session.save();
}

/** Revokes every session of the signed-in customer (if any) and clears the cookie. */
export async function endCustomerSession(request: Request, headers: Headers): Promise<void> {
  const customer = await getCustomer(request);
  if (customer) {
    await prisma.customer.update({ where: { id: customer.id }, data: { sessionVersion: { increment: 1 } } });
  }
  const secure = secureCookieFor(request.url) ? "; Secure" : "";
  headers.append("set-cookie", `${CUSTOMER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
}

// ── Validation ────────────────────────────────────────────────────────────

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return validRecipient(raw.trim().toLowerCase());
}

type FieldError = { field: string; message: string };

export function validateSignup(body: unknown): { ok: true; name: string; email: string; password: string } | { ok: false; errors: FieldError[] } {
  const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const errors: FieldError[] = [];
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) errors.push({ field: "name", message: `Enter your name (up to ${MAX_NAME_LENGTH} characters)` });
  const email = normalizeEmail(b.email);
  if (!email) errors.push({ field: "email", message: "Enter a valid email address" });
  const password = typeof b.password === "string" ? b.password : "";
  if (password.length < MIN_CUSTOMER_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    errors.push({ field: "password", message: `Use a password of at least ${MIN_CUSTOMER_PASSWORD_LENGTH} characters` });
  }
  return errors.length ? { ok: false, errors } : { ok: true, name, email: email!, password };
}

// ── Throttling ────────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60 * 1000;
export const customerThrottles = {
  loginPerEmail: createLimiter({ max: 5, windowMs: WINDOW_MS }),
  loginGlobal: createLimiter({ max: 100, windowMs: WINDOW_MS }),
  signupGlobal: createLimiter({ max: 30, windowMs: WINDOW_MS }),
  // Password reset (src/lib/customer-password-reset.ts)
  resetRequestPerEmail: createLimiter({ max: 3, windowMs: WINDOW_MS }),
  resetRequestGlobal: createLimiter({ max: 50, windowMs: WINDOW_MS }),
  resetSubmitGlobal: createLimiter({ max: 50, windowMs: WINDOW_MS }),
  reset() {
    this.loginPerEmail.reset();
    this.loginGlobal.reset();
    this.signupGlobal.reset();
    this.resetRequestPerEmail.reset();
    this.resetRequestGlobal.reset();
    this.resetSubmitGlobal.reset();
  },
};

function tooMany(retryAfter: number, what: string): Response {
  return jsonError(429, `Too many ${what} attempts. Try again later.`, { "retry-after": String(retryAfter) });
}

// ── Signup and login ──────────────────────────────────────────────────────

/**
 * Same body for every accepted signup, new email or not. It must say that an
 * existing account keeps its password: a repeat signup changes nothing, so a
 * customer who "signs up again" with a new password can only sign in with the
 * original one.
 */
export const SIGNUP_ACCEPTED_MESSAGE =
  "If this email address was not registered yet, your account is ready. " +
  "If it already had an account, nothing was changed and its existing password still applies. Sign in to continue.";

let dummyHash: Promise<string> | null = null;
/** A real hash to verify against for unknown emails, so timing does not reveal accounts. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("clearcollect-dummy-password-never-valid");
  return dummyHash;
}

export type SignupResult = { kind: "accepted"; createdCustomerId: number | null } | { kind: "throttled"; response: Response };

/**
 * Creates the account if the email is free. Callers must answer identically
 * either way (SIGNUP_ACCEPTED_MESSAGE); `createdCustomerId` is for linking an
 * invite to a brand-new account only and must never shape the response.
 */
export async function signupCustomer(input: { name: string; email: string; password: string }): Promise<SignupResult> {
  const retryAfter = customerThrottles.signupGlobal.retryAfter("*");
  if (retryAfter > 0) return { kind: "throttled", response: tooMany(retryAfter, "sign-up") };
  customerThrottles.signupGlobal.record("*");

  // Hash first in every case so the response time does not depend on the email.
  const passwordHash = await hashPassword(input.password);
  try {
    const created = await prisma.customer.create({
      data: { email: input.email, name: input.name, passwordHash },
      select: { id: true },
    });
    return { kind: "accepted", createdCustomerId: created.id };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { kind: "accepted", createdCustomerId: null };
    throw err;
  }
}

export type LoginResult =
  | { kind: "ok"; customer: SessionCustomer }
  | { kind: "invalid" }
  | { kind: "throttled"; response: Response };

/** Checks credentials and, on success, writes the session cookie to `headers`. */
export async function loginCustomer(request: Request, headers: Headers, rawEmail: unknown, password: unknown): Promise<LoginResult> {
  const email = normalizeEmail(rawEmail) ?? "";
  const perEmail = email ? customerThrottles.loginPerEmail.retryAfter(email) : 0;
  const global = customerThrottles.loginGlobal.retryAfter("*");
  if (perEmail > 0 || global > 0) return { kind: "throttled", response: tooMany(Math.max(perEmail, global), "sign-in") };

  const validPassword = typeof password === "string" && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
  const customer = email
    ? await prisma.customer.findUnique({
        where: { email },
        select: { id: true, name: true, email: true, clientId: true, passwordHash: true, sessionVersion: true },
      })
    : null;
  const matches = await verifyPassword(validPassword ? password : "x", customer?.passwordHash ?? (await getDummyHash()));

  if (!customer || !validPassword || !matches) {
    if (email) customerThrottles.loginPerEmail.record(email);
    customerThrottles.loginGlobal.record("*");
    return { kind: "invalid" };
  }
  customerThrottles.loginPerEmail.reset(email);
  await startCustomerSession(request, headers, customer);
  return { kind: "ok", customer: { id: customer.id, name: customer.name, email: customer.email, clientId: customer.clientId } };
}
