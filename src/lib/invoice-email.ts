/**
 * Invoice emails: send a saved DRAFT invoice to its client through a Zapier
 * Catch Hook (Gmail step inside the Zap). Separate from payment reminders,
 * which only cover SENT/OVERDUE invoices; the shared delivery helpers live in
 * src/lib/zapier.ts.
 *
 * Workflow and state (Invoice.emailState, Invoice.emailStateAt):
 *
 *   DRAFT, emailState null ──claim──▶ SENDING ──Zapier 2xx──▶ status SENT, ACCEPTED
 *                                       │ ├──non-2xx / unreachable──▶ back to null (retry allowed)
 *                                       │ └──timeout──▶ UNKNOWN (stays DRAFT)
 *                                       └──server died mid-send──▶ stale SENDING (treated like UNKNOWN)
 *
 * - The claim is a conditional UPDATE, so two concurrent requests cannot both
 *   send: only one matches `emailState IS NULL`.
 * - The invoice becomes SENT only after Zapier accepts the email. Zapier's 2xx
 *   does not prove Gmail delivered it; the response says so.
 * - After a timeout (UNKNOWN), an interrupted send, or an earlier accepted
 *   send of an invoice that was moved back to DRAFT, sending again needs an
 *   explicit `confirmResend` — the owner must first check the Zap history.
 * - Recipient, amounts, dates, and line items always come from MySQL.
 */

import { prisma } from "@/lib/prisma";
import { InvoiceEmailState, InvoiceStatus } from "@/generated/prisma/enums";
import { lineItemCents, lineItemsTotalCents, parseStoredLineItems, type StoredLineItem } from "@/lib/line-items";
import { formatAmount, formatLongDate, getZapierConfig, postToZapier, validRecipient, type ZapierConfig } from "@/lib/zapier";

/** A SENDING claim older than this is treated as interrupted (outcome unknown). */
export const SEND_STALE_MS = 2 * 60_000;

export const INVOICE_WEBHOOK_URL_VAR = "ZAPIER_INVOICE_WEBHOOK_URL";

export type InvoiceEmailErrorCode =
  | "not_found"
  | "not_draft"
  | "paid"
  | "no_recipient"
  | "line_items_mismatch"
  | "in_progress"
  | "confirm_required"
  | "claim_lost"
  | "misconfigured"
  | "rejected"
  | "unreachable"
  | "unknown_outcome"
  | "accepted_not_recorded";

export class InvoiceEmailError extends Error {
  constructor(message: string, public status: number, public code: InvoiceEmailErrorCode) {
    super(message);
  }
}

export type EmailState = "SENDING" | "UNKNOWN" | "ACCEPTED";

export interface InvoiceEmailRecord {
  id: number;
  invoiceNumber: string;
  description: string;
  amount: { toString(): string } | string | number;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  status: string;
  paypalCaptureId: string | null;
  lineItems: unknown;
  emailState: EmailState | null;
  emailStateAt: Date | null;
  client: { id: number; name: string; email: string | null; company: string | null };
}

// ── State helpers ─────────────────────────────────────────────────────────────

/** True while a send is actively in progress (edits and deletes must wait). */
export function isSendInProgress(invoice: { emailState: string | null; emailStateAt: Date | null }, now: number): boolean {
  return invoice.emailState === "SENDING" && !!invoice.emailStateAt && now - invoice.emailStateAt.getTime() < SEND_STALE_MS;
}

/**
 * Why sending again needs confirmation, or null when a normal send is allowed.
 * Covers a timed-out send, an interrupted send, and an earlier accepted send.
 */
