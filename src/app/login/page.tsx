"use client";

import { useEffect, useState, type FormEvent } from "react";
import { safeNextPath } from "@/lib/safe-redirect";
import { btnPrimary, inputClass, labelClass } from "@/components/ui";

/** "checking" until /api/auth/status answers; "unknown" if it cannot be reached. */
type SetupState = "checking" | "configured" | "missing" | "unknown";

const SETUP_STEPS = [
  <>
    In the project folder, open a terminal and run <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-navy">npm run auth:setup</code>.
  </>,
  <>Create a strong owner password (12+ characters). Only a hash of it is saved in <code className="font-mono">.env</code>.</>,
  <>Restart the app (stop and re-run <code className="font-mono">npm run dev</code>) so it loads the new settings.</>,
  <>Come back here and sign in with that password.</>,
];

function SetupInstructions() {
  return (
    <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-slate-600">
      {SETUP_STEPS.map((step, index) => (
        <li key={index}>{step}</li>
      ))}
    </ol>
  );
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [setup, setSetup] = useState<SetupState>("checking");

  useEffect(() => {
    fetch("/api/auth/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((json: { data?: { configured?: boolean } }) => {
        setSetup(json.data?.configured === true ? "configured" : json.data?.configured === false ? "missing" : "unknown");
      })
      .catch(() => setSetup("unknown"));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Full navigation so the proxy sees the new session cookie.
        window.location.assign(safeNextPath(new URLSearchParams(window.location.search).get("next")));
        return;
      }
      if (res.status === 503) {
        setSetup("missing");
      } else {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? "Sign-in failed");
      }
    } catch {
      setError("Network error — please try again");
    }
    setPassword("");
    setSubmitting(false);
  }

  const setupMissing = setup === "missing";

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-3">
        <form onSubmit={handleSubmit} className="card p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </span>
            <div>
              <h1 className="text-base font-bold tracking-tight text-navy">ClearCollect</h1>
              <p className="text-xs text-muted">Owner sign-in</p>
            </div>
          </div>

          <p className="mb-4 rounded-lg bg-canvas px-3 py-2 text-xs leading-relaxed text-slate-600">
            This is a <strong className="text-navy">single-owner demo</strong>: one owner password protects all
            data. There is <strong className="text-navy">no public registration</strong> — the owner password is
            created on the server with <code className="font-mono">npm run auth:setup</code>.
          </p>

          {setupMissing ? (
            <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200">
              <p className="text-xs font-semibold text-amber-800">Setup required</p>
              <p className="mt-0.5 text-xs text-amber-800">
                Owner sign-in is not configured on this server yet, so nobody can sign in. To set it up:
              </p>
              <SetupInstructions />
            </div>
          ) : (
            <>
              <label htmlFor="login-password" className={labelClass}>
                Owner password
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />

              {error && (
                <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting || password.length === 0 || setup === "checking"}
                className={`${btnPrimary} mt-4 w-full`}
              >
                {submitting ? "Signing in…" : "Sign in"}
              </button>
            </>
          )}
        </form>

        {!setupMissing && (
          <details className="card px-4 py-3 text-xs text-slate-600">
            <summary className="cursor-pointer font-semibold text-navy">First time here? Set up the owner password</summary>
            <SetupInstructions />
            <p className="mt-2 text-[11px] text-slate-500">
              Forgot the password? Run the command again; it replaces the password and signs out every session.
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
