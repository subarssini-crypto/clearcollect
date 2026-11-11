"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { MIN_PASSWORD } from "@/components/CustomerAuthForm";
import PasswordToggle from "@/components/PasswordToggle";
import { Notice, btnPrimary, inputClass, labelClass } from "@/components/ui";

type ApiResult = { ok?: boolean; error?: string; message?: string; errors?: { field: string; message: string }[] };

/** Sets a new password with the token from the reset email link. */
export default function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters`);
    if (password !== confirm) return setError("Passwords do not match");
    setBusy(true);
    try {
      const res = await fetch("/api/customer/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const json: ApiResult = await res.json().catch(() => ({ error: `The server returned an unexpected response (HTTP ${res.status}).` }));
      if (!json.ok) return setError(json.errors?.[0]?.message || json.error || "Could not reset your password.");
      setPassword("");
      setConfirm("");
      setDone(json.message || "Your password has been reset.");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="space-y-4">
        <Notice tone="error">This page needs the link from your password reset email.</Notice>
        <Link href="/portal/forgot-password" className={`${btnPrimary} w-full`}>
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Notice tone="success">{done}</Notice>
        <Link href="/portal/login" className={`${btnPrimary} w-full`}>
          Continue to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div>
        <label htmlFor="reset-password" className={labelClass}>
          New password
        </label>
        <PasswordToggle visible={showPassword} onToggle={() => setShowPassword((v) => !v)} controls="reset-password">
          <input id="reset-password" type={showPassword ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={1024} className={`${inputClass} pr-10`} />
        </PasswordToggle>
        <p className="mt-1 text-xs text-muted">At least {MIN_PASSWORD} characters.</p>
      </div>
      <div>
        <label htmlFor="reset-confirm" className={labelClass}>
          Confirm new password
        </label>
        <PasswordToggle visible={showConfirm} onToggle={() => setShowConfirm((v) => !v)} controls="reset-confirm">
          <input id="reset-confirm" type={showConfirm ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={1024} className={`${inputClass} pr-10`} />
        </PasswordToggle>
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
          {/expired|invalid/i.test(error) && (
            <>
              {" "}
              <Link href="/portal/forgot-password" className="font-semibold underline">
                Request a new link
              </Link>
            </>
          )}
        </p>
      )}
      <button id="reset-submit" type="submit" disabled={busy} className={`${btnPrimary} w-full py-2.5`}>
        {busy ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
