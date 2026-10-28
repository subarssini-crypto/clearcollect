/**
 * Saved follow-up reminder drafts and reminder send history
 * (FollowUpReminder rows).
 *
 *   DRAFT ──send──▶ SENDING ──Zapier 2xx──▶ SENT
 *     ▲               ├──timeout──▶ UNKNOWN
 *     └──definite failure (draft) ┘└──definite failure (unsaved text)──▶ FAILED
 *
 * - Only DRAFT rows can be deleted, with one conditional DELETE … WHERE
 *   status = 'DRAFT', so a draft that a concurrent request just claimed for
 *   sending (SENDING) can never be deleted.
 * - SENDING, UNKNOWN, SENT, and FAILED rows are send history and are never
 *   deleted or edited by these functions (only the in-flight row's own
 *   status is advanced by the send that created it).
 * - Status always comes from the server; the browser only names a draft id.
 * - Drafts can only be saved for invoices that can receive reminders
 *   (unpaid SENT/OVERDUE), checked with the same rules as sending.
 */

import { prisma } from "@/lib/prisma";
import { FollowUpStatus } from "@/generated/prisma/enums";
import { FollowUpError, loadRemindableInvoice, validateSendReminder, type SendReminderInput } from "@/lib/follow-up";
import type { ZapierOutcome } from "@/lib/zapier";

export type ReminderStatus = "DRAFT" | "SENDING" | "UNKNOWN" | "SENT" | "FAILED";

export interface ReminderDraft {
  id: number;
  invoiceId: number;
  subject: string;
  message: string;
  updatedAt: string;
}

export interface ReminderStore {
  findLatestDraft(invoiceId: number): Promise<{ id: number } | null>;
  createDraft(invoiceId: number, subject: string, message: string): Promise<{ id: number }>;
  /** DRAFT (of this invoice) → new text. False if it is no longer a DRAFT. */
  updateDraft(id: number, invoiceId: number, subject: string, message: string): Promise<boolean>;
  listDrafts(): Promise<ReminderDraft[]>;
  /** Deletes only a DRAFT row, in one statement. Rows deleted (0 or 1). */
  deleteDraft(id: number): Promise<number>;
  status(id: number): Promise<ReminderStatus | null>;
  /** DRAFT (of this invoice) → SENDING with the text actually sent. False if no longer a DRAFT. */
  claimDraft(id: number, invoiceId: number, fields: SendingFields): Promise<boolean>;
  createSending(invoiceId: number, fields: SendingFields): Promise<{ id: number }>;
  /** SENDING → `to`. Never touches rows in any other state. */
  finishSending(id: number, to: Exclude<ReminderStatus, "SENDING">, sentAt: Date | null): Promise<void>;
}

export interface SendingFields {
  subject: string;
  message: string;
  recipient: string;
  sendStartedAt: Date;
}

export const prismaReminderStore: ReminderStore = {
  findLatestDraft: (invoiceId) =>
    prisma.followUpReminder.findFirst({
      where: { invoiceId, status: FollowUpStatus.DRAFT },
      orderBy: { id: "desc" },
      select: { id: true },
    }),
  createDraft: (invoiceId, subject, message) =>
    prisma.followUpReminder.create({ data: { invoiceId, subject, message }, select: { id: true } }),
  async updateDraft(id, invoiceId, subject, message) {
    const { count } = await prisma.followUpReminder.updateMany({
      where: { id, invoiceId, status: FollowUpStatus.DRAFT },
      data: { subject, message },
    });
    return count === 1;
  },
  async listDrafts() {
    const rows = await prisma.followUpReminder.findMany({
      where: { status: FollowUpStatus.DRAFT },
      orderBy: { id: "desc" },
      select: { id: true, invoiceId: true, subject: true, message: true, updatedAt: true },
    });
    return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
  },
  async deleteDraft(id) {
    const { count } = await prisma.followUpReminder.deleteMany({ where: { id, status: FollowUpStatus.DRAFT } });
    return count;
  },
  async status(id) {
    const row = await prisma.followUpReminder.findUnique({ where: { id }, select: { status: true } });
    return row?.status ?? null;
  },
  async claimDraft(id, invoiceId, fields) {
    const { count } = await prisma.followUpReminder.updateMany({
      where: { id, invoiceId, status: FollowUpStatus.DRAFT },
      data: { status: FollowUpStatus.SENDING, ...fields },
    });
    return count === 1;
  },
  createSending: (invoiceId, fields) =>
    prisma.followUpReminder.create({
      data: { invoiceId, status: FollowUpStatus.SENDING, ...fields },
      select: { id: true },
    }),
  async finishSending(id, to, sentAt) {
    await prisma.followUpReminder.updateMany({
      where: { id, status: FollowUpStatus.SENDING },
      // A failed draft goes back to being an editable, unsent draft.
      data: to === "DRAFT" ? { status: to, recipient: null, sendStartedAt: null } : { status: to, sentAt },
    });
  },
};

