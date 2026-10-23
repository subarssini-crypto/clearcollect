"use client";

/**
 * Sends a saved DRAFT invoice to its client (POST /api/invoices/[id]/send).
 *
 * Opens a confirmation dialog showing the server-built preview — the real
 * recipient from MySQL, subject, and message — before anything is sent.
 * A timed-out or earlier send needs an explicit "send again" confirmation,
 * and an unknown outcome offers "mark as sent" instead of encouraging a retry.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Notice, btnPrimary, btnSecondary } from "@/components/ui";

type Preview = {
  invoiceNumber: string;
  delivery: "zapier" | "demo" | "misconfigured";
  recipient: string;
  subject: string;
  message: string;
  inProgress: boolean;
  resendWarning: string | null;
};

type Result = { tone: "success" | "info" | "error" | "warning"; text: string; unknown?: boolean };

type Json<T> = { ok: boolean; data?: T; error?: string; code?: string; errors?: { message: string }[] };

async function readJson<T>(res: Response): Promise<Json<T>> {
  try {
    return await res.json();
  } catch {
    return { ok: false, error: `The server returned an unexpected response (HTTP ${res.status}).` };
  }
}

function errorText(json: Json<unknown>, fallback: string) {
  return json.errors?.map((e) => e.message).join(" ") || json.error || fallback;
}

export function SendInvoiceButton({
  invoiceId,
  invoiceNumber,
  onSent,
  className = btnPrimary,
  label = "Send Invoice",
}: {
  invoiceId: number;
  invoiceNumber: string;
  /** Called after Zapier accepts the email (the invoice is now SENT). */
  onSent?: () => void;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirmResend, setConfirmResend] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [sent, setSent] = useState(false);
  // Synchronous guard: a fast double click must not start two sends.
  const sendingRef = useRef(false);

  async function loadPreview() {
    setLoading(true);
    setPreview(null);
    setConfirmResend(false);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/send`, { cache: "no-store" });
      const json = await readJson<Preview>(res);
      if (!res.ok || !json.ok || !json.data) throw new Error(errorText(json, "Could not prepare the invoice email."));
      setPreview(json.data);
    } catch (err) {
      setResult({ tone: "error", text: err instanceof Error ? err.message : "Could not prepare the invoice email." });
    } finally {
      setLoading(false);
    }
  }

  function openDialog() {
    setResult(null);
    setOpen(true);
    loadPreview();
  }

  function close() {
    if (!sending) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function send() {
    if (sendingRef.current || !preview) return;
    sendingRef.current = true;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmResend }),
      });
      const json = await readJson<{ mode: "demo" | "zapier"; accepted: boolean; detail: string }>(res);
      if (res.ok && json.ok && json.data) {
        if (json.data.accepted) {
          setSent(true);
          setResult({ tone: "success", text: json.data.detail });
          onSent?.();
        } else {
          setResult({ tone: "info", text: json.data.detail });
        }
        return;
      }
      const text = errorText(json, "The invoice email was not sent.");
      if (json.code === "unknown_outcome" || json.code === "accepted_not_recorded") {
        setResult({ tone: "warning", text, unknown: true });
      } else {
        setResult({ tone: "error", text });
      }
      // Show the current state (e.g. the confirmation now required).
      if (json.code === "confirm_required" || json.code === "claim_lost" || json.code === "in_progress") loadPreview();
    } catch {
      setResult({
        tone: "warning",
        text: "The connection to ClearCollect was lost, so it is unknown whether the email was sent. Reopen this dialog to see the invoice's current state before trying again.",
        unknown: true,
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function markAsSent() {
    setSending(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "SENT" }),
      });
      const json = await readJson<unknown>(res);
      if (!res.ok || !json.ok) throw new Error(errorText(json, "Could not mark the invoice as sent."));
      setSent(true);
      setResult({ tone: "success", text: `${invoiceNumber} is marked SENT. No email was sent by this action.` });
      onSent?.();
    } catch (err) {
      setResult({ tone: "error", text: err instanceof Error ? err.message : "Could not mark the invoice as sent." });
    } finally {
      setSending(false);
    }
  }

  const blocked =
    !preview || preview.delivery === "misconfigured" || preview.inProgress || (!!preview.resendWarning && !confirmResend);

  return (
    <>
      <button type="button" id={`send-invoice-${invoiceId}`} onClick={openDialog} disabled={sent} className={className}>
        {sent ? "Sent" : label}
      </button>

      {/* Portaled to <body>: the button may sit in a right-aligned, nowrap
          table cell (Invoices page), whose text-align and white-space would
          otherwise be inherited by the dialog. text-left/whitespace-normal
          keep it independent of any container either way. */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 text-left whitespace-normal"
          onMouseDown={(event) => event.target === event.currentTarget && close()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`send-invoice-title-${invoiceId}`}
            className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-line bg-surface p-5 shadow-xl"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 id={`send-invoice-title-${invoiceId}`} className="text-lg font-bold text-navy">
                  Send invoice {invoiceNumber}
                </h2>
                <p className="mt-0.5 text-[13px] text-muted">Review the email. It goes to the client email saved in ClearCollect.</p>
              </div>
              <button
                type="button"
                aria-label="Close dialog"
                disabled={sending}
                onClick={close}
                className="rounded-lg px-2 py-1 text-xl text-slate-400 hover:bg-canvas hover:text-navy disabled:opacity-50"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
              {loading && <p className="text-[13px] text-muted">Preparing the email…</p>}

              {preview && (
                <>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                    <dt className="font-medium text-muted">To</dt>
                    <dd className="break-all font-semibold text-navy">{preview.recipient}</dd>
                    <dt className="font-medium text-muted">Subject</dt>
                    <dd className="text-navy">{preview.subject}</dd>
                  </dl>
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 font-sans text-xs leading-relaxed text-navy">
                    {preview.message}
                  </pre>
                  <p className="text-xs text-muted">No PDF is attached and no payment link is included.</p>

                  {preview.delivery === "demo" && (
                    <Notice tone="info">Demo mode — the invoice email Zap is not configured, so nothing will be sent and the invoice stays a DRAFT.</Notice>
                  )}
                  {preview.delivery === "misconfigured" && (
                    <Notice tone="error">Invoice email delivery is misconfigured on the server, so it cannot be sent.</Notice>
                  )}
                  {preview.inProgress && <Notice tone="warning">This invoice is being sent right now. Wait a moment and reopen this dialog.</Notice>}
                  {preview.resendWarning && !preview.inProgress && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
                      <p>{preview.resendWarning}</p>
                      <label className="mt-2 flex items-start gap-2 font-medium">
                        <input
                          type="checkbox"
                          checked={confirmResend}
                          onChange={(e) => setConfirmResend(e.target.checked)}
                          className="mt-0.5"
                        />
                        I checked the Zap history and want to send this email again.
                      </label>
                    </div>
                  )}
                </>
              )}

              {result && (
                <div role="status" aria-live="polite">
                  <Notice tone={result.tone}>{result.text}</Notice>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
              {result?.unknown && !sent && (
                <button type="button" onClick={markAsSent} disabled={sending} className={btnSecondary}>
                  Zap history shows it was sent — mark as SENT
                </button>
              )}
              <button type="button" onClick={close} disabled={sending} className={btnSecondary}>
                {sent ? "Close" : "Cancel"}
              </button>
              {!sent && !result?.unknown && (
                <button type="button" id={`confirm-send-invoice-${invoiceId}`} onClick={send} disabled={sending || blocked} className={btnPrimary}>
                  {sending ? "Sending…" : preview?.delivery === "demo" ? "Send (Demo)" : "Send email"}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
