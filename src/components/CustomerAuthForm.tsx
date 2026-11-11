"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import PasswordToggle from "@/components/PasswordToggle";
import { Notice, btnPrimary, inputClass, labelClass } from "@/components/ui";
import { safePortalPath } from "@/lib/safe-redirect";

type Mode = "login" | "signup";
type ApiResult = { ok?: boolean; error?: string; message?: string; errors?: { field: string; message: string }[] };

export const MIN_PASSWORD = 8; // MIN_CUSTOMER_PASSWORD_LENGTH in src/lib/customer-auth.ts

async function postJson(url: string, body: unknown): Promise<{ status: number; json: ApiResult }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: ApiResult = {};
  try {
    json = await res.json();
  } catch {
    json = { error: `The server returned an unexpected response (HTTP ${res.status}).` };
  }
  return { status: res.status, json };
}

/**
 * Customer Portal sign-in / sign-up. An `invite` query parameter (from an
 * owner's invitation link) is carried through sign-up and sign-in; after
 * signing in the customer lands on /portal/invite to accept it explicitly.
 * The token itself is never sent to the auth endpoints.
 */
export default function CustomerAuthForm({ mode }: { mode: Mode }) {
  const params = useSearchParams();
  const invite = params.get("invite") ?? "";
  const next = params.get("next");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // Each password field has its own show/hide toggle.
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [signupDone, setSignupDone] = useState("");

  const inviteQuery = invite ? `?invite=${encodeURIComponent(invite)}` : "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setFieldErrors({});

    if (mode === "signup") {
      const errs: Record<string, string> = {};
      if (!name.trim()) errs.name = "Enter your name";
      if (!email.trim()) errs.email = "Enter your email address";
      if (password.length < MIN_PASSWORD) errs.password = `Use at least ${MIN_PASSWORD} characters`;
      else if (password !== confirm) errs.confirm = "Passwords do not match";
      if (Object.keys(errs).length) return setFieldErrors(errs);
    }

    setBusy(true);
    try {
      const body = mode === "signup" ? { name, email, password } : { email, password };
      const { status, json } = await postJson(`/api/customer/auth/${mode}`, body);
      if (json.errors?.length) {
        setFieldErrors(Object.fromEntries(json.errors.map((e) => [e.field, e.message])));
        return;
      }
      if (status === 429 || !json.ok) {
        setError(json.error || (mode === "login" ? "Sign-in failed." : "Sign-up failed."));
        return;
      }
      if (mode === "signup") {
        setSignupDone(json.message || "Sign in to continue.");
        setPassword("");
        setConfirm("");
        return;
      }
      const target = new URL(
        invite ? `/portal/invite?token=${encodeURIComponent(invite)}` : safePortalPath(next),
        window.location.origin
      );
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the portal starts from the new session
      window.location.assign(`${target.pathname}${target.search}`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (signupDone) {
    return (
      <div className="space-y-4">
        <Notice tone="success">{signupDone}</Notice>
        <Link href={`/portal/login${inviteQuery}`} className={`${btnPrimary} w-full`}>
          Continue to sign in
        </Link>
      </div>
    );
  }

  const field = (id: string, label: string, input: ReactNode, hint?: string) => (
    <div>
      <label htmlFor={`customer-${id}`} className={labelClass}>
        {label}
      </label>
      {input}
      {fieldErrors[id] ? (
        <p id={`customer-${id}-error`} role="alert" className="mt-1 text-xs text-red-700">
          {fieldErrors[id]}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
  const describedBy = (id: string) => (fieldErrors[id] ? `customer-${id}-error` : undefined);

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      {invite && (
        <Notice tone="info">
          {mode === "signup" ? "Create your account, then sign in" : "Sign in"} to accept your invitation. You will confirm it on the next step.
        </Notice>
      )}
      {mode === "signup" &&
        field(
          "name",
          "Your name",
          <input id="customer-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-invalid={!!fieldErrors.name || undefined} aria-describedby={describedBy("name")} className={inputClass} />
        )}
      {field(
        "email",
        "Email address",
        <input id="customer-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={191} aria-invalid={!!fieldErrors.email || undefined} aria-describedby={describedBy("email")} className={inputClass} />
      )}
      {field(
        "password",
        "Password",
        <PasswordToggle visible={showPassword} onToggle={() => setShowPassword((v) => !v)} controls="customer-password">
          <input id="customer-password" type={showPassword ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} maxLength={1024} aria-invalid={!!fieldErrors.password || undefined} aria-describedby={describedBy("password")} className={`${inputClass} pr-10`} />
        </PasswordToggle>,
        mode === "signup" ? `At least ${MIN_PASSWORD} characters.` : undefined
      )}
      {mode === "login" && (
        <p className="-mt-1 text-right text-xs">
          <Link href="/portal/forgot-password" className="font-semibold text-brand hover:text-brand-ink">
            Forgot password?
          </Link>
        </p>
      )}
      {mode === "signup" &&
        field(
          "confirm",
          "Confirm password",
          <PasswordToggle visible={showConfirm} onToggle={() => setShowConfirm((v) => !v)} controls="customer-confirm">
            <input id="customer-confirm" type={showConfirm ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={1024} aria-invalid={!!fieldErrors.confirm || undefined} aria-describedby={describedBy("confirm")} className={`${inputClass} pr-10`} />
          </PasswordToggle>
        )}

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </p>
      )}

      <button id={`customer-${mode}-submit`} type="submit" disabled={busy} className={`${btnPrimary} w-full py-2.5`}>
        {busy ? (mode === "login" ? "Signing in…" : "Creating account…") : mode === "login" ? "Sign in" : "Create account"}
      </button>

      <p className="text-center text-xs text-muted">
        {mode === "login" ? (
          <>
            New here?{" "}
            <Link href={`/portal/signup${inviteQuery}`} className="font-semibold text-brand hover:text-brand-ink">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href={`/portal/login${inviteQuery}`} className="font-semibold text-brand hover:text-brand-ink">
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
