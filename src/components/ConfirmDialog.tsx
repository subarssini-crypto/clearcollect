"use client";

/**
 * Confirmation dialog for destructive or state-changing actions (delete a
 * draft invoice, archive a client, delete a reminder draft). Portaled to
 * <body> like the send-invoice dialog, so table-cell alignment never leaks in.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Notice, btnPrimary, btnSecondary } from "@/components/ui";

export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-500 dark:hover:bg-red-400";

export function ConfirmDialog({
  id,
  title,
  children,
  confirmLabel,
  busyLabel = "Working…",
  danger = false,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  id: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  danger?: boolean;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe choice first; Escape cancels unless the action is running.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && !busy && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 text-left whitespace-normal"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl"
      >
        <h2 id={`${id}-title`} className="text-lg font-bold text-navy">
          {title}
        </h2>
        <div id={`${id}-body`} className="mt-2 space-y-2 text-[13px] text-muted">
          {children}
        </div>
        {error && (
          <div role="alert" className="mt-3">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy} className={btnSecondary}>
            Cancel
          </button>
          <button type="button" id={`${id}-confirm`} onClick={onConfirm} disabled={busy} className={danger ? btnDanger : btnPrimary}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
