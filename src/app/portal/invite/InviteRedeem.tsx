"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Notice, btnPrimary, btnSecondary } from "@/components/ui";

type Me = { email: string; client: { name: string; company: string | null } | null };
type State =
  | { kind: "loading" }
  | { kind: "invalid"; message: string }
  | { kind: "ready"; clientName: string; me: Me | null };

/**
 * Invitation acceptance. Shows who sent the invitation; a signed-in customer
 * accepts it explicitly with one button (the server checks the token, expiry,
 * single use, and that the account is not linked to another client). Signed-out
 * visitors sign up or sign in first and come back here with the token.
 */
export default function InviteRedeem() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [inviteRes, meRes] = await Promise.all([
          fetch(`/api/customer/auth/invite?token=${encodeURIComponent(token)}`, { cache: "no-store" }),
          fetch("/api/customer/me", { cache: "no-store" }),
        ]);
        const invite: { ok?: boolean; data?: { clientName: string }; error?: string } = await inviteRes.json().catch(() => ({}));
        const me: { ok?: boolean; data?: Me } = meRes.ok ? await meRes.json().catch(() => ({})) : {};
        if (cancelled) return;
        if (!inviteRes.ok || !invite.ok || !invite.data) {
          setState({ kind: "invalid", message: invite.error || "This invitation is invalid, expired, revoked, or already used." });
        } else {
          setState({ kind: "ready", clientName: invite.data.clientName, me: me.ok && me.data ? me.data : null });
        }
      } catch {
        if (!cancelled) setState({ kind: "invalid", message: "Could not check this invitation. Check your connection and reload." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/customer/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const json: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || "The invitation could not be accepted.");
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the portal loads with the newly linked client
      window.location.assign("/portal?linked=linked");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The invitation could not be accepted.");
      setBusy(false);
    }
  }

  async function switchAccount() {
    await fetch("/api/customer/auth/logout", { method: "POST" }).catch(() => {});
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the new session starts clean
    window.location.assign(`/portal/login?invite=${encodeURIComponent(token)}`);
  }

  if (state.kind === "loading") return <p className="text-[13px] text-muted">Checking your invitation…</p>;
  if (state.kind === "invalid") {
    return (
      <div className="space-y-3">
        <Notice tone="error">{state.message}</Notice>
        <Link href="/portal/login" className={`${btnSecondary} w-full`}>
          Go to sign in
        </Link>
      </div>
    );
  }

  const query = `?invite=${encodeURIComponent(token)}`;
  const linkedTo = state.me?.client ? state.me.client.company || state.me.client.name : null;
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-navy">
        <span className="font-semibold">{state.clientName}</span> is invited to view and pay their invoices with ClearCollect.
      </p>
      {state.me ? (
        <>
          <p className="text-xs text-muted">Signed in as {state.me.email}.</p>
          {linkedTo && (
            <Notice tone="warning">
              This account is already linked to {linkedTo}. It can only accept an invitation for that same client; it is never moved to another one.
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <button id="invite-accept" type="button" onClick={accept} disabled={busy} className={`${btnPrimary} w-full`}>
            {busy ? "Accepting…" : "Accept invitation"}
          </button>
          <button type="button" onClick={switchAccount} className={`${btnSecondary} w-full`}>
            Use a different account
          </button>
        </>
      ) : (
        <>
          <Link id="invite-signup" href={`/portal/signup${query}`} className={`${btnPrimary} w-full`}>
            Create an account
          </Link>
          <Link id="invite-login" href={`/portal/login${query}`} className={`${btnSecondary} w-full`}>
            I already have an account
          </Link>
          <p className="text-xs text-muted">After signing in you’ll come back here to accept the invitation.</p>
        </>
      )}
      <p className="text-xs text-muted">This invitation works once and expires 7 days after it was sent.</p>
    </div>
  );
}
