"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Notice, btnPrimary } from "@/components/ui";

type LineItem = { description: string; quantity: number; rate: number; unit?: string };

type PublicInvoice = {
  state: "payable" | "paid";
  invoiceNumber: string;
  clientName: string;
  clientCompany: string | null;
  description: string;
  lineItems: LineItem[] | null;
  amount: string;
  currency: string;
  issueDate: string;
  dueDate: string;
  overdue: boolean;
  paidAt: string | null;
};

function money(value: number | string, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code" }).format(Number(value));
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`;
  }
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Display-only messages for the PayPal redirect result; status always comes from the server. */
const RESULT_NOTICES: Record<string, { tone: "info" | "error" | "warning"; text: string }> = {
  pending: { tone: "warning", text: "PayPal is still processing your payment. This invoice stays unpaid until it completes." },
  cancelled: { tone: "info", text: "Payment was cancelled. You have not been charged." },
  error: { tone: "error", text: "The payment could not be completed. You can try again." },
};

export default function PayInvoice() {
  const { token } = useParams<{ token: string }>();
  const result = useSearchParams().get("payment");
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [loadError, setLoadError] = useState("");
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState("");

  useEffect(() => {
    fetch(`/api/pay/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (res) => {
        const json: { ok?: boolean; data?: PublicInvoice; error?: string } = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "This invoice could not be loaded.");
        setInvoice(json.data);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "This invoice could not be loaded."));
  }, [token]);

  async function pay() {
    if (paying) return;
    setPaying(true);
    setPayError("");
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/order`, { method: "POST" });
      const json: { ok?: boolean; data?: { approveUrl: string }; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok || !json.data) throw new Error(json.error || "Payment could not be started.");
      window.location.assign(json.data.approveUrl);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment could not be started.");
      setPaying(false);
    }
  }

  const notice = invoice?.state === "payable" && result ? RESULT_NOTICES[result] : undefined;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <p className="mb-4 text-sm font-bold tracking-tight text-navy">ClearCollect</p>

      {!invoice && !loadError && <p className="text-sm text-muted">Loading invoice…</p>}
      {loadError && <Notice tone="error">{loadError} Please check the link in your email or contact the sender.</Notice>}

      {invoice && (
        <div className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold text-navy">Invoice {invoice.invoiceNumber}</h1>
              <p className="text-[13px] text-muted">
                For {invoice.clientName}
                {invoice.clientCompany ? ` · ${invoice.clientCompany}` : ""}
              </p>
            </div>
            {invoice.state === "paid" ? (
              <span id="pay-status-paid" className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">
                Paid
              </span>
            ) : (
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${invoice.overdue ? "bg-red-50 text-red-700 ring-red-200" : "bg-amber-50 text-amber-700 ring-amber-200"}`}>
                {invoice.overdue ? "Overdue" : "Unpaid"}
              </span>
            )}
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <dt className="text-muted">Issue date</dt>
              <dd className="font-medium text-navy">{longDate(invoice.issueDate)}</dd>
            </div>
            <div>
              <dt className="text-muted">Due date</dt>
              <dd className="font-medium text-navy">{longDate(invoice.dueDate)}</dd>
            </div>
          </dl>

          <div className="mt-4 border-t border-line pt-4">
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
            <div className="mt-4 flex justify-between border-t border-line pt-3 text-sm font-bold text-navy">
              <span>Total</span>
              <span>{money(invoice.amount, invoice.currency)}</span>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {invoice.state === "paid" ? (
              <Notice tone="success">
                This invoice has been paid{invoice.paidAt ? ` (${longDate(invoice.paidAt)})` : ""}. Thank you!
              </Notice>
            ) : (
              <>
                {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
                {payError && <Notice tone="error">{payError}</Notice>}
                <button id="pay-with-paypal" type="button" onClick={pay} disabled={paying} className={`${btnPrimary} w-full justify-center`}>
                  {paying ? "Redirecting to PayPal…" : `Pay ${money(invoice.amount, invoice.currency)} with PayPal`}
                </button>
                <p className="text-center text-xs text-muted">You will be redirected to PayPal to complete the payment securely.</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
