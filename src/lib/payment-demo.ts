/**
 * Owner-only payment-risk demo. Runs the real deterministic rules
 * (checkCapture) and the real exactly-once recorder (recordVerifiedPayment)
 * against mock invoices held in memory. It imports no database, PayPal,
 * or email code path that writes: nothing outside this function changes.
 */

import { recordVerifiedPayment, type PaymentStore, type VerifiedPaymentRecord } from "@/lib/paypal";
import { checkCapture, reviewRows, type InvoiceFacts, type PaymentReviewInput, type RiskFlag } from "@/lib/payment-risk";

export interface DemoResult {
  demo: true;
  scenario: string;
  invoiceNumber: string;
  captureId: string;
  decision: "approved" | "held" | "already_recorded";
  invoiceStatusAfter: string;
  flags: RiskFlag[];
  explanation: string;
}

type DemoInvoice = InvoiceFacts & { paypalOrderId: string };

/** In-memory twin of prismaPaymentStore (same conditional update). */
function memoryStore(rows: DemoInvoice[]): PaymentStore {
  return {
    async markPaid(invoiceId, orderId, record: VerifiedPaymentRecord) {
      const row = rows.find((r) => r.id === invoiceId && r.paypalOrderId === orderId && r.paypalCaptureId === null && (r.status === "SENT" || r.status === "OVERDUE"));
      if (!row || rows.some((r) => r.paypalCaptureId === record.captureId)) return false;
      row.status = "PAID";
      row.paypalCaptureId = record.captureId;
      return true;
    },
    async current(invoiceId) {
      const row = rows.find((r) => r.id === invoiceId);
      return row ? { status: row.status, paypalCaptureId: row.paypalCaptureId } : null;
    },
  };
}

export async function runPaymentDemo(): Promise<{ results: DemoResult[]; reviews: PaymentReviewInput[] }> {
  const invoices: DemoInvoice[] = [
    { id: -1, invoiceNumber: "DEMO-001", amount: "250.00", currency: "USD", status: "SENT", paypalOrderId: "DEMOORDER1", paypalCaptureId: null, lineItems: [{ description: "Design work", quantity: 2, rate: 125 }] },
    { id: -2, invoiceNumber: "DEMO-002", amount: "400.00", currency: "USD", status: "SENT", paypalOrderId: "DEMOORDER2", paypalCaptureId: null, lineItems: [{ description: "Consulting", quantity: 4, rate: 100 }] },
    { id: -3, invoiceNumber: "DEMO-003", amount: "250.00", currency: "USD", status: "SENT", paypalOrderId: "DEMOORDER3", paypalCaptureId: null, lineItems: null },
  ];
  const store = memoryStore(invoices);
  const reviews: PaymentReviewInput[] = [];
  const results: DemoResult[] = [];

  async function process(scenario: string, invoice: DemoInvoice, captureId: string, value: string, explain: (d: DemoResult["decision"]) => string) {
    // Same short-circuit as captureOrderForInvoice: an invoice already paid by
    // this capture is a no-op, so no rules run and nothing is flagged.
    const alreadyRecorded = invoice.status === "PAID" && invoice.paypalCaptureId === captureId;
    const holder = invoices.find((r) => r.paypalCaptureId === captureId);
    const flags = alreadyRecorded ? [] : checkCapture(invoice, { id: captureId, amount: { currencyCode: "USD", value } }, { captureInvoiceId: holder?.id ?? null });
    let decision: DemoResult["decision"];
    if (alreadyRecorded) {
      decision = "already_recorded";
    } else if (flags.length > 0) {
      decision = "held";
      reviews.push(...reviewRows(flags, { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, orderId: invoice.paypalOrderId, captureId }));
    } else {
      const outcome = await recordVerifiedPayment(invoice.id, invoice.paypalOrderId, { captureId, paidAt: new Date(), environment: "SANDBOX" }, store);
      decision = outcome === "recorded" ? "approved" : "already_recorded";
    }
    results.push({ demo: true, scenario, invoiceNumber: invoice.invoiceNumber, captureId, decision, invoiceStatusAfter: invoice.status, flags, explanation: explain(decision) });
  }

  await process("Valid payment", invoices[0], "DEMOCAPTURE1", "250.00", () =>
    "Capture amount, currency and line-item total all match, so the mock invoice is marked PAID.");
  await process("Wrong amount", invoices[1], "DEMOCAPTURE2", "40.00", () =>
    "PayPal captured USD 40.00 for a USD 400.00 invoice. The payment is held for review and the invoice stays unpaid.");
  await process("Duplicate delivery (same invoice)", invoices[0], "DEMOCAPTURE1", "250.00", () =>
    "The same capture arrived again (webhook redelivery). It is recognised as already recorded; nothing changes.");
  await process("Duplicate payment (capture reused)", invoices[2], "DEMOCAPTURE1", "250.00", () =>
    "A capture already used to pay DEMO-001 is presented for DEMO-003. It is held as a duplicate; DEMO-003 stays unpaid.");

  return { results, reviews };
}
