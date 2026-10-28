/**
 * Owner-issued invites: the only way a Customer account becomes linked to a
 * Client (and so sees that client's invoices).
 *
 * - The owner creates an invite for one active client. Only SHA-256(token)
 *   is stored, so the link can be shown once (in the owner's dialog and the
 *   invitation email) and never again; a lost link is replaced by
 *   regenerating, which revokes the old one.
 * - At most one invite per client is pending at a time. This is enforced by
 *   the unique activeForClientId column, so repeated or concurrent "Invite"
 *   clicks cannot create several live links.
 * - Invites expire after INVITE_TTL_MS, are single-use, and can be revoked
 *   while unused.
 * - Redeeming is one transaction: the invite is claimed with a conditional
 *   update, and the account is linked only if it is unlinked or already linked
 *   to the same client, so two accounts cannot redeem one invite and an
 *   account is never moved to a different client.
 * - Email addresses are never used to link accounts.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A SENDING claim older than this is treated as interrupted (outcome unknown). */
export const INVITE_SEND_STALE_MS = 2 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isWellFormedInviteToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function inviteUrl(origin: string, token: string): string {
  const url = new URL("/portal/invite", origin);
  url.searchParams.set("token", token);
  return url.toString();
}

export class InviteError extends Error {
  constructor(message: string, public status: number, public code = "invite_error") {
    super(message);
  }
}

// ── Owner view ────────────────────────────────────────────────────────────────

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";
export type InviteEmailStatus = "not_sent" | "sending" | "accepted_by_zapier" | "unknown" | "failed";

export interface InviteRow {
  id: number;
  clientId: number;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  emailState: "SENDING" | "ACCEPTED" | "UNKNOWN" | "FAILED" | null;
  emailStateAt: Date | null;
  emailRecipient: string | null;
  createdAt: Date;
  usedBy?: { name: string; email: string } | null;
}

export interface InviteView {
  id: number;
  status: InviteStatus;
  email: InviteEmailStatus;
  emailRecipient: string | null;
  emailAt: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: { name: string; email: string } | null;
  revokedAt: string | null;
}

export function inviteStatus(row: Pick<InviteRow, "usedAt" | "revokedAt" | "expiresAt">, now = new Date()): InviteStatus {
  if (row.usedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt <= now) return "expired";
  return "pending";
}

export function inviteEmailStatus(row: Pick<InviteRow, "emailState" | "emailStateAt">, now = new Date()): InviteEmailStatus {
  switch (row.emailState) {
    case "ACCEPTED":
      return "accepted_by_zapier";
    case "FAILED":
      return "failed";
    case "UNKNOWN":
      return "unknown";
    case "SENDING":
      return row.emailStateAt && now.getTime() - row.emailStateAt.getTime() < INVITE_SEND_STALE_MS ? "sending" : "unknown";
    default:
      return "not_sent";
  }
}

export function toInviteView(row: InviteRow, now = new Date()): InviteView {
  return {
    id: row.id,
    status: inviteStatus(row, now),
    email: inviteEmailStatus(row, now),
    emailRecipient: row.emailRecipient,
    emailAt: row.emailStateAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.usedAt?.toISOString() ?? null,
    acceptedBy: row.usedBy ? { name: row.usedBy.name, email: row.usedBy.email } : null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const ROW_SELECT = {
  id: true,
  clientId: true,
  expiresAt: true,
  usedAt: true,
  revokedAt: true,
  emailState: true,
  emailStateAt: true,
  emailRecipient: true,
  createdAt: true,
  usedBy: { select: { name: true, email: true } },
} as const;

/** Owner only: a client's invites (newest first) and the accounts linked to it. */
export async function listInvites(clientId: number, now = new Date()) {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      email: true,
      company: true,
      archivedAt: true,
      customerInvites: { select: ROW_SELECT, orderBy: { createdAt: "desc" }, take: 20 },
      customers: { select: { name: true, email: true, linkedAt: true }, orderBy: { linkedAt: "asc" } },
    },
  });
  if (!client) return null;
  return {
    client: { id: client.id, name: client.name, email: client.email, company: client.company, archived: client.archivedAt !== null },
    invites: client.customerInvites.map((row) => toInviteView(row, now)),
    linkedAccounts: client.customers.map((c) => ({ name: c.name, email: c.email, linkedAt: c.linkedAt?.toISOString() ?? null })),
  };
}

// ── Create, regenerate, revoke ────────────────────────────────────────────────

/** Pending = unused, unrevoked, unexpired. */
function pendingWhere(clientId: number, now: Date) {
  return { clientId, usedAt: null, revokedAt: null, expiresAt: { gt: now } };
}

/**
 * Owner only: a new invite token for an active client. Refuses (409
 * "pending_exists") while another invite is pending unless `regenerate`, which
 * revokes the pending one in the same transaction.
 */
