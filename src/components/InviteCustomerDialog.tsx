"use client";

/**
 * Owner dialog for Customer Portal invitations (Clients page). Confirms the
 * client's name and email, shows existing invites and linked accounts, and
 * creates / regenerates / revokes invites through /api/clients/[id]/invites.
 *
 * The invitation link exists only in the create response (only its hash is
 * stored), so it is shown here once, inside the dialog, with a copy button.
 * Email feedback distinguishes "accepted by Zapier" from delivery, which the
 * app cannot confirm.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Notice, btnPrimary, btnSecondary } from "@/components/ui";

type InviteStatus = "pending" | "accepted" | "expired" | "revoked";
type EmailStatus = "not_sent" | "sending" | "accepted_by_zapier" | "unknown" | "failed";
type Invite = {
  id: number;
  status: InviteStatus;
  email: EmailStatus;
  emailRecipient: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: { name: string; email: string } | null;
};
type Overview = {
  client: { name: string; email: string | null; company: string | null; archived: boolean };
  invites: Invite[];
  linkedAccounts: { name: string; email: string; linkedAt: string | null }[];
  delivery: { mode: "zapier" | "demo" | "misconfigured"; detail: string };
};
type EmailOutcome = { result: "not_requested" | "demo" | "misconfigured" | "no_recipient" | "accepted" | "failed" | "unknown"; detail: string };
type Created = { url: string; email: EmailOutcome };

export const INVITE_STATUS_LABEL: Record<InviteStatus, { text: string; className: string }> = {
  pending: { text: "Pending", className: "bg-amber-50 text-amber-700" },
  accepted: { text: "Accepted", className: "bg-emerald-50 text-emerald-700" },
  expired: { text: "Expired", className: "bg-slate-100 text-slate-600" },
  revoked: { text: "Revoked", className: "bg-slate-100 text-slate-500" },
};

export const EMAIL_STATUS_LABEL: Record<EmailStatus, string> = {
  not_sent: "Link only (no email)",
  sending: "Email sending…",
  accepted_by_zapier: "Email accepted by Zapier",
  unknown: "Email outcome unknown",
  failed: "Email failed",
};

const OUTCOME_TONE: Record<EmailOutcome["result"], "success" | "info" | "warning" | "error"> = {
  accepted: "success",
  not_requested: "info",
  demo: "warning",
  misconfigured: "error",
  no_recipient: "warning",
  unknown: "warning",
  failed: "error",
};

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function readJson<T>(res: Response): Promise<{ ok?: boolean; data?: T; error?: string; errors?: { message: string }[] }> {
  try {
    return await res.json();
  } catch {
    return { error: `The server returned an unexpected response (HTTP ${res.status}).` };
  }
}

export function InviteCustomerDialog({ clientId, clientName, onClose, onChanged }: { clientId: number; clientName: string; onClose: () => void; onChanged: () => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"create" | "revoke" | null>(null);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  // Synchronous guard: a double click cannot start two requests before React re-renders.
  const inFlight = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/clients/${clientId}/invites`, { cache: "no-store" });
    const json = await readJson<Overview>(res);
    if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Could not load invitations.");
    return json.data;
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((data) => !cancelled && setOverview(data))
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : "Could not load invitations."));
    closeRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !inFlight.current && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(kind: "create" | "revoke", action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    setError("");
    try {
      await action();
      setOverview(await load());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const create = (send: boolean, regenerate: boolean) =>
    run("create", async () => {
      setCreated(null);
      setCopied(false);
      const res = await fetch(`/api/clients/${clientId}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ send, regenerate }),
      });
      const json = await readJson<Created>(res);
      if (!res.ok || !json.ok || !json.data) throw new Error(json.errors?.[0]?.message || json.error || "The invitation was not created.");
      setCreated(json.data);
    });

  const revoke = (invite: Invite) =>
    run("revoke", async () => {
      const res = await fetch(`/api/clients/${clientId}/invites/${invite.id}`, { method: "DELETE" });
      const json = await readJson<unknown>(res);
      if (!res.ok || !json.ok) throw new Error(json.error || "The invitation was not revoked.");
      setCreated(null);
    });

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      setError("Copy failed — select the link and copy it manually.");
    }
  }

  const pending = overview?.invites.find((i) => i.status === "pending") ?? null;
  const canEmail = overview?.delivery.mode === "zapier" && !!overview.client.email;
  const disabled = busy !== null || !overview || overview.client.archived;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 text-left whitespace-normal"
      onMouseDown={(e) => e.target === e.currentTarget && !inFlight.current && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="invite-dialog-title" className="card flex max-h-[90vh] w-full max-w-lg flex-col p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="invite-dialog-title" className="text-base font-bold text-navy">
              Invite customer to the portal
            </h2>
            <p className="mt-0.5 text-[13px] text-muted">They’ll see this client’s invoices and payment history after accepting.</p>
          </div>
          <button ref={closeRef} type="button" aria-label="Close dialog" disabled={busy !== null} onClick={onClose} className="rounded-lg px-2 py-1 text-xl text-slate-400 hover:bg-canvas hover:text-navy disabled:opacity-50">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {loadError && <Notice tone="error">{loadError}</Notice>}
          {!overview && !loadError && <p className="text-[13px] text-muted">Loading…</p>}

          {overview && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-canvas p-3 text-[13px]">
                <dt className="font-medium text-muted">Client</dt>
                <dd className="font-semibold text-navy">{overview.client.name || clientName}</dd>
                <dt className="font-medium text-muted">Email</dt>
                <dd className="break-all text-navy">{overview.client.email || <span className="text-muted">No email on file — use the link instead</span>}</dd>
              </dl>

              {overview.client.archived && <Notice tone="warning">This client is archived. Restore it before inviting.</Notice>}

              {overview.delivery.mode === "zapier" ? (
                <p className="text-xs text-muted">
                  Invitation emails go to your invitation Zap. Zapier accepting a request does not confirm Gmail delivered it — check your Zap history.
                </p>
              ) : (
                <Notice tone={overview.delivery.mode === "demo" ? "info" : "error"}>
                  {overview.delivery.detail}
                  {overview.delivery.mode === "demo" && (
                    <>
                      {" "}
                      To send emails, add a Zap (Catch Hook → Filter on auth_token → Gmail) and set <code className="font-mono">ZAPIER_INVITE_WEBHOOK_URL</code>.
                    </>
                  )}
                </Notice>
              )}

              {created && (
                <div role="status" className="space-y-2 rounded-lg border border-line p-3">
                  <Notice tone={OUTCOME_TONE[created.email.result]}>{created.email.detail}</Notice>
                  <label htmlFor="invite-link" className="block text-xs font-medium text-muted">
                    Invitation link — shown only now; works once; expires in 7 days
                  </label>
                  <div className="flex gap-2">
                    <input id="invite-link" readOnly value={created.url} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2 py-1.5 font-mono text-[11px] text-navy" />
                    <button id="invite-copy" type="button" onClick={copy} className={`${btnSecondary} py-1.5 text-xs`}>
                      {copied ? "Copied" : "Copy link"}
                    </button>
                  </div>
                </div>
              )}

              {error && <Notice tone="error">{error}</Notice>}

              {overview.linkedAccounts.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-muted">Linked portal accounts</h3>
                  <ul className="space-y-1 text-[13px]">
                    {overview.linkedAccounts.map((a) => (
                      <li key={a.email} className="text-navy">
                        {a.name} <span className="text-muted">· {a.email}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {overview.invites.length > 0 && (
                <div>
                  <h3 className="mb-1 text-xs font-semibold text-muted">Invitations</h3>
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {overview.invites.map((invite) => (
                      <li key={invite.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                        <span className={`rounded-full px-2 py-0.5 font-semibold ${INVITE_STATUS_LABEL[invite.status].className}`}>{INVITE_STATUS_LABEL[invite.status].text}</span>
                        <span className="text-muted">{EMAIL_STATUS_LABEL[invite.email]}</span>
                        <span className="text-muted">
                          · {invite.status === "accepted" && invite.acceptedBy
                            ? `by ${invite.acceptedBy.email}`
                            : `${invite.status === "pending" ? "expires" : "created"} ${shortDate(invite.status === "pending" ? invite.expiresAt : invite.createdAt)}`}
                        </span>
                        {invite.status === "pending" && (
                          <button type="button" onClick={() => revoke(invite)} disabled={busy !== null} className="ml-auto font-semibold text-red-700 hover:text-red-800 disabled:opacity-50">
                            {busy === "revoke" ? "Revoking…" : "Revoke"}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {pending && !created && (
                <p className="text-xs text-muted">
                  A pending invitation exists. Its link can’t be shown again; regenerating creates a new link and the old one stops working.
                </p>
              )}
            </>
          )}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-3">
          <button type="button" onClick={() => create(false, !!pending)} disabled={disabled} className={btnSecondary}>
            {busy === "create" ? "Working…" : pending ? "Regenerate link only" : "Create link only"}
          </button>
          <button
            id="invite-send"
            type="button"
            onClick={() => create(true, !!pending)}
            disabled={disabled || !canEmail}
            title={canEmail ? undefined : "Email needs ZAPIER_INVITE_WEBHOOK_URL and a client email"}
            className={btnPrimary}
          >
            {busy === "create" ? "Working…" : pending ? "Regenerate & email" : "Send invitation email"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
