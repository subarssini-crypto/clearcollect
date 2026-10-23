/**
 * Shared Zapier "Catch Hook" delivery used by payment reminders
 * (src/lib/follow-up.ts) and invoice emails (src/lib/invoice-email.ts).
 *
 * - Every request carries the shared secret (payload `auth_token` and the
 *   X-ClearCollect-Token header); each Zap's Filter step must check it.
 * - A 2xx only means Zapier accepted the request. The Gmail step runs later
 *   inside the Zap, so callers must never claim the email was delivered.
 * - Outcomes are classified so callers can be honest: a timeout is ambiguous
 *   (Zapier may have received the request), other network errors and non-2xx
 *   responses mean it was not accepted.
 */

export const ZAPIER_TIMEOUT_MS = 10_000;

export type ZapierConfig =
  | { state: "configured"; url: string; secret: string }
  | { state: "demo" } // nothing configured
  | { state: "misconfigured"; reason: string };

/**
 * Reads a webhook URL (from `urlVar`) and the shared ZAPIER_WEBHOOK_SECRET.
 * With `secretAloneIsMisconfigured` false, an unset URL is demo mode even when
 * the secret is set (it may be configured for another flow).
 */
export function getZapierConfig(
  env: Record<string, string | undefined> = process.env,
  { urlVar = "ZAPIER_WEBHOOK_URL", secretAloneIsMisconfigured = true } = {}
): ZapierConfig {
  const url = env[urlVar]?.trim();
  const secret = env.ZAPIER_WEBHOOK_SECRET?.trim();
  if (!url && (!secret || !secretAloneIsMisconfigured)) return { state: "demo" };
  if (!url || !secret) return { state: "misconfigured", reason: `Both ${urlVar} and ZAPIER_WEBHOOK_SECRET must be set` };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { state: "misconfigured", reason: `${urlVar} is not a valid URL` };
  }
  if (parsed.protocol !== "https:") return { state: "misconfigured", reason: `${urlVar} must use https` };
  if (secret.length < 16) return { state: "misconfigured", reason: "ZAPIER_WEBHOOK_SECRET must be at least 16 characters" };
  return { state: "configured", url, secret };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The trimmed address if it can be used as a Gmail "To", otherwise null.
 * Zapier accepts a Catch Hook request before its Gmail step runs, so a bad
 * address must be caught before sending.
 */
export function validRecipient(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? "";
  return trimmed && trimmed.length <= 191 && EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

export type ZapierOutcome =
  | { kind: "accepted" }
  | { kind: "rejected"; status: number } // Zapier answered with a non-2xx: not accepted
  | { kind: "unreachable" } // connection failed: not accepted
  | { kind: "timeout" }; // no answer in time: may or may not have been accepted

/** POSTs a JSON payload to a Catch Hook and classifies the outcome. Never throws. */
export async function postToZapier(
  config: { url: string; secret: string },
  payload: Record<string, unknown>,
  { fetchImpl = fetch, logLabel = "zapier" }: { fetchImpl?: typeof fetch; logLabel?: string } = {}
): Promise<ZapierOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ClearCollect-Token": config.secret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ZAPIER_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    console.error(`[${logLabel}] Zapier request failed`, name);
    return name === "TimeoutError" || name === "AbortError" ? { kind: "timeout" } : { kind: "unreachable" };
  }
  if (!response.ok) {
    console.error(`[${logLabel}] Zapier responded ${response.status}`);
    return { kind: "rejected", status: response.status };
  }
  return { kind: "accepted" };
}

/** "USD 1,830.00": always includes the currency code. */
export function formatAmount(amount: { toString(): string } | string | number, currency: string): string {
  const value = Number(amount.toString());
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" })
      .format(value)
      .replace(/ /g, " ");
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** "November 2, 2026" for a date stored at UTC midnight. */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
