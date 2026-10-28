/**
 * Customer Portal "Forgot password?" flow.
 *
 * - Reset tokens are stateless, so nothing is stored (no table, no plaintext,
 *   no hash): `<customerId>.<expiresAtMs>.<sig>`, where sig is an HMAC-SHA256,
 *   keyed from AUTH_SECRET for this purpose only, over the id, the expiry and
 *   the account's current passwordHash.
 * - Expiring: the signed expiry is checked (PASSWORD_RESET_TTL_MS).
 * - Single-use: a successful reset stores a new hash (fresh salt), which
 *   invalidates every earlier link. The update is conditional on the old hash,
 *   so two concurrent submissions of one link cannot both succeed.
 * - A successful reset bumps sessionVersion, signing out every existing
 *   session (the same mechanism as logout).
 * - Requests never reveal whether an email has an account: the route answers
 *   the same way for every valid email and sends the email after responding.
 * - The link origin is APP_URL (or localhost in development), never the Host
 *   header; the recipient is always the account's stored email.
 *
 * Email setup: a "Webhooks by Zapier → Catch Hook" Zap → Filter on auth_token
 * (= ZAPIER_WEBHOOK_SECRET) → Gmail: To = recipient_email, Subject = subject,
 * Body = message, with its URL in ZAPIER_PASSWORD_RESET_WEBHOOK_URL.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { MAX_PASSWORD_LENGTH, MIN_SECRET_LENGTH, hashPassword } from "@/lib/auth";
import { MIN_CUSTOMER_PASSWORD_LENGTH, customerThrottles, normalizeEmail } from "@/lib/customer-auth";
import { getZapierConfig, postToZapier } from "@/lib/zapier";

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const RESET_WEBHOOK_URL_VAR = "ZAPIER_PASSWORD_RESET_WEBHOOK_URL";

/** Same body for every accepted request, whether or not the email has an account. */
export const RESET_REQUESTED_MESSAGE =
  "If an account exists for this email address, we've sent a link to reset its password. The link expires in 60 minutes.";
export const RESET_INVALID_MESSAGE = "This password reset link is invalid or has expired. Request a new one.";

const TOKEN_PATTERN = /^([1-9]\d{0,9})\.(\d{13})\.([A-Za-z0-9_-]{43})$/;

function resetKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const secret = env.AUTH_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return null;
  return createHash("sha256").update(`clearcollect:customer-password-reset:v1:${secret}`).digest();
}

function sign(key: Buffer, id: number, expiresAt: number, passwordHash: string): string {
  return createHmac("sha256", key).update(`${id}|${expiresAt}|${passwordHash}`).digest("base64url");
}

export function createResetToken(customer: { id: number; passwordHash: string }, now = Date.now()): string {
  const key = resetKey();
  if (!key) throw new Error("password reset key unavailable");
  const expiresAt = now + PASSWORD_RESET_TTL_MS;
  return `${customer.id}.${expiresAt}.${sign(key, customer.id, expiresAt, customer.passwordHash)}`;
}

export function resetUrl(origin: string, token: string): string {
  const url = new URL("/portal/reset-password", origin);
  url.searchParams.set("token", token);
  return url.toString();
}

/** The account a token is valid for right now, or null. */
async function verifyResetToken(token: unknown, now = Date.now()): Promise<{ id: number; email: string; passwordHash: string } | null> {
  const key = resetKey();
  const match = typeof token === "string" ? TOKEN_PATTERN.exec(token) : null;
  if (!key || !match) return null;
  const id = Number(match[1]);
  const expiresAt = Number(match[2]);
  if (expiresAt <= now || expiresAt > now + PASSWORD_RESET_TTL_MS) return null;
  const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true, email: true, passwordHash: true } });
  if (!customer) return null;
  const expected = Buffer.from(sign(key, id, expiresAt, customer.passwordHash));
  const given = Buffer.from(match[3]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? customer : null;
}

// ── Requesting a reset ────────────────────────────────────────────────────

