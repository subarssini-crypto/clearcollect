"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import PublicHeader from "@/components/PublicHeader";
import { Notice, StatusPill, btnPrimary, btnSecondary, type StatusLabel } from "@/components/ui";

type LineItem = { description: string; quantity: number; rate: number; unit?: string };
type PortalStatus = "pending" | "paid" | "overdue";
type Invoice = {
  invoiceNumber: string;
  description: string;
  lineItems: LineItem[] | null;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  status: PortalStatus;
  payable: boolean;
  paidAt: string | null;
};
type Payment = { invoiceNumber: string; amount: string; currency: string; method: "PayPal" | null; paidAt: string | null };
type Me = { name: string; email: string; client: { name: string; company: string | null } | null };
type Filter = "all" | "pending" | "paid" | "overdue";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "paid", label: "Paid" },
  { key: "overdue", label: "Overdue" },
];

const STATUS_LABEL: Record<PortalStatus, StatusLabel> = { pending: "Pending", paid: "Paid", overdue: "Overdue" };

const EMPTY_TEXT: Record<Filter, string> = {
  all: "You have no invoices yet. New invoices appear here as soon as they are sent to you.",
  pending: "No invoices are waiting for payment.",
  paid: "No paid invoices yet.",
  overdue: "Nothing is overdue. You’re all caught up.",
};

/** Display-only notices after returning from PayPal; invoice status always comes from the server. */
const PAYMENT_NOTICES: Record<string, { tone: "success" | "info" | "warning" | "error"; text: string }> = {
  paid: { tone: "success", text: "Payment received. Thank you!" },
  pending: { tone: "warning", text: "PayPal is still processing your payment. The invoice stays unpaid until it completes." },
  cancelled: { tone: "info", text: "Payment was cancelled. You have not been charged." },
  error: { tone: "error", text: "The payment could not be completed. You can try again." },
  review: { tone: "warning", text: "Your payment is being reviewed by the sender. Please do not pay again; they will contact you." },
};

const LINK_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  linked: { tone: "success", text: "Your account is now linked. Your invoices are below." },
  invalid: { tone: "error", text: "That invite link is invalid, expired, or already used. Ask the sender for a new one." },
  linked_elsewhere: { tone: "error", text: "This account is already linked to a different client, so the invite was not used." },
};

function money(value: string | number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" }).format(Number(value));
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function date(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload drops any cached portal data after the session ends
    window.location.assign("/portal/login");
    throw new Error("Your session has ended. Please sign in again.");
  }
  const json: { ok?: boolean; data?: T; error?: string } = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok || json.data === undefined) throw new Error(json.error || "Could not load your data.");
  return json.data;
}

/** Sum of amounts per currency, e.g. "USD 120.00 · EUR 40.00". */
function totals(invoices: Invoice[]): string {
  const byCurrency = new Map<string, number>();
  for (const inv of invoices) byCurrency.set(inv.currency, (byCurrency.get(inv.currency) ?? 0) + Math.round(Number(inv.amount) * 100));
  if (byCurrency.size === 0) return "—";
  return [...byCurrency].map(([currency, cents]) => money(cents / 100, currency)).join(" · ");
}

