
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SendInvoiceButton } from "@/components/SendInvoice";

type Invoice = {
  id: number;
  paypalCaptureId?: string | null;
  invoiceNumber: string;
  clientId: number;
  description: string;
  amount: string | number;
  currency: string;
  issueDate: string;
  dueDate: string;
  status: "DRAFT" | "SENT" | "PAID" | "OVERDUE" | "CANCELLED";
  client: {
    id: number;
    name: string;
    email: string | null;
    company: string | null;
  };
};

type ApiResponse = {
  ok: boolean;
  data?: Invoice[];
  error?: string;
};

const paymentMessages: Record<string, { text: string; style: string }> = {
  paid: { text: "Payment received — invoice marked as paid.", style: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  pending: { text: "PayPal is still processing this payment. The invoice stays unpaid until it completes.", style: "bg-amber-50 text-amber-700 ring-amber-200" },
  cancelled: { text: "PayPal payment was cancelled. No changes were made.", style: "bg-canvas text-slate-600 ring-line" },
  error: { text: "The PayPal payment could not be completed. The invoice was not marked as paid.", style: "bg-red-50 text-red-700 ring-red-200" },
};

const tabs = ["All", "Paid", "Pending", "Overdue", "Draft"];

const avatarColors = [
  "bg-violet-100 text-violet-700",
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-pink-100 text-pink-700",
  "bg-orange-100 text-orange-700",
  "bg-teal-100 text-teal-700",
  "bg-indigo-100 text-indigo-700",
  "bg-cyan-100 text-cyan-700",
];

function getInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatAmount(amount: string | number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(amount));
}

