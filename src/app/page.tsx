"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { computeDashboard, type DashboardInvoice, type DashboardMetrics } from "@/lib/dashboard-metrics";
import { Avatar, CardHeader, StatusPill, btnPrimary, btnSecondary, linkAction, statusColors } from "@/components/ui";

type ApiList<T> = { ok: boolean; data?: T[]; error?: string; meta?: { pages: number } };
type Loaded = { invoices: DashboardInvoice[]; clientCount: number; now: number };

function money(amount: number, currency: string, compact = false) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 1 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function shortDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Loads every invoice page (the API caps pages at 100) plus the client count. */
async function loadDashboard(): Promise<Loaded> {
  const invoices: DashboardInvoice[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`/api/invoices?limit=100&page=${page}`);
    const json: ApiList<DashboardInvoice> = await res.json();
    if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Could not load invoices.");
    invoices.push(...json.data);
    if (page >= (json.meta?.pages ?? 1)) break;
  }
  const clientsRes = await fetch("/api/clients");
  const clientsJson: ApiList<unknown> = await clientsRes.json();
  if (!clientsRes.ok || !clientsJson.ok || !clientsJson.data) throw new Error("Could not load clients.");
  return { invoices, clientCount: clientsJson.data.length, now: Date.now() };
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 pb-4 text-[13px] text-muted">{children}</p>;
}

// ── Main column ───────────────────────────────────────────────────────────────