export async function createInvite(
  clientId: number,
  { regenerate = false, now = new Date() }: { regenerate?: boolean; now?: Date } = {}
): Promise<{ token: string; invite: InviteRow; client: { id: number; name: string; email: string | null } }> {
  const token = randomBytes(32).toString("base64url");
  try {
    return await prisma.$transaction(async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, email: true, archivedAt: true } });
      if (!client) throw new InviteError(`Client ${clientId} not found`, 404, "not_found");
      if (client.archivedAt) {
        throw new InviteError("Restore this client before inviting them to the Customer Portal", 409, "archived");
      }

      // Expired invites no longer hold the client's pending slot.
      await tx.customerInvite.updateMany({
        where: { activeForClientId: clientId, expiresAt: { lte: now } },
        data: { activeForClientId: null },
      });
      if (regenerate) {
        await tx.customerInvite.updateMany({ where: pendingWhere(clientId, now), data: { revokedAt: now, activeForClientId: null } });
      } else if (await tx.customerInvite.count({ where: pendingWhere(clientId, now) })) {
        throw new InviteError(
          "This client already has a pending invite. Regenerate it to get a new link (the old one stops working), or revoke it.",
          409,
          "pending_exists"
        );
      }

      const invite = await tx.customerInvite.create({
        data: {
          clientId,
          tokenHash: hashInviteToken(token),
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          activeForClientId: clientId,
        },
        select: ROW_SELECT,
      });
      return { token, invite, client: { id: client.id, name: client.name, email: client.email } };
    });
  } catch (err) {
    // A concurrent request took the pending slot first (unique violation, or
    // MySQL resolving the competing inserts as a deadlock).
    const code = (err as { code?: string }).code;
    if (code === "P2002" || code === "P2034") {
      throw new InviteError("Another invite for this client was just created. Reload to see it.", 409, "pending_exists");
    }
    throw err;
  }
}

/** Owner only: revokes an unused invite. The invite must belong to `clientId`. */
export async function revokeInvite(clientId: number, inviteId: number, now = new Date()): Promise<InviteRow> {
  const { count } = await prisma.customerInvite.updateMany({
    where: { id: inviteId, clientId, usedAt: null, revokedAt: null },
    data: { revokedAt: now, activeForClientId: null },
  });
  const row = await prisma.customerInvite.findFirst({ where: { id: inviteId, clientId }, select: ROW_SELECT });
  if (!row) throw new InviteError("Invite not found", 404, "not_found");
  if (count === 0) {
    throw new InviteError(row.usedAt ? "This invite was already accepted and cannot be revoked." : "This invite was already revoked.", 409, "not_revocable");
  }
  return row;
}

// ── Customer side ─────────────────────────────────────────────────────────────

/** Public preview for the invite page: the business-facing client name, or null if unusable. */
export async function previewInvite(token: unknown, now = new Date()): Promise<{ clientName: string } | null> {
  if (!isWellFormedInviteToken(token)) return null;
  const invite = await prisma.customerInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: { usedAt: true, revokedAt: true, expiresAt: true, client: { select: { name: true, company: true, archivedAt: true } } },
  });
  if (!invite || inviteStatus(invite, now) !== "pending" || invite.client.archivedAt) return null;
  return { clientName: invite.client.company || invite.client.name };
}

export type RedeemResult = "linked" | "invalid" | "linked_elsewhere";

/** Links `customerId` to the invite's client and consumes the invite, atomically. */
export async function redeemInvite(customerId: number, token: unknown, now = new Date()): Promise<RedeemResult> {
  if (!isWellFormedInviteToken(token)) return "invalid";
  const tokenHash = hashInviteToken(token);

  return prisma.$transaction(async (tx) => {
    const invite = await tx.customerInvite.findUnique({
      where: { tokenHash },
      select: { id: true, clientId: true, client: { select: { archivedAt: true } } },
    });
    if (!invite || invite.client.archivedAt) return "invalid";

    const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { clientId: true } });
    if (!customer) return "invalid";
    if (customer.clientId !== null && customer.clientId !== invite.clientId) return "linked_elsewhere";

    const claimed = await tx.customerInvite.updateMany({
      where: { id: invite.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, usedByCustomerId: customerId, activeForClientId: null },
    });
    if (claimed.count !== 1) return "invalid";

    const linked = await tx.customer.updateMany({
      where: { id: customerId, OR: [{ clientId: null }, { clientId: invite.clientId }] },
      data: { clientId: invite.clientId, linkedAt: now },
    });
    if (linked.count !== 1) throw new InviteError("Account changed while linking; try again", 409); // rolls back the claim
    return "linked";
  });
}

export const REDEEM_MESSAGES: Record<RedeemResult, string> = {
  linked: "Invitation accepted. Your invoices are below.",
  invalid: "This invitation is invalid, expired, revoked, or already used. Ask the sender for a new one.",
  linked_elsewhere:
    "This account is already linked to a different client, so the invitation was not used. Sign in with another account or contact the sender.",
};
