"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Notice, Page, PageHeader, btnSecondary } from "@/components/ui";
import type { Transaction } from "@/lib/transactions";

type ApiList = { ok: boolean; data?: Transaction[]; error?: string; meta?: { pages: number; total: number } };

async function loadTransactions(): Promise<Transaction[]> {
  const all: Transaction[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`/api/transactions?limit=100&page=${page}`, { cache: "no-store" });
    let json: ApiList;
    try {
      json = await res.json();
    } catch {
      throw new Error(`The server returned an unexpected response (HTTP ${res.status}).`);
    }
    if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Could not load transactions.");
    all.push(...json.data);
    if (page >= (json.meta?.pages ?? 1)) break;
  }
  return all;
}

function money(amount: string, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" })
      .format(Number(amount))
      .replace(/ /g, " ");
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

/** Rendered only in the browser (after fetch), so this is the viewer's local time zone. */
function localDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function Unavailable() {
  return <span className="text-slate-400">Unavailable</span>;
}

function EnvironmentPill({ environment }: { environment: Transaction["environment"] }) {
  if (!environment) return <Unavailable />;
  const live = environment === "LIVE";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        live ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-amber-400"}`} />
      {live ? "Live" : "Sandbox"}
    </span>
  );
}

const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted";

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadTransactions()
      .then((data) => !cancelled && setTransactions(data))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not load transactions."));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page>
      <PageHeader
        title="Transactions"
        description="Successful payments verified with PayPal. Times are shown in your local time zone."
        actions={<Link href="/invoices" className={btnSecondary}>View invoices</Link>}
      />

      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !transactions ? (
        <div className="card p-8 text-center text-[13px] text-muted">Loading transactions…</div>
      ) : transactions.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-semibold text-navy">No transactions yet</p>
          <p className="mt-1 text-[13px] text-muted">Payments appear here once PayPal confirms a completed capture for an invoice.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-canvas">
                  <th className={`${th} pl-4`}>Invoice</th>
                  <th className={th}>Client</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Method</th>
                  <th className={th}>Paid at</th>
                  <th className={th}>PayPal capture ID</th>
                  <th className={`${th} pr-4`}>Environment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {transactions.map((t) => (
                  <tr key={t.invoiceId} id={`transaction-${t.invoiceId}`} className="transition-colors hover:bg-canvas/70">
                    <td className="whitespace-nowrap py-2.5 pl-4 pr-3 text-xs font-medium tabular-nums text-muted">{t.invoiceNumber}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-medium text-navy">{t.clientName}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-navy">{money(t.amount, t.currency)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-navy">{t.method ?? <Unavailable />}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">
                      {t.paidAt ? <time dateTime={t.paidAt}>{localDateTime(t.paidAt)}</time> : <Unavailable />}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-navy">{t.captureId ?? <Unavailable />}</td>
                    <td className="whitespace-nowrap py-2.5 pl-3 pr-4">
                      <EnvironmentPill environment={t.environment} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-line bg-canvas px-4 py-2">
            <p className="text-xs text-slate-400">
              {transactions.length} successful payment{transactions.length === 1 ? "" : "s"}
            </p>
            <p className="text-xs text-slate-400">Live database data</p>
          </div>
        </div>
      )}
    </Page>
  );
}
