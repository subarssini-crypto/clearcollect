"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Notice, btnPrimary, inputClass, labelClass } from "@/components/ui";

type ApiResult = { ok?: boolean; error?: string; message?: string; errors?: { field: string; message: string }[] };

/** Requests a reset link. The answer is the same whether or not the email has an account. */
export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!email.trim()) return setError("Enter your email address");
    setBusy(true);
    try {
      const res = await fetch("/api/customer/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const json: ApiResult = await res.json().catch(() => ({ error: `The server returned an unexpected response (HTTP ${res.status}).` }));
      if (!json.ok) return setError(json.errors?.[0]?.message || json.error || "Could not request a reset link.");
      setDone(json.message || "Check your email for a reset link.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Notice tone="info">{done}</Notice>
        <Link href="/portal/login" className={`${btnPrimary} w-full`}>
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div>
        <label htmlFor="forgot-email" className={labelClass}>
          Email address
        </label>
        <input id="forgot-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={191} className={inputClass} />
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </p>
      )}
      <button id="forgot-submit" type="submit" disabled={busy} className={`${btnPrimary} w-full py-2.5`}>
        {busy ? "Sending…" : "Send reset link"}
      </button>
      <p className="text-center text-xs text-muted">
        <Link href="/portal/login" className="font-semibold text-brand hover:text-brand-ink">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
