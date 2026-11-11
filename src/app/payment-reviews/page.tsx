"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice, Page, PageHeader, btnPrimary, btnSecondary } from "@/components/ui";
import type { DemoResult } from "@/lib/payment-demo";

type Review = {
  id: number;
  status: "OPEN" | "REVIEWED";
  code: string;
  reason: string;
  recommendedAction: string;
  invoiceNumber: string | null;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  createdAt: string;
};

const DECISION_STYLES: Record<DemoResult["decision"], string> = {
  approved: "bg-emerald-50 text-emerald-700",
  held: "bg-amber-50 text-amber-700",
  already_recorded: "bg-slate-100 text-slate-600",
};

export default function PaymentReviewsPage() {
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [demo, setDemo] = useState<{ notice: string; results: DemoResult[] } | null>(null);
  const [demoError, setDemoError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/payment-reviews", { cache: "no-store" });
      const json: { ok?: boolean; data?: Review[]; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Could not load payment reviews.");
      setReviews(json.data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load payment reviews.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  async function markReviewed(id: number) {
    setBusy(id);
    try {
      const res = await fetch(`/api/payment-reviews/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "REVIEWED" }),
      });
      if (!res.ok) throw new Error("Could not update the review.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the review.");
    } finally {
      setBusy(null);
    }
  }

  async function runDemo() {
    setDemoError("");
    try {
      const res = await fetch("/api/payment-reviews/demo", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || "The demo could not run.");
      setDemo({ notice: json.notice, results: json.results });
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : "The demo could not run.");
    }
  }

  return (
    <Page>
      <PageHeader
        title="Payment Reviews"
        description="Payments held by deterministic checks. Held invoices stay unpaid; marking a review as reviewed never changes the invoice."
      />

      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !reviews ? (
        <div className="card p-8 text-center text-[13px] text-muted">Loading reviews…</div>
      ) : reviews.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-semibold text-navy">No payments need review</p>
          <p className="mt-1 text-[13px] text-muted">Mismatched amounts, duplicate captures and suspicious PayPal events appear here.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">{r.code.replaceAll("_", " ")}</p>
                  <p className="mt-1 text-[13px] text-navy">{r.reason}</p>
                  <p className="mt-1 text-[13px] text-muted"><span className="font-semibold">Recommended:</span> {r.recommendedAction}</p>
                  <p className="mt-2 font-mono text-[11px] text-slate-400">
                    {[r.invoiceNumber, r.paypalOrderId && `order ${r.paypalOrderId}`, r.paypalCaptureId && `capture ${r.paypalCaptureId}`, new Date(r.createdAt).toLocaleString()]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <button className={btnSecondary} disabled={busy === r.id} onClick={() => markReviewed(r.id)}>
                  {busy === r.id ? "Saving…" : "Mark reviewed"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-navy">Fraud-check demo</h2>
            <p className="text-[13px] text-muted">Runs the real rules on mock invoices in memory. No real invoice, payment or email is touched.</p>
          </div>
          <button className={btnPrimary} onClick={runDemo}>Run demo</button>
        </div>
        {demoError && <Notice tone="error">{demoError}</Notice>}
        {demo && (
          <div className="space-y-3">
            <Notice tone="warning">{demo.notice}</Notice>
            {demo.results.map((d, i) => (
              <div key={i} className="card border-dashed p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800">Demo</span>
                  <span className="text-sm font-semibold text-navy">{d.scenario}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${DECISION_STYLES[d.decision]}`}>{d.decision.replace("_", " ")}</span>
                  <span className="text-xs text-muted">{d.invoiceNumber} → {d.invoiceStatusAfter}</span>
                </div>
                <p className="mt-1 text-[13px] text-muted">{d.explanation}</p>
                {d.flags.map((f) => (
                  <p key={f.code} className="mt-1 text-[13px] text-navy">
                    <span className="font-semibold">{f.code}:</span> {f.reason} <span className="text-muted">Recommended: {f.recommendedAction}</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>
    </Page>
  );
}
