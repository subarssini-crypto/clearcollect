/**
 * Customer Portal data. Every query is scoped by the signed-in customer's
 * clientId, read from MySQL by requireCustomer — never from the request — so
 * a customer can only ever reach their own client's invoices. Unlinked
 * accounts see nothing.
 *
 * Invoices are identified to customers by invoice number (what they see on
 * the invoice email); internal IDs, PayPal order/capture IDs, payment tokens,
 * client emails, and owner-only fields (email workflow state, notes) are never
 * returned. DRAFT and CANCELLED invoices are not shown.
 */

import { prisma } from "@/lib/prisma";
import { InvoiceStatus } from "@/generated/prisma/enums";
import { parseStoredLineItems, type StoredLineItem } from "@/lib/line-items";
import { PAYABLE_STATUSES, createOrderForInvoice } from "@/lib/paypal";
import { TRANSACTIONS_WHERE, toTransaction } from "@/lib/transactions";

export const PORTAL_FILTERS = ["all", "pending", "paid", "overdue"] as const;
export type PortalFilter = (typeof PORTAL_FILTERS)[number];
export type PortalStatus = "pending" | "paid" | "overdue";

export function parsePortalFilter(raw: string | null): PortalFilter | null {
  const value = (raw ?? "all").toLowerCase();
  return (PORTAL_FILTERS as readonly string[]).includes(value) ? (value as PortalFilter) : null;
}

const VISIBLE_STATUSES = [InvoiceStatus.SENT, InvoiceStatus.OVERDUE, InvoiceStatus.PAID];

/** Start of today (UTC); invoices are due at the end of their due date. */
function startOfTodayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function portalStatus(invoice: { status: string; dueDate: Date }, now = new Date()): PortalStatus {
  if (invoice.status === InvoiceStatus.PAID) return "paid";
  if (invoice.status === InvoiceStatus.OVERDUE || invoice.dueDate < startOfTodayUtc(now)) return "overdue";
  return "pending";
}

export type PortalInvoice = {
  invoiceNumber: string;
  description: string;
  lineItems: StoredLineItem[] | null;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  status: PortalStatus;
  /** True only for unpaid SENT/OVERDUE invoices: the Pay action is offered. */
  payable: boolean;
  paidAt: string | null;
};

const PORTAL_SELECT = {
  invoiceNumber: true,
  description: true,
  lineItems: true,
  amount: true,
  currency: true,
  issueDate: true,
  dueDate: true,
  status: true,
  paypalCaptureId: true,
  paidAt: true,
} as const;

/** Where clause for "invoices of this client". Requires a linked client. */
function ownedBy(clientId: number, now: Date, filter: PortalFilter) {
  const today = startOfTodayUtc(now);
  const base = { clientId, status: { in: VISIBLE_STATUSES } };
  switch (filter) {
    case "paid":
      return { ...base, status: InvoiceStatus.PAID };
    case "overdue":
      return { ...base, OR: [{ status: InvoiceStatus.OVERDUE }, { status: InvoiceStatus.SENT, dueDate: { lt: today } }] };
    case "pending":
      return { ...base, status: InvoiceStatus.SENT, dueDate: { gte: today } };
    default:
      return base;
  }
}

export async function listPortalInvoices(clientId: number | null, filter: PortalFilter, now = new Date()): Promise<PortalInvoice[]> {
  if (clientId === null) return [];
  const rows = await prisma.invoice.findMany({
    where: ownedBy(clientId, now, filter),
    select: PORTAL_SELECT,
    orderBy: [{ dueDate: "desc" }, { invoiceNumber: "desc" }],
    take: 500,
  });
  return rows.map((row) => ({
    invoiceNumber: row.invoiceNumber,
    description: row.description,
    lineItems: row.lineItems == null ? null : parseStoredLineItems(row.lineItems),
    amount: row.amount.toFixed(2),
    currency: row.currency,
    issueDate: row.issueDate.toISOString(),
    dueDate: row.dueDate.toISOString(),
    status: portalStatus(row, now),
    payable: PAYABLE_STATUSES.includes(row.status) && !row.paypalCaptureId,
    paidAt: row.status === InvoiceStatus.PAID && row.paidAt ? row.paidAt.toISOString() : null,
  }));
}

export type PortalPayment = { invoiceNumber: string; amount: string; currency: string; method: "PayPal" | null; paidAt: string | null };

/** Verified payments (PAID invoices, see src/lib/transactions.ts) for this client only. */
export async function listPortalPayments(clientId: number | null): Promise<PortalPayment[]> {
  if (clientId === null) return [];
  const rows = await prisma.invoice.findMany({
    where: { ...TRANSACTIONS_WHERE, clientId },
    select: { id: true, invoiceNumber: true, amount: true, currency: true, paypalCaptureId: true, paidAt: true, paypalEnvironment: true, client: { select: { name: true } } },
    orderBy: [{ paidAt: "desc" }, { id: "desc" }],
    take: 500,
  });
  // Reuse the Transactions mapping, then drop internal and PayPal references.
  return rows.map(toTransaction).map(({ invoiceNumber, amount, currency, method, paidAt }) => ({ invoiceNumber, amount, currency, method, paidAt }));
}

export class PortalError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Starts (or reuses) the PayPal order for one of this client's invoices via the
 * existing server-side flow. Unknown, foreign, DRAFT, and CANCELLED invoices
 * are indistinguishable (404).
 */
export async function startPortalPayment(clientId: number | null, invoiceNumber: unknown, appOrigin: string): Promise<{ approveUrl: string }> {
  if (clientId === null || typeof invoiceNumber !== "string" || !invoiceNumber || invoiceNumber.length > 191) {
    throw new PortalError("Invoice not found", 404);
  }
  const invoice = await prisma.invoice.findFirst({
    where: { invoiceNumber, clientId, status: { in: VISIBLE_STATUSES } },
    select: { id: true },
  });
  if (!invoice) throw new PortalError("Invoice not found", 404);
  const { approveUrl } = await createOrderForInvoice(invoice.id, appOrigin);
  return { approveUrl };
}