export default function PortalDashboard() {
  const params = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [all, setAll] = useState<Invoice[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [list, setList] = useState<Invoice[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [payError, setPayError] = useState("");
  // One-time notices from the query string (PayPal return or invite redemption).
  const [notice] = useState<{ tone: "success" | "info" | "warning" | "error"; text: string } | null>(() => {
    const payment = params.get("payment");
    const linked = params.get("linked");
    return (payment && PAYMENT_NOTICES[payment]) || (linked && LINK_NOTICES[linked]) || null;
  });
  const [returnedInvoice] = useState(() => params.get("invoice"));
  const [reloadKey, setReloadKey] = useState(0);

  // Clean the one-time parameters out of the URL.
  useEffect(() => {
    if (params.get("payment") || params.get("linked") || params.get("invoice")) window.history.replaceState(null, "", "/portal");
  }, [params]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getJson<Me>("/api/customer/me"),
      getJson<Invoice[]>("/api/customer/invoices?status=all"),
      getJson<Payment[]>("/api/customer/payments"),
    ])
      .then(([meData, invoices, history]) => {
        if (cancelled) return;
        setMe(meData);
        setAll(invoices);
        setPayments(history);
        if (returnedInvoice) setSelected(invoices.find((i) => i.invoiceNumber === returnedInvoice) ?? null);
      })
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : "Could not load your portal."));
    return () => {
      cancelled = true;
    };
  }, [returnedInvoice, reloadKey]);

  function retryOverview() {
    setLoadError("");
    setReloadKey((k) => k + 1);
  }

  function chooseFilter(next: Filter) {
    if (next === filter) return;
    setList(null);
    setListError("");
    setFilter(next);
  }

  // Each tab is filtered by the server, which only accepts the four known values.
  useEffect(() => {
    let cancelled = false;
    getJson<Invoice[]>(`/api/customer/invoices?status=${filter}`)
      .then((data) => !cancelled && setList(data))
      .catch((err) => !cancelled && setListError(err instanceof Error ? err.message : "Could not load invoices."));
    return () => {
      cancelled = true;
    };
  }, [filter]);

  async function pay(invoice: Invoice) {
    if (paying) return;
    setPaying(invoice.invoiceNumber);
    setPayError("");
    try {
      const res = await fetch("/api/customer/invoices/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoiceNumber: invoice.invoiceNumber }),
      });
      const json: { ok?: boolean; data?: { approveUrl: string }; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Payment could not be started.");
      window.location.assign(json.data.approveUrl);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment could not be started.");
      setPaying(null);
    }
  }

  async function signOut() {
    await fetch("/api/customer/auth/logout", { method: "POST" }).catch(() => {});
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload drops any cached portal data after the session ends
    window.location.assign("/portal/login");
  }

  const pending = all?.filter((i) => i.status === "pending") ?? [];
  const overdue = all?.filter((i) => i.status === "overdue") ?? [];
  const paid = all?.filter((i) => i.status === "paid") ?? [];
  const linked = me ? me.client !== null : true;

  return (
    <>
      <PublicHeader logoHref="/portal">
        {me && <span className="hidden text-[13px] text-muted sm:inline">{me.name}</span>}
        <button id="portal-sign-out" type="button" onClick={signOut} className={`${btnSecondary} py-1.5`}>
          Sign out
        </button>
      </PublicHeader>

      <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-navy">Your invoices</h1>
          <p className="text-[13px] text-muted">
            {me?.client ? `Account for ${me.client.company || me.client.name}. ` : ""}
            View invoices, pay securely with PayPal, and see your payment history.
          </p>
        </div>

        {notice && (
          <div role="status">
            <Notice tone={notice.tone}>{notice.text}</Notice>
          </div>
        )}
        {loadError && (
          <div role="alert" className="space-y-2">
            <Notice tone="error">{loadError}</Notice>
            <button type="button" onClick={retryOverview} className={btnSecondary}>
              Try again
            </button>
          </div>
        )}

        {me && !linked ? (
          <section className="card p-6" aria-labelledby="unlinked-title">
            <h2 id="unlinked-title" className="text-base font-bold text-navy">
              Your account isn’t linked to any invoices yet
            </h2>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">
              For your security, invoices are only shown after the business that bills you sends you a Customer Portal
              invite link. Open that link while signed in to connect this account. To pay a single invoice right away,
              use the secure payment link in your invoice email.
            </p>
          </section>
        ) : (
          <>
            {/* Summary */}
            <section aria-label="Summary" className="grid gap-3 sm:grid-cols-3">
              {[
                { label: "Pending", items: pending, tone: "text-amber-600" },
                { label: "Overdue", items: overdue, tone: overdue.length ? "text-red-600" : "text-navy" },
                { label: "Paid", items: paid, tone: "text-emerald-600" },
              ].map((stat) => (
                <div key={stat.label} className="card p-4">
                  <p className="text-xs font-medium text-muted">{stat.label}</p>
                  <p className={`mt-1 text-lg font-bold ${stat.tone}`}>{all ? stat.items.length : "…"}</p>
                  <p className="truncate text-xs text-muted">{all ? totals(stat.items) : "Loading…"}</p>
                </div>
              ))}
            </section>

            {/* Invoices */}
            <section className="card" aria-labelledby="invoices-title">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <h2 id="invoices-title" className="text-sm font-bold text-navy">
                  Invoices
                </h2>
                <div role="tablist" aria-label="Filter invoices" className="flex gap-1 rounded-lg bg-canvas p-1">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      id={`portal-filter-${f.key}`}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.key}
                      onClick={() => chooseFilter(f.key)}
                      className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                        filter === f.key ? "bg-surface text-navy shadow-sm" : "text-muted hover:text-navy"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {payError && (
                <div className="px-4 pt-3">
                  <Notice tone="error">{payError}</Notice>
                </div>
              )}

              {listError ? (
                <div className="p-4">
                  <Notice tone="error">{listError}</Notice>
                </div>
              ) : list === null ? (
                <p className="p-4 text-[13px] text-muted">Loading invoices…</p>
              ) : list.length === 0 ? (
                <p className="p-6 text-center text-[13px] text-muted">{EMPTY_TEXT[filter]}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {list.map((invoice) => (
                    <li key={invoice.invoiceNumber} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-navy">{invoice.invoiceNumber}</p>
                        <p className="truncate text-xs text-muted">
                          Due {date(invoice.dueDate)} · Issued {date(invoice.issueDate)}
                        </p>
                      </div>
                      <StatusPill status={STATUS_LABEL[invoice.status]} />
                      <p className="w-36 text-right text-[13px] font-bold text-navy">{money(invoice.amount, invoice.currency)}</p>
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setSelected(invoice)} className={`${btnSecondary} py-1.5 text-xs`}>
                          Details
                        </button>
                        {invoice.payable && (
                          <button type="button" onClick={() => pay(invoice)} disabled={paying !== null} className={`${btnPrimary} py-1.5 text-xs`}>
                            {paying === invoice.invoiceNumber ? "Redirecting…" : "Pay"}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Payment history */}
            <section className="card" aria-labelledby="payments-title">
              <h2 id="payments-title" className="border-b border-line px-4 py-3 text-sm font-bold text-navy">
                Payment history
              </h2>
              {payments === null ? (
                <p className="p-4 text-[13px] text-muted">{loadError ? "Unavailable." : "Loading payments…"}</p>
              ) : payments.length === 0 ? (
                <p className="p-6 text-center text-[13px] text-muted">No payments yet. Verified PayPal payments appear here.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {payments.map((p) => (
                    <li key={p.invoiceNumber} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                      <span className="flex-1 font-semibold text-navy">{p.invoiceNumber}</span>
                      <span className="text-muted">{p.paidAt ? date(p.paidAt) : "Date unavailable"}</span>
                      <span className="text-muted">{p.method ?? "Method unavailable"}</span>
                      <span className="w-36 text-right font-bold text-navy">{money(p.amount, p.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      {selected && <InvoiceDialog invoice={selected} onClose={() => setSelected(null)} onPay={pay} paying={paying} />}
    </>
  );
}

function InvoiceDialog({ invoice, onClose, onPay, paying }: { invoice: Invoice; onClose: () => void; onPay: (i: Invoice) => void; paying: string | null }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-dialog-title"
        className="card max-h-[90vh] w-full max-w-lg overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="invoice-dialog-title" className="text-base font-bold text-navy">
              Invoice {invoice.invoiceNumber}
            </h2>
            <p className="text-xs text-muted">
              Issued {date(invoice.issueDate)} · Due {date(invoice.dueDate)}
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} autoFocus className="rounded-lg px-2 py-1 text-xl text-slate-400 hover:bg-canvas hover:text-navy">
            ×
          </button>
        </div>

        <div className="mt-3">
          <StatusPill status={STATUS_LABEL[invoice.status]} />
        </div>

        <div className="mt-4 border-t border-line pt-3">
          {invoice.lineItems && invoice.lineItems.length > 0 ? (
            <ul className="space-y-1.5 text-[13px]">
              {invoice.lineItems.map((item, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="text-navy">
                    {item.description}
                    <span className="text-muted"> · {item.quantity} × {money(item.rate, invoice.currency)}</span>
                  </span>
                  <span className="whitespace-nowrap font-medium text-navy">{money(Math.round(item.quantity * item.rate * 100) / 100, invoice.currency)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="whitespace-pre-wrap text-[13px] text-navy">{invoice.description}</p>
          )}
          <div className="mt-3 flex justify-between border-t border-line pt-3 text-sm font-bold text-navy">
            <span>Total</span>
            <span>{money(invoice.amount, invoice.currency)}</span>
          </div>
        </div>

        <div className="mt-4">
          {invoice.status === "paid" ? (
            <Notice tone="success">Paid{invoice.paidAt ? ` on ${date(invoice.paidAt)}` : ""}. Thank you!</Notice>
          ) : invoice.payable ? (
            <button type="button" onClick={() => onPay(invoice)} disabled={paying !== null} className={`${btnPrimary} w-full py-2.5`}>
              {paying === invoice.invoiceNumber ? "Redirecting to PayPal…" : `Pay ${money(invoice.amount, invoice.currency)} with PayPal`}
            </button>
          ) : (
            <Notice tone="info">This invoice can’t be paid online right now. Contact the business that sent it.</Notice>
          )}
        </div>
      </div>
    </div>
  );
}