export function composeResetEmail(input: { name: string; url: string }) {
  const subject = "Reset your ClearCollect Customer Portal password";
  const message = [
    `Hi ${input.name},`,
    "",
    "We received a request to reset the password for your ClearCollect Customer Portal account.",
    "",
    `Choose a new password: ${input.url}`,
    "",
    "This link works once and expires in 60 minutes. Resetting your password signs you out everywhere.",
    "",
    "If you didn't ask for this, you can ignore this email; your password stays the same.",
  ].join("\n");
  return { subject, message };
}

/**
 * Throttle check for a reset request: a 429-worthy retry-after in seconds, or
 * 0 (and the attempt is recorded). Applied identically to every email.
 */
export function throttleResetRequest(email: string): number {
  const retryAfter = Math.max(
    customerThrottles.resetRequestPerEmail.retryAfter(email),
    customerThrottles.resetRequestGlobal.retryAfter("*")
  );
  if (retryAfter > 0) return retryAfter;
  customerThrottles.resetRequestPerEmail.record(email);
  customerThrottles.resetRequestGlobal.record("*");
  return 0;
}

/**
 * Emails a reset link if `rawEmail` belongs to an account. Runs after the
 * response has been sent; never throws and never reports whether it sent.
 */
export async function sendPasswordResetEmail(
  rawEmail: unknown,
  origin: string | null,
  deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<void> {
  try {
    const email = normalizeEmail(rawEmail);
    if (!email) return;
    const customer = await prisma.customer.findUnique({ where: { email }, select: { id: true, name: true, email: true, passwordHash: true } });
    if (!customer) return;
    if (!origin) {
      console.error("[password-reset] no trusted app origin (set APP_URL); no email sent");
      return;
    }
    const url = resetUrl(origin, createResetToken(customer, (deps.now ?? Date.now)()));

    const env = deps.env ?? process.env;
    const config = getZapierConfig(env, { urlVar: RESET_WEBHOOK_URL_VAR, secretAloneIsMisconfigured: false });
    if (config.state !== "configured") {
      if (config.state === "misconfigured") console.error(`[password-reset] Zapier misconfigured: ${config.reason}`);
      else if (env.NODE_ENV === "development") console.info(`[password-reset] ${RESET_WEBHOOK_URL_VAR} is not set; development reset link: ${url}`);
      else console.warn(`[password-reset] ${RESET_WEBHOOK_URL_VAR} is not set; no email sent`);
      return;
    }
    const { subject, message } = composeResetEmail({ name: customer.name, url });
    await postToZapier(
      config,
      {
        event: "customer.password_reset",
        auth_token: config.secret, // checked by the Zap's Filter step
        send_id: `password-reset-${customer.id}-${(deps.now ?? Date.now)()}`,
        recipient_email: customer.email, // Gmail "To"
        subject,
        message,
      },
      { fetchImpl: deps.fetchImpl, logLabel: "password-reset" }
    );
  } catch (err) {
    console.error("[password-reset] could not send the reset email", err);
  }
}

// ── Completing a reset ────────────────────────────────────────────────────

export type ResetResult =
  | { kind: "ok" }
  | { kind: "invalid_password"; message: string }
  | { kind: "invalid_token" }
  | { kind: "throttled"; retryAfter: number };

export async function resetPasswordWithToken(token: unknown, password: unknown, now = Date.now()): Promise<ResetResult> {
  if (typeof password !== "string" || password.length < MIN_CUSTOMER_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    return { kind: "invalid_password", message: `Use a password of at least ${MIN_CUSTOMER_PASSWORD_LENGTH} characters` };
  }
  const retryAfter = customerThrottles.resetSubmitGlobal.retryAfter("*");
  if (retryAfter > 0) return { kind: "throttled", retryAfter };
  customerThrottles.resetSubmitGlobal.record("*");

  const customer = await verifyResetToken(token, now);
  if (!customer) return { kind: "invalid_token" };
  const passwordHash = await hashPassword(password);
  const { count } = await prisma.customer.updateMany({
    where: { id: customer.id, passwordHash: customer.passwordHash },
    data: { passwordHash, sessionVersion: { increment: 1 } },
  });
  if (count !== 1) return { kind: "invalid_token" };
  customerThrottles.loginPerEmail.reset(customer.email); // a locked-out customer can sign in with the new password
  return { kind: "ok" };
}
