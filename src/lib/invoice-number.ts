/**
 * Invoice number allocation in the existing INV-YYYY-NNN format.
 *
 * The next number is derived from the highest existing number for the year.
 * Concurrency is handled by the database: `invoiceNumber` is unique, so if two
 * requests pick the same number one insert fails with P2002, and that request
 * re-reads the latest numbers and retries. Existing invoices are never touched.
 */

import { prisma } from "@/lib/prisma";

export const MAX_ALLOCATION_ATTEMPTS = 5;

const NUMBER_PATTERN = /^INV-(\d{4})-(\d+)$/;

/** Next INV-YYYY-NNN after the highest number for `year` (at least 3 digits). */
export function nextInvoiceNumber(existing: string[], year: number): string {
  let max = 0;
  for (const value of existing) {
    const match = NUMBER_PATTERN.exec(value);
    if (match && Number(match[1]) === year) max = Math.max(max, Number(match[2]));
  }
  return `INV-${year}-${String(max + 1).padStart(3, "0")}`;
}

/** True for a Prisma unique-constraint error on the invoiceNumber column. */
export function isInvoiceNumberConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null || (err as { code?: unknown }).code !== "P2002") {
    return false;
  }
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  // MySQL reports the index name (Invoice_invoiceNumber_key); others report field names.
  return Array.isArray(target)
    ? target.some((t) => String(t).includes("invoiceNumber"))
    : String(target ?? "").includes("invoiceNumber");
}

export class InvoiceNumberExhaustedError extends Error {
  constructor() {
    super("Could not allocate a unique invoice number; please retry");
  }
}

/**
 * Calls `create` with a fresh invoice number, retrying on number conflicts.
 * `listNumbers` returns existing numbers for the year (injectable for tests).
 */
export async function createWithInvoiceNumber<T>(
  year: number,
  create: (invoiceNumber: string) => Promise<T>,
  listNumbers: (year: number) => Promise<string[]> = listInvoiceNumbersForYear,
  maxAttempts = MAX_ALLOCATION_ATTEMPTS
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = nextInvoiceNumber(await listNumbers(year), year);
    try {
      return await create(candidate);
    } catch (err) {
      if (!isInvoiceNumberConflict(err)) throw err;
    }
  }
  throw new InvoiceNumberExhaustedError();
}

async function listInvoiceNumbersForYear(year: number): Promise<string[]> {
  const rows = await prisma.invoice.findMany({
    where: { invoiceNumber: { startsWith: `INV-${year}-` } },
    select: { invoiceNumber: true },
  });
  return rows.map((r) => r.invoiceNumber);
}
