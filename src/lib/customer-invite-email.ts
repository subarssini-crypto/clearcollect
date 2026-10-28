/**
 * Customer Portal invitation emails through a Zapier Catch Hook, using the
 * shared delivery helpers in src/lib/zapier.ts (same secret, same honest
 * outcome classification as invoice emails and reminders).
 *
 * Setup: a separate Zap ("Webhooks by Zapier → Catch Hook" → Filter on
 * auth_token → Gmail: To = recipient_email, Subject = subject, Body = message),
 * with its URL in ZAPIER_INVITE_WEBHOOK_URL. It is deliberately not sent to the
 * invoice-email Zap: if that Zap's Filter also checks `event`, Zapier would
 * accept the request and silently drop the email.
 *
 * States (CustomerInvite.emailState): SENDING → ACCEPTED (Zapier 2xx — not proof
 * of delivery) | FAILED (non-2xx/unreachable: not sent) | UNKNOWN (timeout).
 * The recipient is always the client's email stored in MySQL.
 */

import { prisma } from "@/lib/prisma";
import { InviteEmailState } from "@/generated/prisma/enums";
import { formatLongDate, getZapierConfig, postToZapier, validRecipient, type ZapierConfig } from "@/lib/zapier";

export const INVITE_WEBHOOK_URL_VAR = "ZAPIER_INVITE_WEBHOOK_URL";

export type InviteDeliveryMode = "zapier" | "demo" | "misconfigured";

export function inviteEmailDelivery(env: Record<string, string | undefined> = process.env): { mode: InviteDeliveryMode; config: ZapierConfig; detail: string } {
  const config = getZapierConfig(env, { urlVar: INVITE_WEBHOOK_URL_VAR, secretAloneIsMisconfigured: false });
  if (config.state === "configured") {
    return { mode: "zapier", config, detail: "Invitation emails are handed to your invitation Zap." };
  }
  if (config.state === "demo") {
    return {
      mode: "demo",
      config,
      detail: `Invitation emails are not set up: ${INVITE_WEBHOOK_URL_VAR} is not configured. Copy the link and send it to your client yourself.`,
    };
  }
  return { mode: "misconfigured", config, detail: "Invitation email delivery is misconfigured on the server. Copy the link and send it yourself." };
}

export function composeInviteEmail(input: { clientName: string; url: string; expiresAt: Date }) {
  const subject = "You're invited to view and pay your invoices online";
  const message = [
    `Hi ${input.clientName},`,
    "",
    "You've been invited to the ClearCollect Customer Portal, where you can see your invoices, pay them securely with PayPal, and review your payment history.",
    "",
    `Accept your invitation: ${input.url}`,
    "",
    "Create an account (or sign in if you already have one), then choose \"Accept invitation\".",
    `This link works once and expires on ${formatLongDate(input.expiresAt)}.`,
    "",
    "If you weren't expecting this email, you can ignore it.",
  ].join("\n");
  return { subject, message };
}

export type InviteEmailOutcome =
  | { result: "not_requested"; detail: string }
  | { result: "demo" | "misconfigured" | "no_recipient"; detail: string }
  | { result: "accepted" | "failed" | "unknown"; detail: string; recipient: string };

/**
 * Sends the invitation for a just-created invite (whose token is only
 * available now). Never throws for delivery problems: every outcome is
 * recorded on the invite and described honestly for the owner.
 */
export async function sendInviteEmail(
  invite: { id: number; expiresAt: Date },
  client: { name: string; email: string | null },
  url: string,
  deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<InviteEmailOutcome> {
  const clock = deps.now ?? Date.now;
  const delivery = inviteEmailDelivery(deps.env);
  if (delivery.mode === "demo") return { result: "demo", detail: delivery.detail };
  if (delivery.mode === "misconfigured" || delivery.config.state !== "configured") {
    console.error(`[invite-email] Zapier misconfigured: ${delivery.config.state === "misconfigured" ? delivery.config.reason : "unknown"}`);
    return { result: "misconfigured", detail: delivery.detail };
  }
  const recipient = validRecipient(client.email);
  if (!recipient) {
    return { result: "no_recipient", detail: `${client.name} has no valid email address on file, so no email was sent. Copy the link instead.` };
  }

  const claimedAt = new Date(clock());
  const { count } = await prisma.customerInvite.updateMany({
    where: { id: invite.id, emailState: null, usedAt: null, revokedAt: null },
    data: { emailState: InviteEmailState.SENDING, emailStateAt: claimedAt, emailRecipient: recipient },
  });
  if (count !== 1) return { result: "failed", recipient, detail: "This invite changed before it could be emailed; nothing was sent." };

  const { subject, message } = composeInviteEmail({ clientName: client.name, url, expiresAt: invite.expiresAt });
  const outcome = await postToZapier(
    delivery.config,
    {
      event: "customer.invite",
      auth_token: delivery.config.secret, // checked by the Zap's Filter step
      send_id: `invite-${invite.id}-${claimedAt.getTime()}`,
      invite_url: url,
      expires_at: invite.expiresAt.toISOString(),
      client_name: client.name,
      recipient_email: recipient, // Gmail "To"
      subject,
      message,
    },
    { fetchImpl: deps.fetchImpl, logLabel: "invite-email" }
  );

  const finalState =
    outcome.kind === "accepted" ? InviteEmailState.ACCEPTED : outcome.kind === "timeout" ? InviteEmailState.UNKNOWN : InviteEmailState.FAILED;
  await prisma.customerInvite
    .updateMany({ where: { id: invite.id, emailState: InviteEmailState.SENDING, emailStateAt: claimedAt }, data: { emailState: finalState, emailStateAt: new Date(clock()) } })
    .catch((err) => console.error("[invite-email] could not record the outcome", err));

  switch (outcome.kind) {
    case "accepted":
      return {
        result: "accepted",
        recipient,
        detail: `Accepted by Zapier for delivery to ${recipient}. Gmail sending happens in your Zap — check its history to confirm delivery.`,
      };
    case "timeout":
      return {
        result: "unknown",
        recipient,
        detail: "Zapier did not respond in time, so it is unknown whether the email went out. Check your Zap history, or copy the link and send it yourself.",
      };
    case "rejected":
      return { result: "failed", recipient, detail: `Zapier rejected the request (HTTP ${outcome.status}); no email was sent. Copy the link instead.` };
    default:
      return { result: "failed", recipient, detail: "Could not reach Zapier; no email was sent. Copy the link instead." };
  }
}
