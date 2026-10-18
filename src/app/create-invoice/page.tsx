
"use client";

import { useEffect, useState } from "react";

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

const sampleLineItems = [
  {
    id: 1,
    description: "Web Design — 10 hours @ $95/hr",
    quantity: 10,
    rate: 95,
    amount: 950,
  },
  {
    id: 2,
    description: "Frontend Development — 8 hours @ $110/hr",
    quantity: 8,
    rate: 110,
    amount: 880,
  },
];

const sampleReminder = `Subject: Friendly Payment Reminder

Hi Sarah,

I hope you're doing well! This is a gentle reminder about your outstanding invoice.

If payment has already been arranged, please disregard this message.

For your convenience, you can pay securely using the payment link provided with your invoice.

If you have any questions, I'm happy to help.

Best regards,
Your Business`;

export default function CreateInvoicePage() {
  const [clientRequest, setClientRequest] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("INV-2026-006");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientsLoading, setClientsLoading] = useState(true);
  const [issueDate, setIssueDate] = useState(
    new Date().toLocaleDateString("en-CA")
  );
  const [dueDate, setDueDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 14);
    return date.toLocaleDateString("en-CA");
  });
  const [lineItems] = useState(sampleLineItems);
  const [reminderText, setReminderText] = useState(sampleReminder);
  const [reminderSent, setReminderSent] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState(false);

  const subtotal = lineItems.reduce(
    (sum, item) => sum + item.amount,
    0
  );

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

    if (!invoiceNumber.trim()) {
      setSaveError(true);
      setSaveMessage("Please enter an invoice number.");
      return;
    }

    if (!clientId) {
      setSaveError(true);
      setSaveMessage("Please select a client.");
      return;
    }

    if (!issueDate || !dueDate || dueDate <= issueDate) {
      setSaveError(true);
      setSaveMessage("Due date must be after the issue date.");
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
          invoiceNumber: invoiceNumber.trim(),
          clientId: Number(clientId),
          description: lineItems
            .map((item) => item.description)
            .join("; "),
          amount: subtotal,
          currency: "USD",
          issueDate,
          dueDate,
          status: "DRAFT",
        }),
      });

      const result: ApiResponse<unknown> = await response.json();

      if (!response.ok || !result.ok) {
        const message =
          result.errors?.map((error) => error.message).join(" ") ||
          result.error ||
          "Failed to save the invoice.";

        throw new Error(message);
      }

      setSaveMessage("Draft saved successfully to the database!");
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

  function handleSendInvoice() {
    alert(
      "Sending invoices is not connected yet. Your draft can be saved to the database."
    );
  }

  function handleSendReminder() {
    setReminderSent(true);
    window.setTimeout(() => setReminderSent(false), 3000);
  }

  const inputClass =
    "w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition";

  return (
    <div className="min-h-full p-6 lg:p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">
          Create Invoice
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Create an invoice for your client and save it to your database.
          <span className="text-amber-600 font-medium ml-1">
            AI generation, email and payment integrations are not connected yet.
          </span>
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 space-y-6">
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-violet-100 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-violet-600"
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
              <h2 className="font-semibold text-slate-900">
                AI Invoice Generator
              </h2>
              <span className="ml-auto text-xs bg-violet-100 text-violet-600 font-medium px-2 py-0.5 rounded-full">
                Coming Soon
              </span>
            </div>

            <p className="text-slate-500 text-sm mb-3">
              Describe your project. AI-assisted invoice generation will be
              added later.
            </p>

            <textarea
              id="client-request-textarea"
              value={clientRequest}
              onChange={(e) => setClientRequest(e.target.value)}
              placeholder="e.g. I completed 10 hours of web design and 8 hours of frontend development..."
              rows={4}
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none transition"
            />

            <button
              id="generate-invoice-btn"
              disabled
              className="mt-3 flex items-center gap-2 bg-violet-600 text-white text-sm font-medium px-4 py-2 rounded-lg opacity-50 cursor-not-allowed"
            >
              Generate with AI (coming soon)
            </button>
          </div>

          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6">
            <h2 className="font-semibold text-slate-900 mb-5">
              Invoice Details
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              <div>
                <label
                  htmlFor="invoice-number"
                  className="block text-xs font-medium text-slate-500 mb-1.5"
                >
                  Invoice Number
                </label>
                <input
                  id="invoice-number"
                  type="text"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className={inputClass}
                />
              </div>

              <div>
                <label
                  htmlFor="client-select"
                  className="block text-xs font-medium text-slate-500 mb-1.5"
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
                  className="block text-xs font-medium text-slate-500 mb-1.5"
                >
                  Client Name
                </label>
                <input
                  id="client-name"
                  type="text"
                  value={clientName}
                  readOnly
                  className={`${inputClass} bg-slate-50`}
                />
              </div>

              <div>
                <label
                  htmlFor="client-email"
                  className="block text-xs font-medium text-slate-500 mb-1.5"
                >
                  Client Email
                </label>
                <input
                  id="client-email"
                  type="email"
                  value={clientEmail}
                  readOnly
                  className={`${inputClass} bg-slate-50`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                <div>
                  <label
                    htmlFor="issue-date"
                    className="block text-xs font-medium text-slate-500 mb-1.5"
                  >
                    Issue Date
                  </label>
                  <input
                    id="issue-date"
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                    className={inputClass}
                  />
                </div>

                <div>
                  <label
                    htmlFor="due-date"
                    className="block text-xs font-medium text-slate-500 mb-1.5"
                  >
                    Due Date
                  </label>
                  <input
                    id="due-date"
                    type="date"
                    value={dueDate}
                    min={issueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 font-medium text-slate-500">
                      Description
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-slate-500 w-16">
                      Qty
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-slate-500 w-24 hidden sm:table-cell">
                      Rate
                    </th>
                    <th className="text-right px-4 py-3 font-medium text-slate-500 w-24">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lineItems.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-3 text-slate-700">
                        {item.description}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600">
                        {item.quantity}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600 hidden sm:table-cell">
                        ${item.rate.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900">
                        ${item.amount.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end">
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between text-slate-500">
                  <span>Subtotal</span>
                  <span>${subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between font-bold text-slate-900 text-base pt-2 border-t border-slate-200">
                  <span>Total</span>
                  <span>${subtotal.toLocaleString()}</span>
                </div>
                <p className="text-xs text-slate-400">
                  Tax is not included in this draft.
                </p>
              </div>
            </div>

            {saveMessage && (
              <div
                role="status"
                aria-live="polite"
                className={`mt-5 rounded-xl px-4 py-3 text-sm ${saveError
                    ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                    : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                  }`}
              >
                {saveMessage}
              </div>
            )}

            <div className="flex flex-wrap gap-3 mt-6 pt-5 border-t border-slate-100">
              <button
                id="save-draft-btn"
                onClick={handleSaveDraft}
                disabled={isSaving || clientsLoading || clients.length === 0}
                className="flex items-center gap-2 border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium px-4 py-2.5 rounded-xl transition-colors"
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

              <button
                id="send-invoice-btn"
                onClick={handleSendInvoice}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors shadow-sm shadow-blue-200"
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
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
                Send Invoice (Demo)
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-2xl ring-1 ring-slate-200 p-6 sticky top-6">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-blue-600"
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
              <h2 className="font-semibold text-slate-900">
                AI Follow-up Assistant
              </h2>
            </div>

            <p className="text-slate-500 text-xs mb-4">
              Edit this sample reminder. Sending email is not connected yet.
            </p>

            <textarea
              id="reminder-textarea"
              value={reminderText}
              onChange={(e) => setReminderText(e.target.value)}
              rows={16}
              className="w-full border border-slate-200 rounded-xl px-3 py-3 text-xs text-slate-700 font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none transition bg-slate-50"
            />

            <div className="mt-4 space-y-2">
              <button
                id="send-reminder-btn"
                onClick={handleSendReminder}
                className={`w-full flex items-center justify-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl transition-all ${reminderSent
                    ? "bg-emerald-500 text-white"
                    : "bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-200"
                  }`}
              >
                {reminderSent ? "Reminder Sent! (Demo)" : "Send Reminder (Demo)"}
              </button>

              <button
                id="regenerate-reminder-btn"
                disabled
                className="w-full flex items-center justify-center gap-2 border border-slate-200 text-slate-400 text-sm font-medium px-4 py-2.5 rounded-xl cursor-not-allowed opacity-60"
              >
                Regenerate with AI (coming soon)
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