export function resendWarning(invoice: Pick<InvoiceEmailRecord, "emailState" | "emailStateAt" | "invoiceNumber">, now: number): string | null {
  const at = invoice.emailStateAt ? ` (${invoice.emailStateAt.toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
  if (invoice.emailState === "UNKNOWN" || (invoice.emailState === "SENDING" && !isSendInProgress(invoice, now))) {
    return `An earlier send of ${invoice.invoiceNumber}${at} did not finish, so it is unknown whether the email went out. Check your Zap history before sending again.`;
  }
  if (invoice.emailState === "ACCEPTED") {
    return `${invoice.invoiceNumber} was already handed to Zapier${at}. Sending again will email the client a second time.`;
  }
  return null;
}

/** Throws unless the invoice is an unpaid DRAFT. */
export function assertSendable(invoice: InvoiceEmailRecord): void {
  if (invoice.status === InvoiceStatus.PAID || invoice.paypalCaptureId) {
    throw new InvoiceEmailError("This invoice is already paid; it cannot be sent", 409, "paid");
  }
  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw new InvoiceEmailError(
      `Only DRAFT invoices can be sent (this one is ${invoice.status}). Use Follow-ups for payment reminders.`,
      409,
      "not_draft"
    );
  }
}

export function invoiceRecipient(invoice: InvoiceEmailRecord): string {
  const email = validRecipient(invoice.client.email);
  if (!email) {
    throw new InvoiceEmailError(
      `${invoice.client.name} has no valid email address on file; add one on the Clients page before sending`,
      422,
      "no_recipient"
    );
  }
  return email;
}

// ── Email content ─────────────────────────────────────────────────────────────

export interface InvoiceEmail {
  recipient: string;
  subject: string;
  message: string;
  lineItemsText: string;
  facts: { invoiceNumber: string; amount: string; amountValue: string; currency: string; issueDate: string; dueDate: string };
}

const UNIT_WORDS: Record<string, { one: string; many: string }> = {
  hour: { one: "hour", many: "hours" },
  day: { one: "day", many: "days" },
  week: { one: "week", many: "weeks" },
  month: { one: "month", many: "months" },
  item: { one: "item", many: "items" },
};

function describeLine(item: StoredLineItem, currency: string): string {
  const rate = formatAmount(item.rate, currency);
  const total = formatAmount(lineItemCents(item) / 100, currency);
  const qty = Number(item.quantity.toFixed(2));
  if (item.unit === "fixed") return `- ${item.description}: ${qty === 1 ? "" : `${qty} × `}fixed price ${rate} = ${total}`;
  const unit = item.unit ? UNIT_WORDS[item.unit] : undefined;
  const count = unit ? `${qty} ${qty === 1 ? unit.one : unit.many} × ${rate}/${unit.one}` : `${qty} × ${rate}`;
  return `- ${item.description}: ${count} = ${total}`;
}

/**
 * Builds the email from the stored invoice. Stored line items must still add
 * up to the stored amount; invoices saved before line items were stored show
 * their description and total as a single line.
 */
export function composeInvoiceEmail(invoice: InvoiceEmailRecord): InvoiceEmail {
  const recipient = invoiceRecipient(invoice);
  const amountCents = Math.round(Number(invoice.amount.toString()) * 100);
  const amount = formatAmount(invoice.amount, invoice.currency);
  const issueDate = formatLongDate(invoice.issueDate);
  const dueDate = formatLongDate(invoice.dueDate);

  let lines: string[];
  if (invoice.lineItems === null || invoice.lineItems === undefined) {
    lines = [`- ${invoice.description}: ${amount}`];
  } else {
    const items = parseStoredLineItems(invoice.lineItems);
    if (!items || lineItemsTotalCents(items) !== amountCents) {
      throw new InvoiceEmailError(
        "This invoice's saved line items do not match its amount, so it was not sent. Recreate the invoice.",
        422,
        "line_items_mismatch"
      );
    }
    lines = items.map((item) => describeLine(item, invoice.currency));
  }
  const lineItemsText = lines.join("\n");

  const subject = `Invoice ${invoice.invoiceNumber} — ${amount} due ${dueDate}`;
  const message = [
    `Hi ${invoice.client.name},`,
    "",
    `Here is invoice ${invoice.invoiceNumber}.`,
    "",
    `Invoice number: ${invoice.invoiceNumber}`,
    `Issue date: ${issueDate}`,
    `Due date: ${dueDate}`,
    "",
    "Items:",
    lineItemsText,
    "",
    `Total due: ${amount}`,
    "",
    `How to pay: please pay ${amount} by ${dueDate} and include ${invoice.invoiceNumber} as the payment reference. ` +
      "If you need payment details or have any questions, just reply to this email.",
    "",
    "Thank you!",
  ].join("\n");

  return {
    recipient,
    subject,
    message,
    lineItemsText,
    facts: {
      invoiceNumber: invoice.invoiceNumber,
      amount,
      amountValue: (amountCents / 100).toFixed(2),
      currency: invoice.currency,
      issueDate,
      dueDate,
    },
  };
}

/**
 * Flat payload so each field maps directly in the Zap editor.
 * Gmail mapping: To = recipient_email, Subject = subject, Body = message.
 */
export function buildInvoiceEmailPayload(invoice: InvoiceEmailRecord, email: InvoiceEmail, secret: string, claimedAt: Date) {
  return {
    event: "invoice.email.approved",
    auth_token: secret, // checked by the Zap's Filter step
    send_id: `${invoice.id}-${claimedAt.getTime()}`, // unique per attempt
    approved_at: claimedAt.toISOString(),
    invoice_id: invoice.id,
    invoice_number: email.facts.invoiceNumber,
    amount: email.facts.amount,
    amount_value: email.facts.amountValue,
    currency: email.facts.currency,
    issue_date: email.facts.issueDate,
    due_date: email.facts.dueDate,
    line_items: email.lineItemsText,
    client_name: invoice.client.name,
    client_company: invoice.client.company ?? "",
    recipient_email: email.recipient, // Gmail "To"
    subject: email.subject,
    message: email.message,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/** Conditional writes that make the workflow safe under concurrency. */
export interface InvoiceEmailStore {
  load(id: number): Promise<InvoiceEmailRecord | null>;
  /** Atomically DRAFT + allowed state → SENDING at `at`. False if another request won or the invoice changed. */
  claim(id: number, at: Date, options: { allowResend: boolean; staleBefore: Date }): Promise<boolean>;
  /** SENDING (this claim) → status SENT, ACCEPTED. False if the claim no longer matches. */
  markAccepted(id: number, claimedAt: Date, now: Date): Promise<boolean>;
  /** SENDING (this claim) → UNKNOWN. */
  markUnknown(id: number, claimedAt: Date, now: Date): Promise<void>;
  /** SENDING (this claim) → the state before the claim (definitely not sent). */
  release(id: number, claimedAt: Date, previous: { state: EmailState | null; at: Date | null }): Promise<void>;
}

const RECORD_SELECT = {
  id: true,
  invoiceNumber: true,
  description: true,
  amount: true,
  currency: true,
  issueDate: true,
  dueDate: true,
  status: true,
  paypalCaptureId: true,
  lineItems: true,
  emailState: true,
  emailStateAt: true,
  client: { select: { id: true, name: true, email: true, company: true } },
} as const;

export const prismaInvoiceEmailStore: InvoiceEmailStore = {
  load: (id) => prisma.invoice.findUnique({ where: { id }, select: RECORD_SELECT }),

  async claim(id, at, { allowResend, staleBefore }) {
    const { count } = await prisma.invoice.updateMany({
      where: {
        id,
        status: InvoiceStatus.DRAFT,
        paypalCaptureId: null,
        OR: [
          { emailState: null },
          ...(allowResend
            ? [
                { emailState: InvoiceEmailState.UNKNOWN },
                { emailState: InvoiceEmailState.ACCEPTED },
                { emailState: InvoiceEmailState.SENDING, emailStateAt: { lt: staleBefore } },
              ]
            : []),
        ],
      },
      data: { emailState: InvoiceEmailState.SENDING, emailStateAt: at },
    });
    return count === 1;
  },

  async markAccepted(id, claimedAt, now) {
    const { count } = await prisma.invoice.updateMany({
      where: { id, status: InvoiceStatus.DRAFT, emailState: InvoiceEmailState.SENDING, emailStateAt: claimedAt },
      data: { status: InvoiceStatus.SENT, emailState: InvoiceEmailState.ACCEPTED, emailStateAt: now },
    });
    return count === 1;
  },

  async markUnknown(id, claimedAt, now) {
    await prisma.invoice.updateMany({
      where: { id, emailState: InvoiceEmailState.SENDING, emailStateAt: claimedAt },
      data: { emailState: InvoiceEmailState.UNKNOWN, emailStateAt: now },
    });
  },

  async release(id, claimedAt, previous) {
    await prisma.invoice.updateMany({
      where: { id, emailState: InvoiceEmailState.SENDING, emailStateAt: claimedAt },
      data: { emailState: previous.state, emailStateAt: previous.at },
    });
  },
};

// ── Preview and send ──────────────────────────────────────────────────────────

export type DeliveryMode = "zapier" | "demo" | "misconfigured";

export function invoiceEmailDelivery(env: Record<string, string | undefined> = process.env): { mode: DeliveryMode; config: ZapierConfig } {
  const config = getZapierConfig(env, { urlVar: INVOICE_WEBHOOK_URL_VAR, secretAloneIsMisconfigured: false });
  return { mode: config.state === "configured" ? "zapier" : config.state, config };
}

export interface InvoiceEmailPreview {
  invoiceId: number;
  invoiceNumber: string;
  status: string;
  delivery: DeliveryMode;
  recipient: string;
  subject: string;
  message: string;
  inProgress: boolean;
  /** Set when sending again needs `confirmResend` (see resendWarning). */
  resendWarning: string | null;
}

/** What would be sent, without sending or changing anything. */
export async function previewInvoiceEmail(
  invoiceId: number,
  deps: { store?: InvoiceEmailStore; env?: Record<string, string | undefined>; now?: number } = {}
): Promise<InvoiceEmailPreview> {
  const store = deps.store ?? prismaInvoiceEmailStore;
  const now = deps.now ?? Date.now();
  const invoice = await store.load(invoiceId);
  if (!invoice) throw new InvoiceEmailError(`Invoice ${invoiceId} not found`, 404, "not_found");
  assertSendable(invoice);
  const email = composeInvoiceEmail(invoice);
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    delivery: invoiceEmailDelivery(deps.env).mode,
    recipient: email.recipient,
    subject: email.subject,
    message: email.message,
    inProgress: isSendInProgress(invoice, now),
    resendWarning: resendWarning(invoice, now),
  };
}

export type InvoiceEmailResult =
  | { mode: "demo"; accepted: false; status: string; detail: string }
  | { mode: "zapier"; accepted: true; status: "SENT"; recipient: string; detail: string };

/**
 * Sends a saved DRAFT invoice to its client's stored email address. Throws
 * InvoiceEmailError for every outcome other than "accepted by Zapier" (or demo
 * mode, which sends nothing and changes nothing).
 */
export async function sendInvoiceEmail(
  invoiceId: number,
  options: { confirmResend?: boolean } = {},
  deps: { store?: InvoiceEmailStore; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<InvoiceEmailResult> {
  const store = deps.store ?? prismaInvoiceEmailStore;
  const clock = deps.now ?? Date.now;

  const invoice = await store.load(invoiceId);
  if (!invoice) throw new InvoiceEmailError(`Invoice ${invoiceId} not found`, 404, "not_found");
  assertSendable(invoice);
  const email = composeInvoiceEmail(invoice);

  const { config } = invoiceEmailDelivery(deps.env);
  if (config.state === "demo") {
    return {
      mode: "demo",
      accepted: false,
      status: invoice.status,
      detail: `Demo mode: ${INVOICE_WEBHOOK_URL_VAR} is not configured, so nothing was sent and ${invoice.invoiceNumber} is still a DRAFT.`,
    };
  }
  if (config.state === "misconfigured") {
    console.error(`[invoice-email] Zapier misconfigured: ${config.reason}`);
    throw new InvoiceEmailError("Invoice email delivery is misconfigured on the server; nothing was sent", 503, "misconfigured");
  }

  const startedAt = clock();
  if (isSendInProgress(invoice, startedAt)) {
    throw new InvoiceEmailError(`${invoice.invoiceNumber} is already being sent; wait for that attempt to finish`, 409, "in_progress");
  }
  const warning = resendWarning(invoice, startedAt);
  if (warning && !options.confirmResend) {
    throw new InvoiceEmailError(warning, 409, "confirm_required");
  }

  const claimedAt = new Date(startedAt);
  const claimed = await store.claim(invoice.id, claimedAt, {
    allowResend: !!options.confirmResend,
    staleBefore: new Date(startedAt - SEND_STALE_MS),
  });
  if (!claimed) {
    throw new InvoiceEmailError(
      `${invoice.invoiceNumber} changed or is being sent by another request; reload and check its status before trying again`,
      409,
      "claim_lost"
    );
  }

  const previous = { state: invoice.emailState, at: invoice.emailStateAt };
  const outcome = await postToZapier(config, buildInvoiceEmailPayload(invoice, email, config.secret, claimedAt), {
    fetchImpl: deps.fetchImpl,
    logLabel: "invoice-email",
  });

  if (outcome.kind === "timeout") {
    await store.markUnknown(invoice.id, claimedAt, new Date(clock())).catch((err) => console.error("[invoice-email] markUnknown failed", err));
    throw new InvoiceEmailError(
      `Zapier did not respond in time, so it is unknown whether ${invoice.invoiceNumber} was emailed. It stays a DRAFT. ` +
        "Check your Zap history: if the email went out, mark the invoice as sent; otherwise you can send again after confirming.",
      504,
      "unknown_outcome"
    );
  }
  if (outcome.kind !== "accepted") {
    await store.release(invoice.id, claimedAt, previous).catch((err) => console.error("[invoice-email] release failed", err));
    throw outcome.kind === "rejected"
      ? new InvoiceEmailError(`Zapier rejected the invoice email (HTTP ${outcome.status}); it was not sent and ${invoice.invoiceNumber} is still a DRAFT`, 502, "rejected")
      : new InvoiceEmailError(`Could not reach Zapier; the invoice email was not sent and ${invoice.invoiceNumber} is still a DRAFT`, 502, "unreachable");
  }

  let recorded = false;
  try {
    recorded = await store.markAccepted(invoice.id, claimedAt, new Date(clock()));
  } catch (err) {
    console.error("[invoice-email] markAccepted failed", err);
  }
  if (!recorded) {
    // Zapier has it, so never suggest a plain retry.
    throw new InvoiceEmailError(
      `Zapier accepted the email for ${invoice.invoiceNumber}, but ClearCollect could not mark the invoice as SENT. ` +
        "Do not send it again; check your Zap history and mark the invoice as sent.",
      500,
      "accepted_not_recorded"
    );
  }
  return {
    mode: "zapier",
    accepted: true,
    status: "SENT",
    recipient: email.recipient,
    detail:
      `Accepted by Zapier for delivery to ${email.recipient}; ${invoice.invoiceNumber} is now marked SENT. ` +
      "Gmail sending happens in your Zap — check its history to confirm delivery.",
  };
}
