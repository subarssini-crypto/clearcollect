/**
 * Public payment links: /pay/<token> lets a client view and pay one invoice
 * without an owner account.
 *
 * - The token is 32 random bytes (base64url, 43 chars), stored in
 *   Invoice.paymentToken. It is the only credential, so it is never derived
 *   from the invoice ID and never logged.
 * - The public view exposes only what the client already receives in the
 *   invoice email: no client email, internal IDs, PayPal IDs, or other
 *   invoices. DRAFT and CANCELLED invoices show nothing at all.
 * - Payment reuses createOrderForInvoice/captureOrderForInvoice, so the amount
 *   and currency always come from MySQL and PAID is set only after a verified
 *   capture. Nothing from the request body is used.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { InvoiceStatus } from "@/generated/prisma/enums";
import { PAYABLE_STATUSES, getAppOrigin } from "@/lib/paypal";
import { parseStoredLineItems, type StoredLineItem } from "@/lib/line-items";
import { getCustomer } from "@/lib/customer-auth";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generatePaymentToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Cheap shape check so malformed tokens never reach the database. */
export function isWellFormedPaymentToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function paymentPageUrl(origin: string, token: string): string {
  return new URL(`/pay/${token}`, origin).toString();
}

/**
 * Returns the invoice's payment token, creating it on first use. The write
 * only fills an empty column, so concurrent callers all end up with the
 * same token.
 */
export async function ensurePaymentToken(invoiceId: number): Promise<string | null> {
  const existing = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { paymentToken: true } });
  if (!existing) return null;
  if (existing.paymentToken) return existing.paymentToken;

  await prisma.invoice.updateMany({
    where: { id: invoiceId, paymentToken: null },
    data: { paymentToken: generatePaymentToken() },
  });
  const current = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { paymentToken: true } });
  return current?.paymentToken ?? null;
}

/**
 * Invoice ID for a token, or null for malformed/unknown tokens and for
 * DRAFT/CANCELLED invoices, which are indistinguishable from unknown links.
 */
export async function invoiceIdForToken(token: unknown): Promise<number | null> {
  if (!isWellFormedPaymentToken(token)) return null;
  const invoice = await prisma.invoice.findUnique({ where: { paymentToken: token }, select: { id: true, status: true } });
  if (!invoice || (invoice.status !== InvoiceStatus.PAID && !PAYABLE_STATUSES.includes(invoice.status))) return null;
  return invoice.id;
}

const ORDER_ID_PATTERN = /^[A-Z0-9]{1,36}$/i;

/**
 * Where PayPal return/cancel sends the payer, with a display-only `payment`
 * result (pages always show the status from MySQL):
 * - a signed-in Customer Portal user whose client owns the invoice goes back
 *   to the portal (no payment token is created or revealed);
 * - everyone else goes to the invoice's public pay page;
 * - unknown orders land on the generic invalid-link page.
 */
async function payerDestination(request: Request, orderId: string): Promise<string | null> {
  const invoice = await prisma.invoice.findUnique({
    where: { paypalOrderId: orderId },
    select: { id: true, clientId: true, invoiceNumber: true, paymentToken: true },
  });
  if (!invoice) return null;
  const customer = await getCustomer(request).catch(() => null);
  if (customer?.clientId === invoice.clientId) {
    return `/portal?invoice=${encodeURIComponent(invoice.invoiceNumber)}`;
  }
  const token = invoice.paymentToken ?? (await ensurePaymentToken(invoice.id));
  return token ? `/pay/${token}` : null;
}

export async function payPageRedirect(request: Request, orderId: string | null, result: string): Promise<Response> {
  let path: string | null = null;
  if (orderId && ORDER_ID_PATTERN.test(orderId)) {
    path = await payerDestination(request, orderId).catch((err) => {
      console.error(`[paypal] could not look up the payment page for order ${orderId}`, err);
      return null;
    });
  }
  const target = new URL(path ?? "/pay/invalid", getAppOrigin(request.url));
  target.searchParams.set("payment", result);
  return Response.redirect(target, 303);
}

// ── Public view ───────────────────────────────────────────────────────────────

export type PublicInvoice = {
  state: "payable" | "paid";
  invoiceNumber: string;
  clientName: string;
  clientCompany: string | null;
  description: string;
  lineItems: StoredLineItem[] | null;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  overdue: boolean;
  paidAt: string | null;
};

/** Only these columns are ever read for the public page. */
const PUBLIC_SELECT = {
  invoiceNumber: true,
  description: true,
  lineItems: true,
  amount: true,
  currency: true,
  issueDate: true,
  dueDate: true,
  status: true,
  paidAt: true,
  client: { select: { name: true, company: true } },
} as const;

/**
 * The client-facing view of an invoice, or null when the token is malformed,
 * unknown, or belongs to an invoice that is not issued (DRAFT/CANCELLED).
 */
export async function getPublicInvoice(token: unknown, now = new Date()): Promise<PublicInvoice | null> {
  if (!isWellFormedPaymentToken(token)) return null;
  const invoice = await prisma.invoice.findUnique({ where: { paymentToken: token }, select: PUBLIC_SELECT });
  if (!invoice) return null;

  const paid = invoice.status === InvoiceStatus.PAID;
  if (!paid && !PAYABLE_STATUSES.includes(invoice.status)) return null;

  return {
    state: paid ? "paid" : "payable",
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.client.name,
    clientCompany: invoice.client.company,
    description: invoice.description,
    lineItems: invoice.lineItems == null ? null : parseStoredLineItems(invoice.lineItems),
    amount: invoice.amount.toFixed(2),
    currency: invoice.currency,
    issueDate: invoice.issueDate.toISOString(),
    dueDate: invoice.dueDate.toISOString(),
    overdue: !paid && (invoice.status === InvoiceStatus.OVERDUE || invoice.dueDate < now),
    paidAt: paid && invoice.paidAt ? invoice.paidAt.toISOString() : null,
  };
}
