
"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { VALID_CURRENCIES } from "@/lib/validation";
import {
  DEFAULT_DUE_DAYS,
  addDays,
  appendGeneralAnswers,
  type Clarification,
  type ClarifyQuestion,
  type DateSource,
  type LineUnit,
} from "@/lib/invoice-draft";
import { lineItemCents } from "@/lib/line-items";
import { SendInvoiceButton } from "@/components/SendInvoice";
import { btnPrimary } from "@/components/ui";

type Client = {
  id: number;
  name: string;
  email: string | null;
  company: string | null;
};

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
  errors?: { field: string; message: string }[];
};

type LineItem = {
  id: number;
  description: string;
  quantity: number;
  rate: number;
  /** Set for AI-drafted lines so the review can name the unit. */
  unit?: LineUnit;
};

const UNIT_LABELS: Record<LineUnit, { one: string; many: string }> = {
  hour: { one: "hour", many: "hours" },
  day: { one: "day", many: "days" },
  week: { one: "week", many: "weeks" },
  month: { one: "month", many: "months" },
  item: { one: "item", many: "items" },
  fixed: { one: "fixed price", many: "fixed price" },
};

type InvoiceDraft = {
  kind: "draft";
  clientId: number | null;
  clientNotice: string | null;
  currency: string;
  issueDate: string;
  issueDateSource: DateSource;
  dueDate: string;
  dueDateSource: DateSource;
  lineItems: { description: string; quantity: number; unit: LineUnit; rate: number; needsConfirmation: boolean }[];
  assumptions: string[];
  confirmations: string[];
};

type DraftOutcome = InvoiceDraft | Clarification;

/** Where a form date came from; "user" means typed into the form. */
type FieldSource = "user" | Exclude<DateSource, "form">;

const DATE_SOURCE_NOTES: Record<FieldSource, { issue: string; due: string } | null> = {
  user: null,
  request: { issue: "From your request", due: "From your request" },
  payment_terms: { issue: "From your request", due: "From the payment terms in your request" },
  default: {
    issue: "App default: today — edit if needed",
    due: `App default: ${DEFAULT_DUE_DAYS} days after the issue date (not from your request) — edit if needed`,
  },
};

const sampleLineItems: LineItem[] = [
  {
    id: 1,
    description: "Web Design — 10 hours @ $95/hr",
    quantity: 10,
    rate: 95,
  },
  {
    id: 2,
    description: "Frontend Development — 8 hours @ $110/hr",
    quantity: 8,
    rate: 110,
  },
];

const currencies = [...VALID_CURRENCIES];

// Today's local date is read only in the browser. The server snapshot is
// empty, so prerendering never reads the clock and hydration always matches.
const subscribeNoop = () => () => {};
const getLocalToday = () => new Date().toLocaleDateString("en-CA");
const getServerToday = () => "";

/** Line amount in integer cents (same rounding as the server). */
function lineCents(item: LineItem) {
  return lineItemCents(item);
}

// Static preview text only. Real reminders are drafted, approved, and sent
// from the Follow-ups page (Zapier → Gmail). The only email this page sends
// is the invoice itself, via SendInvoiceButton (POST /api/invoices/[id]/send).
const sampleReminderSubject = "Friendly Payment Reminder";

const sampleReminder = `Hi Sarah,

I hope you're doing well! This is a gentle reminder about your outstanding invoice.

If payment has already been arranged, please disregard this message.

For your convenience, you can pay securely using the payment link provided with your invoice.

If you have any questions, I'm happy to help.

Best regards,
Your Business`;