// ── Drafts ────────────────────────────────────────────────────────────────────

const NOT_A_DRAFT = "This reminder is no longer an unsent draft (it was sent, is being sent, or was deleted). Reload the page.";

/**
 * Saves the reminder text as the invoice's draft: updates `draftId` (or the
 * invoice's latest draft), otherwise creates one. Returns the draft id.
 */
export async function saveReminderDraft(
  body: unknown,
  store: ReminderStore = prismaReminderStore,
  loadInvoice: (id: number) => Promise<unknown> = loadRemindableInvoice
): Promise<{ id: number }> {
  const input = validateSendReminder(body);
  if (!input.ok) throw new DraftValidationError(input.errors);
  const draftId = parseOptionalId((body as { draftId?: unknown }).draftId, "draftId");
  const { invoiceId, subject, message } = input.data;

  await loadInvoice(invoiceId); // 404 / 409 unless the invoice can receive reminders

  const target = draftId ?? (await store.findLatestDraft(invoiceId))?.id ?? null;
  if (target !== null) {
    if (await store.updateDraft(target, invoiceId, subject, message)) return { id: target };
    if (draftId !== null) throw new FollowUpError(NOT_A_DRAFT, 409);
  }
  return store.createDraft(invoiceId, subject, message);
}

/** Deletes an unsent draft. Send history (any other status) is never deleted. */
export async function deleteReminderDraft(id: number, store: ReminderStore = prismaReminderStore): Promise<void> {
  if ((await store.deleteDraft(id)) === 1) return;
  const status = await store.status(id);
  switch (status) {
    case null:
      throw new FollowUpError(`Reminder draft ${id} not found (it may already have been deleted)`, 404);
    case "SENDING":
      throw new FollowUpError("This reminder is being sent right now and cannot be deleted.", 409);
    case "UNKNOWN":
      throw new FollowUpError("This reminder's delivery outcome is uncertain, so it is kept as history and cannot be deleted.", 409);
    default:
      throw new FollowUpError("This reminder was already sent or attempted; send history cannot be deleted.", 409);
  }
}

// ── Send history ──────────────────────────────────────────────────────────────

/**
 * Hooks for deliverReminder that record a real (non-demo) send. `begin` runs
 * just before the Zapier request and claims the draft (or creates a history
 * row for unsaved text); `finish` records the outcome.
 */
export function reminderAudit(invoiceId: number, input: SendReminderInput, draftId: number | null, store: ReminderStore = prismaReminderStore) {
  let rowId: number | null = null;
  return {
    async begin(recipient: string, now: Date) {
      const fields = { subject: input.subject, message: input.message, recipient, sendStartedAt: now };
      if (draftId !== null) {
        if (!(await store.claimDraft(draftId, invoiceId, fields))) throw new FollowUpError(NOT_A_DRAFT, 409);
        rowId = draftId;
      } else {
        rowId = (await store.createSending(invoiceId, fields)).id;
      }
    },
    async finish(outcome: ZapierOutcome["kind"], now: Date) {
      if (rowId === null) return;
      if (outcome === "accepted") await store.finishSending(rowId, "SENT", now);
      else if (outcome === "timeout") await store.finishSending(rowId, "UNKNOWN", null);
      else await store.finishSending(rowId, draftId !== null ? "DRAFT" : "FAILED", null);
    },
  };
}

export type ReminderAudit = ReturnType<typeof reminderAudit>;

// ── Input helpers ─────────────────────────────────────────────────────────────

export class DraftValidationError extends Error {
  constructor(public errors: { field: string; message: string }[]) {
    super(errors.map((e) => e.message).join(" "));
  }
}

/** An optional positive integer id from a JSON body; throws DraftValidationError otherwise. */
export function parseOptionalId(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DraftValidationError([{ field, message: `${field} must be a positive integer` }]);
  }
  return value;
}
