/**
 * Pure helpers for the development-only reminder test-data script.
 * No database access here, so everything is unit-testable offline.
 */

import { assertRemindable, reminderRecipient, type ReminderInvoice } from "@/lib/follow-up";

export const TEST_CLIENT_NAME = "ClearCollect Reminder Test (TEST ONLY)";
export const TEST_CLIENT_COMPANY = "TEST ONLY - not a real client";
/** Distinct from INV-YYYY-NNN, so automatic invoice numbering ignores it. */
export const TEST_INVOICE_PREFIX = "INV-TEST-REMINDER-";
export const TEST_AMOUNT = "1.00";
export const TEST_CURRENCY = "USD";
/** Due inside the Follow-ups page's 7-day window. */
export const TEST_DUE_IN_DAYS = 3;
/** Every test invoice description starts with this label (used with the prefix to identify test invoices). */
export const TEST_DESCRIPTION_LABEL = "TEST ONLY";
export const USE_EXISTING_CLIENT_FLAG = "--use-existing-client";

export class TestDataError extends Error {}

export type ScriptArgs = { mode: "create"; email: string; useExistingClient: boolean } | { mode: "cleanup" };

const USAGE = `Usage: --email <address you control> [${USE_EXISTING_CLIENT_FLAG}]   or   --cleanup`;

export function parseArgs(argv: string[]): ScriptArgs {
  if (argv.includes("--cleanup")) {
    if (argv.some((a) => a !== "--cleanup")) throw new TestDataError("--cleanup takes no other arguments");
    return { mode: "cleanup" };
  }
  const useExistingClient = argv.includes(USE_EXISTING_CLIENT_FLAG);
  const rest = argv.filter((a) => a !== USE_EXISTING_CLIENT_FLAG);
  const i = rest.indexOf("--email");
  const email = i >= 0 ? rest[i + 1] : undefined;
  if (!email || email.startsWith("--") || rest.length !== 2 || argv.length - rest.length > 1) {
    throw new TestDataError(USAGE);
  }
  return { mode: "create", email: email.trim(), useExistingClient };
}

/** Refuses production and non-local databases. Never prints the URL. */
export function assertDevEnvironment(env: Record<string, string | undefined>): void {
  if (env.NODE_ENV === "production") {
    throw new TestDataError("Refusing to run with NODE_ENV=production");
  }
  let host = "";
  try {
    host = new URL(env.DATABASE_URL ?? "").hostname;
  } catch {
    throw new TestDataError("DATABASE_URL is missing or invalid");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new TestDataError("Refusing to run against a non-local database");
  }
}

/**
 * The recipient must pass the production email check and must not belong to
 * any real client, so a test reminder can never reach a real client.
 */
export function assertSafeTestEmail(email: string, realClientEmails: (string | null)[]): string {
  const valid = reminderRecipient(testInvoiceShape(email));
  const lower = valid.toLowerCase();
  if (realClientEmails.some((e) => e?.trim().toLowerCase() === lower)) {
    throw new TestDataError(
      `That email belongs to an existing client. If you control that inbox, rerun with ${USE_EXISTING_CLIENT_FLAG} ` +
        "to attach a disposable test invoice to that client (its details are not changed)."
    );
  }
  return valid;
}

/**
 * Opt-in path (--use-existing-client): the email must pass the production
 * email check and match exactly one existing client. Returns that client's id;
 * the client record itself is only read, never changed.
 */
export function findExistingClientForEmail(email: string, clients: { id: number; email: string | null }[]): number {
  const lower = reminderRecipient(testInvoiceShape(email)).toLowerCase();
  const matches = clients.filter((c) => c.email?.trim().toLowerCase() === lower);
  if (matches.length === 0) {
    throw new TestDataError(`No existing client has that email; omit ${USE_EXISTING_CLIENT_FLAG} to use a dedicated test client`);
  }
  if (matches.length > 1) {
    throw new TestDataError("More than one client has that email; refusing to guess which one to use");
  }
  return matches[0].id;
}

/** A test invoice is identified by both its number prefix and its description label. */
export function isDisposableTestInvoice(invoice: { invoiceNumber: string; description: string }): boolean {
  return isTestInvoiceNumber(invoice.invoiceNumber) && invoice.description.startsWith(TEST_DESCRIPTION_LABEL);
}

export function isTestInvoiceNumber(invoiceNumber: string): boolean {
  return invoiceNumber.startsWith(TEST_INVOICE_PREFIX);
}

export function testInvoiceNumber(now: number): string {
  // e.g. INV-TEST-REMINDER-20261020-143005
  const iso = new Date(now).toISOString();
  return `${TEST_INVOICE_PREFIX}${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

/** Prisma create data for the disposable test invoice. */
export function buildTestInvoice(clientId: number, now: number) {
  const today = new Date(now);
  const issueDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dueDate = new Date(issueDate);
  dueDate.setUTCDate(dueDate.getUTCDate() + TEST_DUE_IN_DAYS);
  return {
    invoiceNumber: testInvoiceNumber(now),
    clientId,
    description: `${TEST_DESCRIPTION_LABEL} - disposable invoice for verifying the ClearCollect -> Zapier -> Gmail reminder flow. Not a real charge.`,
    amount: TEST_AMOUNT,
    currency: TEST_CURRENCY,
    issueDate,
    dueDate,
    status: "SENT" as const,
  };
}

/** Shape used to run the production eligibility checks before writing anything. */
export function testInvoiceShape(email: string, now = Date.now()): ReminderInvoice {
  const data = buildTestInvoice(0, now);
  return {
    id: 0,
    invoiceNumber: data.invoiceNumber,
    amount: data.amount,
    currency: data.currency,
    dueDate: data.dueDate,
    status: data.status,
    paypalCaptureId: null,
    client: { id: 0, name: TEST_CLIENT_NAME, email, company: TEST_CLIENT_COMPANY },
  };
}

/** Throws unless the planned records meet the real reminder eligibility rules. */
export function assertWouldBeEligible(email: string, now = Date.now()): void {
  const shape = testInvoiceShape(email, now);
  assertRemindable(shape);
  reminderRecipient(shape);
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}
