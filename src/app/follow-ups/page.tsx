"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { displayStatus, type DashboardInvoice } from "@/lib/dashboard-metrics";
import { Avatar, Notice, PageHeader, Page, btnPrimary, btnSecondary, inputClass } from "@/components/ui";

type ApiList<T> = { ok: boolean; data?: T[]; error?: string; meta?: { pages: number } };

type FollowUp = {
  invoice: DashboardInvoice;
  overdue: boolean;
  days: number; // days overdue, or days until due
};

const DAY_MS = 86_400_000;
const DUE_SOON_DAYS = 7;

function money(amount: string | number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(amount));
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

function longDate(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Amount with its currency code (e.g. "USD 1,830.00"), matching the server's reminder facts. */
function reminderAmount(amount: string | number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" })
      .format(Number(amount))
      .replace(/ /g, " ");
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

/** Reminder text built from the invoice record (editable before sending). */
function draftReminder({ invoice, overdue, days }: FollowUp) {
  const amount = reminderAmount(invoice.amount, invoice.currency);
  const timing = overdue
    ? `was due on ${longDate(invoice.dueDate)} and is now ${days} day${days === 1 ? "" : "s"} overdue`
    : `is due on ${longDate(invoice.dueDate)}${days === 0 ? " (today)" : ` (in ${days} day${days === 1 ? "" : "s"})`}`;
  return `Hi ${invoice.client.name},

${overdue ? "Just following up on" : "A friendly reminder about"} invoice ${invoice.invoiceNumber} for ${amount}, which ${timing}.

${overdue ? "Could you please arrange payment at your earliest convenience?" : "Please let me know if you have any questions before then."}

Thank you!`;
}

async function loadInvoices(): Promise<DashboardInvoice[]> {
  const all: DashboardInvoice[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`/api/invoices?limit=100&page=${page}`);
    const json = await readJson<ApiList<DashboardInvoice>>(res);
    if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Could not load invoices.");
    all.push(...json.data);
    if (page >= (json.meta?.pages ?? 1)) break;
  }
  return all;
}

/** Parses a JSON response; an HTML error page (proxy, crash) becomes a readable error. */
async function readJson<T>(res: Response): Promise<T & { error?: string; errors?: { message: string }[] }> {
  try {
    return await res.json();
  } catch {
    return { ok: false, error: `The server returned an unexpected response (HTTP ${res.status}).` } as never;
  }
}

type Delivery = "zapier" | "demo" | "misconfigured" | "unknown";
type Outcome = { tone: "success" | "info" | "error"; text: string };

export default function FollowUpsPage() {
  const [data, setData] = useState<{ invoices: DashboardInvoice[]; now: number } | null>(null);
  const [error, setError] = useState("");
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [subjects, setSubjects] = useState<Record<number, string>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState<{ id: number; action: "draft" | "send" } | null>(null);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});
  const [sentIds, setSentIds] = useState<Set<number>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  // Synchronous guard: state updates land after a re-render, so a fast double
  // click could otherwise start two sends.
  const sendingRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    loadInvoices()
      .then((invoices) => !cancelled && setData({ invoices, now: Date.now() }))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Could not load invoices."));
    // If the mode cannot be checked, say so — never assume demo mode, since
    // the server may still deliver for real.
    fetch("/api/follow-ups/status")
      .then((res) => readJson<{ ok: boolean; data?: { delivery: Delivery } }>(res))
      .then((json) => !cancelled && setDelivery(json.ok && json.data ? json.data.delivery : "unknown"))
      .catch(() => !cancelled && setDelivery("unknown"));
    return () => {
      cancelled = true;
    };
  }, []);

  // Unpaid SENT/OVERDUE invoices: overdue first (most overdue first), then due within a week.
  const followUps = useMemo<FollowUp[]>(() => {
    if (!data) return [];
    const today = Date.UTC(new Date(data.now).getUTCFullYear(), new Date(data.now).getUTCMonth(), new Date(data.now).getUTCDate());
    const items: FollowUp[] = [];
    for (const invoice of data.invoices) {
      const status = displayStatus(invoice, data.now);
      const days = Math.round((Date.parse(`${invoice.dueDate.slice(0, 10)}T00:00:00Z`) - today) / DAY_MS);
      if (status === "Overdue") items.push({ invoice, overdue: true, days: Math.max(0, -days) });
      else if (status === "Pending" && days <= DUE_SOON_DAYS) items.push({ invoice, overdue: false, days });
    }
    return items.sort((a, b) => (a.overdue === b.overdue ? (a.overdue ? b.days - a.days : a.days - b.days) : a.overdue ? -1 : 1));
  }, [data]);

  const visible = followUps.filter((f) => !dismissedIds.has(f.invoice.id));
  const overdueCount = visible.filter((f) => f.overdue).length;
  const dueSoonCount = visible.length - overdueCount;

  function subjectFor(item: FollowUp) {
    return subjects[item.invoice.id] ?? `Payment reminder: invoice ${item.invoice.invoiceNumber}`;
  }
  function messageFor(item: FollowUp) {
    return drafts[item.invoice.id] ?? draftReminder(item);
  }
  function setOutcome(id: number, outcome: Outcome | null) {
    setOutcomes((prev) => {
      const next = { ...prev };
      if (outcome) next[id] = outcome;
      else delete next[id];
      return next;
    });
  }

  async function draftWithAi(item: FollowUp) {
    const id = item.invoice.id;
    setBusy({ id, action: "draft" });
    setOutcome(id, null);
    try {
      const res = await fetch("/api/follow-ups/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: id }),
      });
      const json = await readJson<{ ok: boolean; data?: { subject: string; message: string } }>(res);
      if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Could not draft a reminder.");
      const { subject, message } = json.data;
      setSubjects((prev) => ({ ...prev, [id]: subject }));
      setDrafts((prev) => ({ ...prev, [id]: message }));
      setOutcome(id, { tone: "info", text: "AI draft ready. Review and edit it before sending." });
    } catch (err) {
      setOutcome(id, { tone: "error", text: err instanceof Error ? err.message : "Could not draft a reminder." });
    } finally {
      setBusy(null);
    }
  }

  async function sendReminder(item: FollowUp) {
    const id = item.invoice.id;
    if (sendingRef.current.has(id) || sentIds.has(id)) return;
    sendingRef.current.add(id);
    setBusy({ id, action: "send" });
    setOutcome(id, null);
    try {
      const res = await fetch("/api/follow-ups/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: id, subject: subjectFor(item), message: messageFor(item) }),
      });
      const json = await readJson<{ ok: boolean; data?: { mode: "demo" | "zapier"; delivered: boolean; detail: string } }>(res);
      if (!res.ok || !json.ok || !json.data) {
        throw new Error(json.errors?.map((e) => e.message).join(" ") || json.error || "The reminder was not sent.");
      }
      if (json.data.delivered) {
        setSentIds((prev) => new Set(prev).add(id));
        setOutcome(id, { tone: "success", text: json.data.detail });
      } else {
        setOutcome(id, { tone: "info", text: json.data.detail });
      }
    } catch (err) {
      setOutcome(id, { tone: "error", text: err instanceof Error ? err.message : "The reminder was not sent." });
    } finally {
      sendingRef.current.delete(id);
      setBusy(null);
    }
  }

  const deliveryNote =
    delivery === "zapier"
      ? "Approved reminders are sent to Zapier, which delivers them by email or Slack."
      : delivery === "misconfigured"
        ? "Zapier delivery is misconfigured on the server — reminders cannot be sent."
        : delivery === "unknown"
          ? "Could not check the delivery mode. The result of each send is shown after you approve it."
          : "Demo mode — Zapier is not configured, so reminders are not actually sent.";
  const sendLabel = delivery === "demo" ? "Approve & Send (Demo)" : "Approve & Send";

  return (
    <Page>
      <PageHeader
        title="Follow-ups"
        description="AI-drafted payment reminders for unpaid invoices that are overdue or due within 7 days."
        actions={<Link href="/invoices" className={btnSecondary}>View invoices</Link>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 font-semibold text-red-700">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          {overdueCount} overdue
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          {dueSoonCount} due soon
        </span>
        {delivery && (
          <span className={`text-xs ${delivery === "misconfigured" ? "font-medium text-red-600" : "text-muted"}`}>{deliveryNote}</span>
        )}
      </div>

      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <div className="card p-8 text-center text-[13px] text-muted">Loading invoices…</div>
      ) : visible.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-sm font-semibold text-navy">No follow-ups needed</p>
          <p className="mt-1 text-[13px] text-muted">No unpaid invoices are overdue or due within the next {DUE_SOON_DAYS} days.</p>
        </div>
      ) : (
        <div className="card divide-y divide-line">
          {visible.map((item, i) => {
            const { invoice, overdue, days } = item;
            const id = invoice.id;
            const sent = sentIds.has(id);
            const isBusy = busy?.id === id;
            const outcome = outcomes[id];
            return (
              <div key={id} id={`followup-card-${id}`} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Avatar name={invoice.client.name} index={i} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold text-navy">{invoice.client.name}</p>
                    <p className="truncate text-xs text-muted">
                      <span className="font-medium">{invoice.invoiceNumber}</span> · {money(invoice.amount, invoice.currency)}
                      {invoice.client.email ? ` · ${invoice.client.email}` : " · no email on file"}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${overdue ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}
                  >
                    {overdue ? `${days} day${days === 1 ? "" : "s"} overdue` : days === 0 ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`}
                  </span>
                  <div className="flex w-full items-center justify-end gap-3 sm:w-auto">
                    {sent && <span className="text-[11px] font-semibold text-emerald-700">✓ Sent to Zapier</span>}
                    <button
                      id={`toggle-reminder-${id}`}
                      onClick={() => setOpenId(openId === id ? null : id)}
                      className="text-xs font-semibold text-brand hover:text-brand-ink"
                    >
                      {openId === id ? "Hide Reminder" : "Review Reminder"}
                    </button>
                    <button
                      id={`dismiss-followup-${id}`}
                      onClick={() => setDismissedIds((prev) => new Set(prev).add(id))}
                      className="text-xs font-medium text-muted hover:text-navy"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>

                {openId === id && (
                  <div className="mt-2.5 space-y-2 rounded-lg border border-line bg-canvas/60 p-3">
                    <div>
                      <label htmlFor={`reminder-subject-${id}`} className="mb-1 block text-xs font-medium text-muted">
                        Subject
                      </label>
                      <input
                        id={`reminder-subject-${id}`}
                        value={subjectFor(item)}
                        maxLength={200}
                        onChange={(e) => setSubjects((prev) => ({ ...prev, [id]: e.target.value }))}
                        className={`${inputClass} text-xs font-semibold`}
                      />
                    </div>
                    <div>
                      <label htmlFor={`reminder-edit-${id}`} className="mb-1 block text-xs font-medium text-muted">
                        Message
                      </label>
                      <textarea
                        id={`reminder-edit-${id}`}
                        value={messageFor(item)}
                        maxLength={5000}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [id]: e.target.value }))}
                        rows={6}
                        className={`${inputClass} block max-h-72 overflow-y-auto resize-y text-xs leading-relaxed`}
                      />
                    </div>
                    {outcome && (
                      <Notice tone={outcome.tone === "success" ? "success" : outcome.tone === "error" ? "error" : "info"}>{outcome.text}</Notice>
                    )}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        id={`draft-ai-${id}`}
                        onClick={() => draftWithAi(item)}
                        disabled={isBusy}
                        className={`${btnSecondary} !px-3 !py-1.5 !text-xs`}
                      >
                        {isBusy && busy?.action === "draft" ? "Drafting…" : "Draft with AI"}
                      </button>
                      <button
                        id={`send-followup-${id}`}
                        onClick={() => sendReminder(item)}
                        disabled={isBusy || sent || delivery === "misconfigured"}
                        className={`${btnPrimary} !px-3 !py-1.5 !text-xs`}
                      >
                        {isBusy && busy?.action === "send" ? "Sending…" : sent ? "Sent to Zapier" : sendLabel}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
