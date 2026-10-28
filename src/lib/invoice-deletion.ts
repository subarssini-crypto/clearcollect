/**
 * Deleting draft invoices.
 *
 * Only a DRAFT invoice with no financial or delivery history can be deleted:
 * no PayPal order or capture, no recorded payment, never emailed (no invoice
 * email state), and no follow-up reminder rows. Eligibility is re-checked by
 * the DELETE statement itself (a single conditional DELETE … WHERE … AND NOT
 * EXISTS reminders), so a concurrent send, payment, or second delete cannot
 * slip in between the check and the delete. Nothing cascades: reminders
 * reference invoices with ON DELETE RESTRICT.
 */

import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { InvoiceStatus } from "@/generated/prisma/enums";

export class InvoiceDeletionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface DeletionCandidate {
  invoiceNumber: string;
  status: string;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  paidAt: Date | null;
  emailState: string | null;
  reminderCount: number;
}

/** Why the invoice cannot be deleted, or null if it can. */
export function deletionBlocker(invoice: DeletionCandidate): string | null {
  const n = invoice.invoiceNumber;
  if (invoice.status === InvoiceStatus.PAID || invoice.paypalCaptureId || invoice.paidAt) {
    return `${n} has a recorded payment and cannot be deleted.`;
  }
  if (invoice.status !== InvoiceStatus.DRAFT) {
    return `Only draft invoices can be deleted. ${n} is ${invoice.status}.`;
  }
  if (invoice.paypalOrderId) return `${n} has a PayPal payment started and cannot be deleted.`;
  if (invoice.emailState === "SENDING") return `${n} is being emailed right now; try again in a moment.`;
  if (invoice.emailState) return `${n} has already been emailed (or may have been) and cannot be deleted.`;
  if (invoice.reminderCount > 0) return `${n} has payment reminder history and cannot be deleted.`;
  return null;
}

export interface InvoiceDeletionStore {
  load(id: number): Promise<DeletionCandidate | null>;
  /** Deletes only if still eligible, in one statement. Returns rows deleted (0 or 1). */
  deleteIfEligible(id: number): Promise<number>;
}

export const prismaInvoiceDeletionStore: InvoiceDeletionStore = {
  async load(id) {
    const row = await prisma.invoice.findUnique({
      where: { id },
      select: {
        invoiceNumber: true,
        status: true,
        paypalOrderId: true,
        paypalCaptureId: true,
        paidAt: true,
        emailState: true,
        _count: { select: { reminders: true } },
      },
    });
    if (!row) return null;
    const { _count, ...rest } = row;
    return { ...rest, reminderCount: _count.reminders };
  },

  async deleteIfEligible(id) {
    try {
      const { count } = await prisma.invoice.deleteMany({
        where: {
          id,
          status: InvoiceStatus.DRAFT,
          paypalOrderId: null,
          paypalCaptureId: null,
          paidAt: null,
          emailState: null,
          reminders: { none: {} },
        },
      });
      return count;
    } catch (err) {
      // A reminder created concurrently: the foreign key refuses the delete.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") return 0;
      throw err;
    }
  },
};

/** Deletes a draft invoice or throws InvoiceDeletionError explaining why not. */
export async function deleteDraftInvoice(
  id: number,
  store: InvoiceDeletionStore = prismaInvoiceDeletionStore
): Promise<{ invoiceNumber: string }> {
  const invoice = await store.load(id);
  if (!invoice) throw new InvoiceDeletionError(`Invoice ${id} not found`, 404);
  const blocker = deletionBlocker(invoice);
  if (blocker) throw new InvoiceDeletionError(blocker, 409);

  if ((await store.deleteIfEligible(id)) === 1) return { invoiceNumber: invoice.invoiceNumber };

  // Something changed between the check and the delete: explain the current state.
  const current = await store.load(id);
  if (!current) throw new InvoiceDeletionError(`${invoice.invoiceNumber} was already deleted.`, 404);
  throw new InvoiceDeletionError(
    deletionBlocker(current) ?? `${invoice.invoiceNumber} changed while deleting; reload and try again.`,
    409
  );
}