export default function CreateInvoicePage() {
  const [clientRequest, setClientRequest] = useState("");
  // Blank = the server assigns the next unique INV-YYYY-NNN number on save.
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientsLoading, setClientsLoading] = useState(true);
  // Dates default to today / issue date + 14 days until the user (or an AI
  // draft) sets them. The source of each date is shown next to the field.
  const today = useSyncExternalStore(subscribeNoop, getLocalToday, getServerToday);
  const [issueDateInput, setIssueDate] = useState<string | null>(null);
  const [dueDateInput, setDueDate] = useState<string | null>(null);
  const [issueSource, setIssueSource] = useState<FieldSource>("default");
  const [dueSource, setDueSource] = useState<FieldSource>("default");
  const issueDate = issueDateInput ?? today;
  const dueDate = dueDateInput ?? (issueDate ? addDays(issueDate, DEFAULT_DUE_DAYS) : "");
  const [lineItems, setLineItems] = useState<LineItem[]>(sampleLineItems);
  const [currency, setCurrency] = useState("USD");
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  const [aiError, setAiError] = useState(false);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  // Clarification: one answer per question id (never matched by position).
  const [questions, setQuestions] = useState<ClarifyQuestion[]>([]);
  const [pendingDraft, setPendingDraft] = useState<Record<string, unknown> | null>(null);
  const [clarifyNotes, setClarifyNotes] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [earlierAnswers, setEarlierAnswers] = useState<string[]>([]);
  const [clientNotice, setClientNotice] = useState<string | null>(null);
  // Every AI draft must be reviewed before saving; values the user never
  // stated are listed separately.
  const [confirmations, setConfirmations] = useState<string[]>([]);
  const [needsReview, setNeedsReview] = useState(false);
  const [valuesConfirmed, setValuesConfirmed] = useState(false);
  const [reminderSubject, setReminderSubject] = useState(sampleReminderSubject);
  const [reminderText, setReminderText] = useState(sampleReminder);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState(false);
  // The last draft saved from this page; "Send Invoice" emails this saved
  // record (never unsaved form values). A failed send leaves it a DRAFT.
  const [savedDraft, setSavedDraft] = useState<{ id: number; invoiceNumber: string; clientEmail: string | null } | null>(null);

  const subtotal =
    lineItems.reduce((sum, item) => sum + lineCents(item), 0) / 100;

  function formatMoney(value: number) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  }

  function updateLineItem(id: number, changes: Partial<LineItem>) {
    // Changing reviewed values requires reviewing them again.
    if ("quantity" in changes || "rate" in changes) setValuesConfirmed(false);
    setLineItems((items) =>
      items.map((item) => (item.id === id ? { ...item, ...changes } : item))
    );
  }

  function addLineItem() {
    setLineItems((items) => [
      ...items,
      { id: Math.max(0, ...items.map((i) => i.id)) + 1, description: "", quantity: 1, rate: 0 },
    ]);
  }

  // Fills the form with an AI draft for review, or shows clarification
  // questions. Never saves.
  async function handleGenerate(
    requestText = clientRequest,
    clarification?: { pending: Record<string, unknown>; answers: { id: string; answer: string }[]; earlierAnswers: string[] }
  ) {
    if (!requestText.trim() || isGenerating) return;
    setIsGenerating(true);
    setAiMessage("");
    setAiError(false);
    setAssumptions([]);

    try {
      const response = await fetch("/api/ai/invoice-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request: requestText,
          // The selected client is the default unless the request names another.
          selectedClientId: clientId ? Number(clientId) : null,
          // Only dates typed by the user; defaults are left to the server.
          issueDate: issueSource === "user" ? issueDate : null,
          dueDate: dueSource === "user" ? dueDate : null,
          ...(clarification ? { clarification } : {}),
        }),
      });
      const result: ApiResponse<DraftOutcome> = await response.json();
      if (!response.ok || !result.ok || !result.data) {
        throw new Error(
          result.errors?.map((e) => e.message).join(" ") ||
            result.error ||
            "Could not generate a draft."
        );
      }

      const outcome = result.data;
      if (outcome.kind === "clarification") {
        // Nothing in the form changes until the missing details are given.
        // Rejected answers are shown again so they can be corrected.
        setQuestions(outcome.questions);
        setPendingDraft(outcome.pending);
        setClarifyNotes(outcome.notes);
        setAnswers(Object.fromEntries(outcome.questions.map((q) => [q.id, q.problem ? (q.previousAnswer ?? "") : ""])));
        setAiMessage(
          outcome.questions.some((q) => q.problem)
            ? "Some answers need another look (see below). Accepted answers were kept; the form was not changed."
            : "More detail is needed before drafting — the form was not changed."
        );
        return;
      }

      const draft = outcome;
      setQuestions([]);
      setPendingDraft(null);
      setClarifyNotes([]);
      setLineItems(draft.lineItems.map((item, index) => ({
        id: index + 1,
        description: item.description,
        quantity: item.quantity,
        rate: item.rate,
        unit: item.unit,
      })));
      setCurrency(draft.currency);
      setIssueDate(draft.issueDate);
      setIssueSource(draft.issueDateSource === "form" ? "user" : draft.issueDateSource);
      // A default due date stays live (issue date + 14 days) so it follows edits.
      setDueDate(draft.dueDateSource === "default" ? null : draft.dueDate);
      setDueSource(draft.dueDateSource === "form" ? "user" : draft.dueDateSource);
      handleClientChange(draft.clientId === null ? "" : String(draft.clientId));
      setClientNotice(draft.clientNotice);
      setConfirmations(draft.confirmations);
      setNeedsReview(true);
      setValuesConfirmed(false);
      setAssumptions(draft.assumptions);
      setAiMessage("Draft generated. Review and edit the details below — nothing has been saved yet.");
    } catch (err) {
      setAiError(true);
      setAiMessage(err instanceof Error ? err.message : "Could not generate a draft.");
    } finally {
      setIsGenerating(false);
    }
  }

  useEffect(() => {
    async function loadClients() {
      try {
        const response = await fetch("/api/clients");
        const result: ApiResponse<Client[]> = await response.json();

        if (!response.ok || !result.ok || !result.data) {
          throw new Error("Could not load clients.");
        }

        setClients(result.data);

        if (result.data.length > 0) {
          const firstClient = result.data[0];
          setClientId(String(firstClient.id));
          setClientName(firstClient.name);
          setClientEmail(firstClient.email ?? "");
        }
      } catch {
        setSaveError(true);
        setSaveMessage("Could not load clients from the database.");
      } finally {
        setClientsLoading(false);
      }
    }

    loadClients();
  }, []);

  function handleClientChange(value: string) {
    setClientId(value);
    setClientNotice(null);

    const selectedClient = clients.find(
      (client) => String(client.id) === value
    );

    setClientName(selectedClient?.name ?? "");
    setClientEmail(selectedClient?.email ?? "");
    setSaveMessage("");
  }

  async function handleSaveDraft() {
    setSaveMessage("");
    setSaveError(false);

    if (!clientId) {
      setSaveError(true);
      setSaveMessage("Please select a client.");
      return;
    }

    if (needsReview && !valuesConfirmed) {
      setSaveError(true);
      setSaveMessage("Review the quantities, rates, currency, and total below and tick the confirmation before saving.");
      return;
    }

    if (!issueDate || !dueDate || dueDate <= issueDate) {
      setSaveError(true);
      setSaveMessage("Due date must be after the issue date.");
      return;
    }

    if (
      lineItems.length === 0 ||
      lineItems.some((item) => !item.description.trim() || !(item.quantity > 0) || !(item.rate > 0))
    ) {
      setSaveError(true);
      setSaveMessage("Each line item needs a description, a quantity above 0, and a rate above 0.");
      return;
    }

    if (isSaving) return;

    setIsSaving(true);

    try {
      const response = await fetch("/api/invoices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...(invoiceNumber.trim() ? { invoiceNumber: invoiceNumber.trim() } : {}),
          clientId: Number(clientId),
          description: lineItems
            .map((item) => item.description.trim())
            .join("; "),
          amount: subtotal,
          currency,
          issueDate,
          dueDate,
          status: "DRAFT",
          // Stored so the invoice email can list them; must add up to amount.
          lineItems: lineItems.map((item) => ({
            description: item.description.trim(),
            quantity: item.quantity,
            rate: item.rate,
            ...(item.unit ? { unit: item.unit } : {}),
          })),
        }),
      });

      const result: ApiResponse<{ id: number; invoiceNumber: string; client: { email: string | null } }> = await response.json();

      if (!response.ok || !result.ok) {
        const message =
          result.errors?.map((error) => error.message).join(" ") ||
          result.error ||
          "Failed to save the invoice.";

        throw new Error(message);
      }

      setSaveMessage(
        result.data?.invoiceNumber
          ? `Draft ${result.data.invoiceNumber} saved successfully to the database!`
          : "Draft saved successfully to the database!"
      );
      if (result.data) {
        setSavedDraft({ id: result.data.id, invoiceNumber: result.data.invoiceNumber, clientEmail: result.data.client?.email ?? null });
      }
      // Leave the field blank so the next save gets a fresh number.
      setInvoiceNumber("");
    } catch (error) {
      setSaveError(true);
      setSaveMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while saving."
      );
    } finally {
      setIsSaving(false);
    }
  }

  const allAnswered = questions.length > 0 && questions.every((q) => (answers[q.id] ?? "").trim());

  // Sends each answer with its own question id. Field answers are applied by
  // the server without guessing; general answers become explicit
  // question/answer pairs in the request text and the draft is regenerated.
  function handleClarify() {
    if (!allAnswered || isGenerating) return;
    const answered = questions.map((q) => ({ id: q.id, answer: (answers[q.id] ?? "").trim() }));
    if (pendingDraft) {
      handleGenerate(clientRequest, { pending: pendingDraft, answers: answered, earlierAnswers });
      setEarlierAnswers((previous) => [...previous, ...answered.map((a) => a.answer)]);
      return;
    }
    const next = appendGeneralAnswers(
      clientRequest,
      questions.map((q) => ({ question: q.text, answer: answers[q.id] ?? "" }))
    );
    if (next.length > 2000) {
      setAiError(true);
      setAiMessage("The request and answers are too long together (2,000 characters). Shorten the request and try again.");
      return;
    }
    setClientRequest(next);
    handleGenerate(next);
  }

  function startNewDraft() {
    setQuestions([]);
    setPendingDraft(null);
    setClarifyNotes([]);
    setEarlierAnswers([]);
    handleGenerate();
  }

  function describeLine(item: LineItem) {
    const rate = formatMoney(item.rate);
    if (!item.unit) return `${item.quantity} × ${rate}`;
    if (item.unit === "fixed") return item.quantity === 1 ? `fixed price ${rate}` : `${item.quantity} × fixed price ${rate}`;
    const label = UNIT_LABELS[item.unit];
    return `${item.quantity} ${item.quantity === 1 ? label.one : label.many} × ${rate}/${label.one}`;
  }

  const issueNote = DATE_SOURCE_NOTES[issueSource]?.issue;
  const dueNote = DATE_SOURCE_NOTES[dueSource]?.due;

  const inputClass =
    "w-full border border-line rounded-lg px-3 py-2 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition";

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight text-navy">
          Create Invoice
        </h1>
        <p className="text-muted text-[13px] mt-0.5">
          Create an invoice, save it as a draft, then send it to your client by
          email. Payment reminders are sent from{" "}
          <Link href="/follow-ups" className="font-medium text-brand hover:text-brand-ink">
            Follow-ups
          </Link>
          .
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] lg:gap-5">
        <div className="min-w-0 space-y-4">
          <div className="card p-4">
            <h2 className="text-sm font-semibold text-navy mb-3">
              Invoice details
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label
                  htmlFor="invoice-number"
                  className="block text-xs font-medium text-muted mb-1"
                >
                  Invoice Number
                </label>
                <input
                  id="invoice-number"
                  type="text"
                  value={invoiceNumber}
                  placeholder="Auto-assigned on save"
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className={inputClass}
                />
              </div>

              <div>
                <label
                  htmlFor="client-select"
                  className="block text-xs font-medium text-muted mb-1"
                >
                  Select Client
                </label>
                <select
                  id="client-select"
                  value={clientId}
                  onChange={(e) => handleClientChange(e.target.value)}
                  disabled={clientsLoading || clients.length === 0}
                  className={inputClass}
                >
                  <option value="">
                    {clientsLoading
                      ? "Loading clients..."
                      : clients.length === 0
                        ? "No clients found"
                        : "Select a client"}
                  </option>
                  {clients.map((client) => (
                    <option key={client.id} value={String(client.id)}>
                      {client.name}
                      {client.company ? ` — ${client.company}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="client-name"
                  className="block text-xs font-medium text-muted mb-1"
                >
                  Client Name
                </label>
                <input
                  id="client-name"
                  type="text"
                  value={clientName}
                  readOnly
                  className={`${inputClass} bg-canvas`}
                />
              </div>

              <div>
                <label
                  htmlFor="client-email"
                  className="block text-xs font-medium text-muted mb-1"
                >
                  Client Email
                </label>
                <input
                  id="client-email"
                  type="email"
                  value={clientEmail}
                  readOnly
                  className={`${inputClass} bg-canvas`}
                />
              </div>

              <div className="grid grid-cols-3 gap-3 sm:col-span-2">
                <div>
                  <label
                    htmlFor="issue-date"
                    className="block text-xs font-medium text-muted mb-1"
                  >
                    Issue Date
                  </label>
                  <input
                    id="issue-date"
                    type="date"
                    value={issueDate}
                    onChange={(e) => {
                      setIssueDate(e.target.value);
                      setIssueSource("user");
                    }}
                    className={inputClass}
                  />
                  {issueNote && <p className="mt-1 text-[11px] text-slate-500">{issueNote}</p>}
                </div>

                <div>
                  <label
                    htmlFor="due-date"
                    className="block text-xs font-medium text-muted mb-1"
                  >
                    Due Date
                  </label>
                  <input
                    id="due-date"
                    type="date"
                    value={dueDate}
                    min={issueDate}
                    onChange={(e) => {
                      setDueDate(e.target.value);
                      setDueSource("user");
                    }}
                    className={inputClass}
                  />
                  {dueNote && (
                    <p className={`mt-1 text-[11px] ${dueSource === "default" ? "text-amber-700" : "text-slate-500"}`}>
                      {dueNote}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="currency"
                    className="block text-xs font-medium text-muted mb-1"
                  >
                    Currency
                  </label>
                  <select
                    id="currency"
                    value={currency}
                    onChange={(e) => {
                      setCurrency(e.target.value);
                      setValuesConfirmed(false);
                    }}
                    className={inputClass}
                  >
                    {currencies.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="border border-line rounded-lg overflow-hidden mb-4">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-canvas border-b border-line">
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Description
                    </th>
                    <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted w-16 sm:w-20">
                      Qty
                    </th>
                    <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted w-20 sm:w-28">
                      Rate
                    </th>
                    <th className="text-right px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted w-20 sm:w-28">
                      Amount
                    </th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {lineItems.map((item) => (
                    <tr key={item.id}>
                      <td className="px-2 py-2">
                        <input
                          aria-label="Line item description"
                          value={item.description}
                          maxLength={200}
                          onChange={(e) => updateLineItem(item.id, { description: e.target.value })}
                          className="w-full rounded-md px-2 py-1 text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          aria-label="Quantity"
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.quantity}
                          onChange={(e) => updateLineItem(item.id, { quantity: Number(e.target.value) || 0 })}
                          className="w-full rounded-md px-2 py-1 text-right text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          aria-label="Rate"
                          type="number"
                          min={0}
                          step="0.01"
                          value={item.rate}
                          onChange={(e) => updateLineItem(item.id, { rate: Number(e.target.value) || 0 })}
                          className="w-full rounded-md px-2 py-1 text-right text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-navy whitespace-nowrap">
                        {formatMoney(lineCents(item) / 100)}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button
                          type="button"
                          aria-label="Remove line item"
                          onClick={() => setLineItems((items) => items.filter((i) => i.id !== item.id))}
                          className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-start gap-4">
              <button
                type="button"
                onClick={addLineItem}
                className="text-sm font-medium text-brand hover:text-brand-ink"
              >
                + Add line item
              </button>
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between text-muted">
                  <span>Subtotal</span>
                  <span>{formatMoney(subtotal)}</span>
                </div>
                <div className="flex justify-between font-bold text-navy text-base pt-2 border-t border-line">
                  <span>Total</span>
                  <span>{formatMoney(subtotal)}</span>
                </div>
                <p className="text-xs text-slate-400">
                  Tax is not included in this draft.
                </p>
              </div>
            </div>

            {needsReview && (
              <div className="mt-5 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-900 ring-1 ring-amber-200" aria-labelledby="review-heading">
                <p id="review-heading" className="font-semibold">Review before saving</p>
                <ul className="mt-1.5 space-y-0.5">
                  {lineItems.map((item) => (
                    <li key={item.id} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{item.description || "(no description)"}</span>: {describeLine(item)}
                      </span>
                      <span className="whitespace-nowrap font-medium">{formatMoney(lineCents(item) / 100)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 flex justify-between gap-3 border-t border-amber-200 pt-1.5 font-semibold">
                  <span>Currency {currency} · Total</span>
                  <span>{formatMoney(subtotal)}</span>
                </p>
                {confirmations.length > 0 && (
                  <>
                    <p className="mt-2 font-semibold">Not stated in your request — check these:</p>
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                      {confirmations.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  </>
                )}
                <label className="mt-2 flex items-start gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={valuesConfirmed}
                    onChange={(e) => setValuesConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  I have reviewed these quantities, rates, currency, and total (edit them above if anything is wrong).
                </label>
              </div>
            )}

            {saveMessage && (
              <div
                role="status"
                aria-live="polite"
                className={`mt-5 rounded-lg px-3 py-2 text-sm ${saveError
                    ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                    : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                  }`}
              >
                {saveMessage}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2 mt-4 pt-4 border-t border-line">
              <button
                id="save-draft-btn"
                onClick={handleSaveDraft}
                disabled={isSaving || clientsLoading || clients.length === 0}
                className="flex items-center gap-2 border border-line text-slate-700 hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
                  />
                </svg>
                {isSaving ? "Saving..." : "Save Draft"}
              </button>

              {savedDraft ? (
                <SendInvoiceButton
                  key={savedDraft.id}
                  invoiceId={savedDraft.id}
                  invoiceNumber={savedDraft.invoiceNumber}
                  label={`Send ${savedDraft.invoiceNumber}`}
                />
              ) : (
                <button
                  id="send-invoice-btn"
                  type="button"
                  disabled
                  title="Save the draft first"
                  className={btnPrimary}
                >
                  Send Invoice
                </button>
              )}
            </div>
            <p className="mt-2 text-right text-[11px] text-muted">
              {savedDraft
                ? `Sends the saved draft ${savedDraft.invoiceNumber} (not later edits) to ${savedDraft.clientEmail || "the client's saved email"} after you review it.`
                : "Save the draft first. Sending emails the saved invoice to the client's email on file."}
            </p>
          </div>
        </div>

        <div className="min-w-0 space-y-4 lg:self-start">
          <div className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-brand"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-navy">
                AI Invoice Generator
              </h2>
              <span className="ml-auto text-[11px] bg-brand-50 text-brand font-semibold px-2 py-0.5 rounded-full">
                Review before saving
              </span>
            </div>

            <p className="text-muted text-xs mb-2.5">
              Describe the work. AI fills in a draft below for you to review —
              it never saves or sends anything.
            </p>

            <textarea
              id="client-request-textarea"
              value={clientRequest}
              onChange={(e) => setClientRequest(e.target.value)}
              maxLength={2000}
              placeholder="e.g. I completed 10 hours of web design and 8 hours of frontend development..."
              rows={5}
              className="w-full border border-line rounded-lg px-3 py-2 text-[13px] text-navy placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand resize-none transition"
            />

            <button
              id="generate-invoice-btn"
              onClick={startNewDraft}
              disabled={isGenerating || !clientRequest.trim()}
              className="mt-2.5 flex w-full items-center justify-center gap-2 bg-brand hover:bg-brand-dark text-white text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? "Generating draft..." : "Generate with AI"}
            </button>

            {aiMessage && (
              <div
                role="status"
                aria-live="polite"
                className={`mt-2.5 rounded-lg px-3 py-2 text-xs ${aiError
                    ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                    : "bg-brand-50 text-brand-ink ring-1 ring-brand-100"
                  }`}
              >
                {aiMessage}
                {assumptions.length > 0 && (
                  <ul className="mt-1.5 list-disc pl-4 space-y-0.5">
                    {assumptions.map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {questions.length > 0 && (
              <div className="mt-2.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                <p className="font-semibold">Please answer each question</p>
                <p className="mt-0.5">One value per box. Answers are matched to their question, never by order.</p>
                {clarifyNotes.map((note, index) => (
                  <p key={index} className="mt-1 font-medium">{note}</p>
                ))}
                <div className="mt-2 space-y-2">
                  {questions.map((question) => (
                    <div key={question.id}>
                      <label htmlFor={`answer-${question.id}`} className="block font-medium text-navy">
                        {question.text}
                      </label>
                      <input
                        id={`answer-${question.id}`}
                        value={answers[question.id] ?? ""}
                        onChange={(e) => setAnswers((current) => ({ ...current, [question.id]: e.target.value }))}
                        maxLength={question.field ? 200 : 500}
                        placeholder={question.field === "rate" ? "e.g. 6" : question.field === "quantity" ? "e.g. 3" : "Your answer"}
                        aria-invalid={question.problem ? true : undefined}
                        className={`mt-1 w-full rounded-lg border bg-surface px-2 py-1.5 text-xs text-navy focus:outline-none focus:ring-2 focus:ring-amber-300 ${question.problem ? "border-red-300" : "border-amber-200"}`}
                      />
                      {question.problem && <p className="mt-0.5 text-[11px] font-medium text-red-700">{question.problem}</p>}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleClarify}
                  disabled={isGenerating || !allAnswered}
                  className="mt-2 w-full rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-slate-950 dark:hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pendingDraft ? "Apply answers" : "Add answers and regenerate"}
                </button>
              </div>
            )}

            {clientNotice && (
              <p role="alert" className="mt-2.5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 ring-1 ring-amber-200">
                {clientNotice}
              </p>
            )}

          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-brand"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-navy">
                Reminder preview
              </h2>
              <span className="ml-auto text-[11px] bg-slate-100 text-slate-600 font-semibold px-2 py-0.5 rounded-full">
                Preview only
              </span>
            </div>

            <p className="text-muted text-xs mb-2.5">
              Sample wording only. This reminder preview never sends anything. To
              send a real reminder for a saved, unpaid invoice, use Follow-ups: you
              review an AI draft, approve it, and it is handed to Zapier for Gmail delivery.
            </p>

            {/* Subject is its own field so it is always visible; the body scrolls. */}
            <label htmlFor="reminder-subject" className="block text-xs font-medium text-muted mb-1">
              Subject
            </label>
            <input
              id="reminder-subject"
              value={reminderSubject}
              onChange={(e) => setReminderSubject(e.target.value)}
              className="w-full border border-line rounded-lg px-3 py-2 text-xs font-semibold text-navy focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand transition bg-surface"
            />
            <label htmlFor="reminder-textarea" className="block text-xs font-medium text-muted mt-2 mb-1">
              Message
            </label>
            <textarea
              id="reminder-textarea"
              value={reminderText}
              onChange={(e) => setReminderText(e.target.value)}
              rows={8}
              className="block w-full min-h-32 max-h-80 overflow-y-auto border border-line rounded-lg px-3 py-2 text-xs text-slate-700 leading-relaxed focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand resize-y transition bg-canvas"
            />

            <Link
              id="open-follow-ups-link"
              href="/follow-ups"
              className="mt-2.5 flex w-full items-center justify-center gap-2 border border-line text-navy hover:bg-canvas text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors"
            >
              Send real reminders in Follow-ups →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