function WelcomeCard({ m }: { m: DashboardMetrics }) {
  const pending = m.outstanding - m.overdue;
  const stats = [
    { label: "Outstanding", value: money(m.outstanding, m.currency), tone: "text-navy" },
    { label: "Pending", value: money(pending, m.currency), tone: "text-amber-600" },
    { label: "Overdue", value: money(m.overdue, m.currency), tone: m.overdue > 0 ? "text-red-600" : "text-navy" },
  ];
  return (
    <Card className="flex flex-col p-4">
      <p className="text-xs font-medium text-muted">Welcome back</p>
      <h1 className="mt-0.5 text-lg font-bold tracking-tight text-navy">Collections overview</h1>
      <p className="mt-1 text-[13px] text-muted">
        {m.outstandingCount > 0
          ? `${m.outstandingCount} invoice${m.outstandingCount === 1 ? "" : "s"} awaiting payment${m.overdueCount > 0 ? `, ${m.overdueCount} overdue` : ""}.`
          : m.collectedCount > 0
            ? "All sent invoices are paid."
            : "No invoices sent yet."}
      </p>
      <dl className="mt-2.5 grid grid-cols-3 divide-x divide-line rounded-lg bg-canvas py-2">
        {stats.map((s) => (
          <div key={s.label} className="px-3">
            <dt className="text-[11px] font-medium text-muted">{s.label}</dt>
            <dd className={`mt-0.5 truncate text-sm font-bold ${s.tone}`}>{s.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto flex flex-wrap gap-2 pt-3">
        <Link href="/create-invoice" className={btnPrimary}>New invoice</Link>
        <Link href="/invoices" className={btnSecondary}>View invoices</Link>
      </div>
    </Card>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 0);
  if (max === 0) return <div className="h-8" />;
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${36 - (v / max) * 32}`);
  return (
    <svg viewBox="0 0 100 38" preserveAspectRatio="none" className="h-8 w-full" aria-hidden="true">
      <polygon points={`0,38 ${pts.join(" ")} 100,38`} fill="#0966D8" fillOpacity="0.08" />
      <polyline points={pts.join(" ")} fill="none" stroke="#0966D8" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function RevenueCard({ m }: { m: DashboardMetrics }) {
  const rate = m.collectionRate;
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted">Total collected</p>
          <p className="mt-0.5 text-[26px] font-bold leading-tight tracking-tight text-navy">{money(m.collected, m.currency)}</p>
          <p className="mt-0.5 text-xs text-muted">
            <span className="font-semibold text-emerald-600">{money(m.collectedThisMonth, m.currency)}</span> this month ·{" "}
            {m.collectedCount} paid invoice{m.collectedCount === 1 ? "" : "s"}
          </p>
        </div>
        <span className="rounded-md bg-canvas px-2 py-1 text-[11px] font-semibold text-muted">{m.currency}</span>
      </div>
      <div className="mt-2">
        <Sparkline values={m.monthly.map((p) => p.collected)} />
      </div>
      <div className="mt-auto pt-2">
        <div className="flex justify-between text-[11px] font-medium text-muted">
          <span>Collection rate</span>
          <span className="text-navy">{rate === null ? "—" : `${Math.round(rate * 100)}%`}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-canvas">
          <div className="h-full rounded-full bg-brand" style={{ width: `${(rate ?? 0) * 100}%` }} />
        </div>
      </div>
    </Card>
  );
}

const quickActions = [
  { href: "/create-invoice", label: "New invoice", path: "M12 4v16m8-8H4" },
  { href: "/create-invoice", label: "AI draft", path: "M13 10V3L4 14h7v7l9-11h-7z" },
  { href: "/clients", label: "Add client", path: "M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" },
  { href: "/follow-ups", label: "Follow-ups", path: "M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" },
];

function QuickActions() {
  return (
    <Card className="flex flex-col">
      <CardHeader title="Quick actions" />
      <div className="grid flex-1 grid-cols-2 gap-2 px-4 pb-3">
        {quickActions.map((a) => (
          <Link key={a.label} href={a.href} className="flex min-w-0 items-center gap-2 rounded-lg border border-line px-2.5 py-2 transition-colors hover:border-brand-100 hover:bg-brand-50">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d={a.path} />
              </svg>
            </span>
            <span className="truncate text-[13px] font-semibold text-navy">{a.label}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function CashFlowCard({ m }: { m: DashboardMetrics }) {
  const max = Math.max(...m.monthly.flatMap((p) => [p.invoiced, p.collected]), 0);
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="Cash flow"
        action={
          <div className="flex items-center gap-3 text-[11px] font-medium text-muted">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-brand-100" />Invoiced</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-brand" />Collected</span>
          </div>
        }
      />
      <div className="relative mx-4 mb-3 h-24">
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-line" />
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
        <div className="relative flex h-full items-end gap-3">
          {m.monthly.map((p) => (
            <div key={p.key} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
              <div className="flex h-[calc(100%-16px)] w-full items-end justify-center gap-0.5">
                {[
                  { v: p.invoiced, c: "bg-brand-100", l: "Invoiced" },
                  { v: p.collected, c: "bg-brand", l: "Collected" },
                ].map((b) => (
                  <div
                    key={b.l}
                    title={`${p.label} · ${b.l}: ${money(b.v, m.currency)}`}
                    className={`w-full max-w-3 rounded-t ${b.c}`}
                    style={{ height: max > 0 ? `${b.v > 0 ? Math.max((b.v / max) * 100, 4) : 0}%` : "0%" }}
                  />
                ))}
              </div>
              <span className="text-[10px] font-medium text-muted">{p.label}</span>
            </div>
          ))}
        </div>
        {max === 0 && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted">No activity in the last 6 months</p>}
      </div>
    </Card>
  );
}

function RecentInvoices({ m }: { m: DashboardMetrics }) {
  return (
    <Card>
      <CardHeader title="Recent invoices" action={<Link href="/invoices" className={linkAction}>View all</Link>} />
      {m.recent.length === 0 ? (
        <Empty>No invoices yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-y border-line bg-canvas/60 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-3 py-2 font-semibold">Invoice</th>
                <th className="hidden px-3 py-2 font-semibold sm:table-cell">Issued</th>
                <th className="hidden px-3 py-2 font-semibold md:table-cell">Due</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
                <th className="px-4 py-2 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {m.recent.map(({ invoice, status }, i) => (
                <tr key={invoice.id} className="hover:bg-canvas/60">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={invoice.client.name} index={i} size="h-7 w-7" />
                      <span className="truncate font-semibold text-navy">{invoice.client.name}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs tabular-nums text-muted">{invoice.invoiceNumber}</td>
                  <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted sm:table-cell">{shortDate(invoice.issueDate)}</td>
                  <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted md:table-cell">{shortDate(invoice.dueDate)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-navy">{money(Number(invoice.amount), invoice.currency)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <StatusPill status={status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Right panel ───────────────────────────────────────────────────────────────

function PaymentSummary({ m }: { m: DashboardMetrics }) {
  const pending = m.outstanding - m.overdue;
  const rows = [
    { label: "Paid" as const, count: m.statusCounts.Paid, amount: m.collected },
    { label: "Pending" as const, count: m.statusCounts.Pending, amount: pending },
    { label: "Overdue" as const, count: m.statusCounts.Overdue, amount: m.overdue },
  ];
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <Card>
      <CardHeader title="Payment summary" action={<span className="text-[11px] text-muted">{m.statusCounts.Draft} draft{m.statusCounts.Draft === 1 ? "" : "s"}</span>} />
      <div className="px-4 pb-4">
        <p className="text-[11px] font-medium text-muted">Outstanding</p>
        <p className="text-xl font-bold tracking-tight text-navy">{money(m.outstanding, m.currency)}</p>
        <div className="mt-2.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-canvas">
          {total > 0 &&
            rows.map((r) => r.amount > 0 && <div key={r.label} className={statusColors[r.label].dot} style={{ width: `${(r.amount / total) * 100}%` }} />)}
        </div>
        <ul className="mt-3 space-y-1.5">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between text-[13px]">
              <span className="flex items-center gap-2 text-muted">
                <span className={`h-2 w-2 rounded-full ${statusColors[r.label].dot}`} />
                {r.label} <span className="text-[11px]">({r.count})</span>
              </span>
              <span className="font-semibold text-navy">{money(r.amount, m.currency)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function DueList({
  title,
  items,
  m,
  empty,
  describe,
  action,
}: {
  title: string;
  items: DashboardMetrics["upcoming"];
  m: DashboardMetrics;
  empty: string;
  describe: (days: number) => { text: string; tone: string };
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} action={action} />
      {items.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="px-2 pb-2">
          {items.map(({ invoice, amount, days }) => {
            const d = describe(days);
            return (
              <li key={invoice.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-canvas">
                <div className="flex h-8 w-8 flex-shrink-0 flex-col items-center justify-center rounded-md border border-line bg-white">
                  <span className="text-[9px] font-semibold uppercase leading-none text-muted">
                    {new Date(`${invoice.dueDate.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}
                  </span>
                  <span className="text-xs font-bold leading-tight text-navy">{Number(invoice.dueDate.slice(8, 10))}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-navy">{invoice.client.name}</p>
                  <p className={`text-[11px] font-medium ${d.tone}`}>{d.text}</p>
                </div>
                <span className="text-[13px] font-semibold text-navy">{money(amount, m.currency)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function TopClients({ m }: { m: DashboardMetrics }) {
  return (
    <Card>
      <CardHeader title="Top clients" action={<Link href="/clients" className={linkAction}>All clients</Link>} />
      {m.topClients.length === 0 ? (
        <Empty>Appears once invoices are sent.</Empty>
      ) : (
        <ul className="space-y-3 px-4 pb-4">
          {m.topClients.map((c, i) => (
            <li key={c.id} className="flex items-center gap-2.5">
              <Avatar name={c.name} index={i} size="h-7 w-7" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[13px] font-semibold text-navy">{c.name}</p>
                  <span className="text-[13px] font-semibold text-navy">{money(c.billed, m.currency, true)}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-canvas" title={`${money(c.paid, m.currency)} paid`}>
                  <div className="h-full rounded-full bg-emerald-500" style={{ width: `${c.billed > 0 ? (c.paid / c.billed) * 100 : 0}%` }} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]" aria-busy="true" aria-label="Loading dashboard">
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="h-48 animate-pulse rounded-xl bg-white" />
          <div className="h-48 animate-pulse rounded-xl bg-white" />
        </div>
        <div className="grid gap-4 md:grid-cols-[2fr_3fr]">
          <div className="h-44 animate-pulse rounded-xl bg-white" />
          <div className="h-44 animate-pulse rounded-xl bg-white" />
        </div>
        <div className="h-64 animate-pulse rounded-xl bg-white" />
      </div>
      <div className="space-y-4 xl:border-l xl:border-line xl:pl-5">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-32 animate-pulse rounded-xl bg-white" />)}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadDashboard()
      .then((loaded) => !cancelled && setData(loaded))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not load dashboard data."));
    return () => {
      cancelled = true;
    };
  }, []);

  // Computed only after data loads in the browser, so prerendering never reads the clock.
  const m = useMemo(() => (data ? computeDashboard(data.invoices, data.now) : null), [data]);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
      {error ? (
        <div role="alert" className="card border-red-100 p-4 text-[13px] text-red-700">
          <p className="font-semibold">Could not load the dashboard</p>
          <p className="mt-0.5">{error}</p>
          <button onClick={() => window.location.reload()} className="mt-2 font-semibold underline">Try again</button>
        </div>
      ) : !m || !data ? (
        <Skeleton />
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
          {/* Main workspace (~70%) */}
          <div className="min-w-0 space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <WelcomeCard m={m} />
              <RevenueCard m={m} />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <QuickActions />
              <CashFlowCard m={m} />
            </div>
            <RecentInvoices m={m} />
            {m.otherCurrencyCount > 0 && (
              <p className="text-[11px] text-muted">
                Totals are in {m.currency}; {m.otherCurrencyCount} invoice{m.otherCurrencyCount === 1 ? " in another currency is" : "s in other currencies are"} excluded.
              </p>
            )}
          </div>

          {/* Right summary panel (~30%), divided from the workspace */}
          <aside className="grid min-w-0 grid-cols-1 content-start gap-3 md:grid-cols-2 xl:grid-cols-1 xl:border-l xl:border-line xl:pl-5" aria-label="Summary">
            <PaymentSummary m={m} />
            <DueList
              title="Upcoming due dates"
              items={m.upcoming}
              m={m}
              empty="No sent invoices are coming due."
              describe={(days) => ({
                text: days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`,
                tone: days <= 3 ? "text-amber-600" : "text-muted",
              })}
            />
            <TopClients m={m} />
            <DueList
              title="Follow-up reminders"
              items={m.followUps}
              m={m}
              empty={`Nothing overdue${data.clientCount > 0 ? "" : " yet"} — no reminders needed.`}
              describe={(days) => ({ text: `${days} day${days === 1 ? "" : "s"} overdue`, tone: "text-red-600" })}
              action={<Link href="/follow-ups" className={linkAction}>Draft reminders</Link>}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
