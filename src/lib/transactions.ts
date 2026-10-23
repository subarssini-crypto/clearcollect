/**
 * Successful payments for the Transactions page.
 *
 * A transaction is a PAID invoice. In this app only the verified PayPal
 * capture flow (src/lib/paypal.ts) can set PAID, and it records the capture
 * ID, PayPal's capture time, and the environment in the same update. Drafts,
 * unpaid invoices, and failed or pending captures are never PAID, so they
 * never appear. Fields missing on older rows are returned as null and shown
 * as "Unavailable" — nothing is inferred.
 */

import { prisma } from "@/lib/prisma";
import { InvoiceStatus } from "@/generated/prisma/enums";

export interface Transaction {
  invoiceId: number;
  invoiceNumber: string;
  clientName: string;
  amount: string; // decimal string, e.g. "1830.00"
  currency: string;
  /** "PayPal" when a verified capture ID is stored, otherwise null (unknown). */
  method: "PayPal" | null;
  /** ISO timestamp of the PayPal capture, or null if not recorded. */
  paidAt: string | null;
  captureId: string | null;
  environment: "SANDBOX" | "LIVE" | null;
}

export interface TransactionRow {
  id: number;
  invoiceNumber: string;
  amount: { toString(): string } | string | number;
  currency: string;
  paypalCaptureId: string | null;
  paidAt: Date | null;
  paypalEnvironment: "SANDBOX" | "LIVE" | null;
  client: { name: string };
}

export function toTransaction(row: TransactionRow): Transaction {
  return {
    invoiceId: row.id,
    invoiceNumber: row.invoiceNumber,
    clientName: row.client.name,
    amount: Number(row.amount.toString()).toFixed(2),
    currency: row.currency,
    method: row.paypalCaptureId ? "PayPal" : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    captureId: row.paypalCaptureId,
    environment: row.paypalEnvironment,
  };
}

export const TRANSACTIONS_WHERE = { status: InvoiceStatus.PAID } as const;

/** Newest payments first; rows without a recorded time (MySQL sorts NULL last on DESC) after them. */
export async function listTransactions({ page, limit }: { page: number; limit: number }) {
  const [rows, total] = await prisma.$transaction([
    prisma.invoice.findMany({
      where: TRANSACTIONS_WHERE,
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: (page - 1) * limit,
      select: {
        id: true,
        invoiceNumber: true,
        amount: true,
        currency: true,
        paypalCaptureId: true,
        paidAt: true,
        paypalEnvironment: true,
        client: { select: { name: true } },
      },
    }),
    prisma.invoice.count({ where: TRANSACTIONS_WHERE }),
  ]);
  return { data: rows.map(toTransaction), meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } };
}