function getDisplayStatus(invoice: Invoice) {
  if (invoice.status === "PAID") return "Paid";
  if (invoice.status === "DRAFT") return "Draft";
  if (invoice.status === "CANCELLED") return "Cancelled";
  if (invoice.status === "OVERDUE") return "Overdue";

  // SENT invoices become overdue in the display when their due date passes.
  const due = new Date(`${invoice.dueDate.slice(0, 10)}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  return due < today ? "Overdue" : "Pending";
}

function getStatusStyle(status: string) {
  switch (status) {
    case "Paid":
      return "bg-emerald-100 text-emerald-700";
    case "Pending":
      return "bg-amber-100 text-amber-700";
    case "Overdue":
      return "bg-red-100 text-red-700";
    case "Draft":
      return "bg-slate-100 text-slate-600";
    case "Cancelled":
      return "bg-slate-200 text-slate-600";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [activeTab, setActiveTab] = useState("All");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [payment, setPayment] = useState<{ result: string; invoice: string | null } | null>(null);
  const [payingId, setPayingId] = useState<number | null>(null);
  const [payError, setPayError] = useState("");

  async function payWithPaypal(invoice: Invoice) {
    setPayError("");
    setPayingId(invoice.id);
    try {
      const response = await fetch(`/api/invoices/${invoice.id}/paypal-order`, {
        method: "POST",
      });
      const result: { ok: boolean; data?: { approveUrl: string }; error?: string } =
        await response.json();
      if (!response.ok || !result.ok || !result.data) {
        throw new Error(result.error || "Could not start PayPal payment.");
      }
      window.location.assign(result.data.approveUrl);
    } catch (err) {
      setPayError(
        `${invoice.invoiceNumber}: ${err instanceof Error ? err.message : "Could not start PayPal payment."}`
      );
      setPayingId(null);
    }
  }

  useEffect(() => {
    async function loadInvoices() {
      try {
        setError("");

        // Show the result of a PayPal redirect. Display only — the invoice
        // status in the table always comes from the database.
        const params = new URLSearchParams(window.location.search);
        const paymentResult = params.get("payment");
        if (paymentResult && paymentMessages[paymentResult]) {
          setPayment({ result: paymentResult, invoice: params.get("invoice") });
          window.history.replaceState(null, "", window.location.pathname);
        }

        const response = await fetch("/api/invoices");
        const result: ApiResponse = await response.json();

        if (!response.ok || !result.ok || !result.data) {
          throw new Error(result.error || "Could not load invoices.");
        }

        setInvoices(result.data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Something went wrong while loading invoices."
        );
      } finally {
        setIsLoading(false);
      }
    }

    loadInvoices();
  }, []);

  const filteredInvoices = invoices.filter((invoice) => {
    if (activeTab === "All") return true;
    return getDisplayStatus(invoice) === activeTab;
  });

  // The invoice is SENT once Zapier accepted its email (reload to see server state).
  function markSent(id: number) {
    setInvoices((current) => current.map((inv) => (inv.id === id ? { ...inv, status: "SENT" } : inv)));
  }

  // Action column: Send for drafts, Pay button for payable invoices, a PayPal
  // badge when a capture is recorded, otherwise a neutral dash (no payment
  // data is invented).
  function renderPayment(invoice: Invoice) {
    return (
      <>
                        {invoice.status === "DRAFT" && (
                          <SendInvoiceButton
                            invoiceId={invoice.id}
                            invoiceNumber={invoice.invoiceNumber}
                            onSent={() => markSent(invoice.id)}
                            label="Send"
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-brand text-brand hover:bg-brand-50 transition-colors disabled:opacity-50"
                          />
                        )}
                        {(invoice.status === "SENT" || invoice.status === "OVERDUE") && (
                          <button
                            id={`pay-paypal-${invoice.id}`}
                            onClick={() => payWithPaypal(invoice)}
                            disabled={payingId !== null}
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-brand hover:bg-brand-dark text-white transition-colors disabled:opacity-50"
                          >
                            {payingId === invoice.id ? "Redirecting..." : "Pay with PayPal"}
                          </button>
                        )}
                        {invoice.status === "PAID" && invoice.paypalCaptureId && (
                          <span
                            title={`Paid via PayPal (capture ...${invoice.paypalCaptureId.slice(-6)})`}
                            className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
                          >
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            PayPal
                          </span>
                        )}
                        {!(invoice.status === "SENT" || invoice.status === "OVERDUE" || invoice.status === "DRAFT") &&
                          !(invoice.status === "PAID" && invoice.paypalCaptureId) && (
                            <span className="text-muted" aria-label="No payment method recorded">
                              —
                            </span>
                          )}
                      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-navy">
            Invoices
          </h1>
          <p className="text-muted text-[13px] mt-0.5">
            Manage your invoices stored in the database.
          </p>
        </div>

        <Link
          href="/create-invoice"
          id="invoices-create-btn"
          className="flex items-center gap-2 bg-brand hover:bg-brand-dark text-white text-[13px] font-semibold px-3.5 py-2 rounded-lg transition-colors whitespace-nowrap"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 4v16m8-8H4"
            />
          </svg>
          New Invoice
        </Link>
      </div>

      {/* Payment result */}
      {(payment || payError) && (
        <div
          role="status"
          className={`mb-4 rounded-lg ring-1 p-4 text-sm ${payError ? paymentMessages.error.style : paymentMessages[payment!.result].style}`}
        >
          {payError || (
            <>
              {payment!.invoice && <span className="font-semibold">{payment!.invoice}: </span>}
              {paymentMessages[payment!.result].text}
            </>
          )}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1 mb-4 bg-slate-100 p-1 rounded-lg w-fit">
        {tabs.map((tab) => (
          <button
            key={tab}
            id={`filter-tab-${tab.toLowerCase()}`}
            onClick={() => setActiveTab(tab)}
            aria-pressed={activeTab === tab}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${activeTab === tab
                ? "bg-surface text-navy shadow-sm"
                : "text-muted hover:text-slate-700"
              }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="card p-10 text-center text-[13px] text-muted">
          Loading invoices from the database...
        </div>
      )}

      {/* Error state */}
      {!isLoading && error && (
        <div
          role="alert"
          className="bg-red-50 text-red-700 ring-1 ring-red-200 rounded-lg p-5"
        >
          <p className="font-semibold">Could not load invoices</p>
          <p className="text-sm mt-1">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-3 text-sm font-medium underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Invoice table */}
      {!isLoading && !error && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-canvas border-b border-line">
                  <th className="text-left px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Invoice
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Client
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Amount
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted hidden md:table-cell">
                    Issued
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted hidden sm:table-cell">
                    Due Date
                  </th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Status
                  </th>
                  <th className="text-right px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted hidden sm:table-cell">
                    Action
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-line">
                {filteredInvoices.map((invoice, index) => {
                  const status = getDisplayStatus(invoice);

                  return (
                    <tr
                      key={invoice.id}
                      className="hover:bg-canvas/70 transition-colors"
                    >
                      <td className="px-4 py-2.5 text-xs tabular-nums font-medium text-muted whitespace-nowrap">
                        {invoice.invoiceNumber}
                      </td>

                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <div
                            className={`hidden sm:flex w-8 h-8 rounded-full items-center justify-center text-xs font-bold flex-shrink-0 ${avatarColors[index % avatarColors.length]
                              }`}
                          >
                            {getInitials(invoice.client.name)}
                          </div>
                          <div>
                            <p className="font-medium text-navy whitespace-nowrap">
                              {invoice.client.name}
                            </p>
                            {invoice.client.company &&
                              invoice.client.company !== invoice.client.name && (
                                <p className="hidden sm:block text-xs text-slate-400">
                                  {invoice.client.company}
                                </p>
                              )}
                          </div>
                        </div>
                      </td>

                      <td className="px-3 py-2.5 font-semibold text-navy whitespace-nowrap">
                        {formatAmount(invoice.amount, invoice.currency)}
                      </td>

                      <td className="px-3 py-2.5 text-muted hidden md:table-cell whitespace-nowrap">
                        {formatDate(invoice.issueDate)}
                      </td>

                      <td className="px-3 py-2.5 text-muted whitespace-nowrap hidden sm:table-cell">
                        {formatDate(invoice.dueDate)}
                      </td>

                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${getStatusStyle(
                            status
                          )}`}
                        >
                          {status}
                        </span>
                        {/* Small screens: payment indicator sits under the status (column hidden). */}
                        {(invoice.status === "SENT" ||
                          invoice.status === "OVERDUE" ||
                          invoice.status === "DRAFT" ||
                          (invoice.status === "PAID" && invoice.paypalCaptureId)) && (
                          <div className="mt-1 sm:hidden">{renderPayment(invoice)}</div>
                        )}
                      </td>

                      <td className="px-4 py-2.5 text-right whitespace-nowrap hidden sm:table-cell">
                        {renderPayment(invoice)}
                      </td>
                    </tr>
                  );
                })}

                {filteredInvoices.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-6 py-12 text-center text-muted"
                    >
                      {invoices.length === 0
                        ? "No invoices yet. Create your first invoice to get started."
                        : `No ${activeTab.toLowerCase()} invoices found.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-2 bg-canvas border-t border-line flex items-center justify-between">
            <p className="text-xs text-slate-400">
              Showing {filteredInvoices.length} of {invoices.length} invoices
            </p>
            <p className="text-xs text-slate-400">
              Live database data
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
