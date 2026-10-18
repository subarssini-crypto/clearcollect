/**
 * Server-side PayPal Orders v2 integration.
 *
 * All amounts, currencies, and payment outcomes come from MySQL and from
 * PayPal's API directly — never from the browser. Only this module may set
 * an invoice to PAID, and only after verifying a COMPLETED capture whose
 * order, invoice reference, amount, and currency all match the invoice.
 *
 * Never import this file from a client component.
 */

import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  OrdersController,
  OrderStatus,
  CaptureStatus,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type Order,
} from "@paypal/paypal-server-sdk";
import { prisma } from "@/lib/prisma";
import { InvoiceStatus } from "@/generated/prisma/enums";

/** Invoice statuses that may be paid via PayPal. */
export const PAYABLE_STATUSES: InvoiceStatus[] = [InvoiceStatus.SENT, InvoiceStatus.OVERDUE];

/** PayPal currencies that do not support decimals. */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "HUF", "TWD"]);

// ── Client ────────────────────────────────────────────────────────────────────

let ordersController: OrdersController | null = null;

function getOrdersController(): OrdersController {
  if (ordersController) return ordersController;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new PaymentError("PayPal is not configured on the server", 500);
  }

  // The SDK selects its host by environment; default to Sandbox unless the
  // configured base URL is clearly the live API.
  const baseUrl = process.env.PAYPAL_BASE_URL ?? "";
  const environment =
    baseUrl && !baseUrl.includes("sandbox") ? Environment.Production : Environment.Sandbox;

  const client = new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: clientId,
      oAuthClientSecret: clientSecret,
    },
    timeout: 15000,
    environment,
  });

  ordersController = new OrdersController(client);
  return ordersController;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class PaymentError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function paypalIssue(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const result = err.result as { details?: { issue?: string }[]; name?: string } | undefined;
  return result?.details?.[0]?.issue ?? result?.name;
}

// ── Amount helpers ────────────────────────────────────────────────────────────

/** Formats a DB Decimal amount as a PayPal amount string for the currency. */
export function toPaypalValue(amount: { toString(): string }, currency: string): string {
  const cents = toMinorUnits(amount.toString());
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    if (cents % 100 !== 0) {
      throw new PaymentError(`${currency} amounts cannot contain decimals for PayPal`, 422);
    }
    return String(cents / 100);
  }
  return (cents / 100).toFixed(2);
}

/** Parses a decimal string into integer hundredths, avoiding float comparison. */
function toMinorUnits(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new PaymentError("Invalid amount value", 500);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function amountsMatch(
  money: { currencyCode?: string; value?: string } | undefined,
  invoice: { amount: { toString(): string }; currency: string }
): boolean {
  if (!money?.value || money.currencyCode !== invoice.currency) return false;
  try {
    return toMinorUnits(money.value) === toMinorUnits(invoice.amount.toString());
  } catch {
    return false;
  }
}

function approvalUrl(order: Order): string | undefined {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}

/** Checks the order belongs to this invoice and charges exactly its amount. */
function orderMatchesInvoice(
  order: Order,
  invoice: { id: number; amount: { toString(): string }; currency: string }
): boolean {
  const units = order.purchaseUnits ?? [];
  if (order.intent !== CheckoutPaymentIntent.Capture || units.length !== 1) return false;
  const unit = units[0];
  return (
    unit.referenceId === String(invoice.id) &&
    unit.customId === String(invoice.id) &&
    amountsMatch(unit.amount, invoice)
  );
}

// ── Order creation ────────────────────────────────────────────────────────────

/**
 * Returns a PayPal approval URL for the invoice, reusing a still-valid
 * existing order or creating a new one from the invoice's DB amount.
 */
export async function createOrderForInvoice(
  invoiceId: number,
  appOrigin: string
): Promise<{ approveUrl: string; orderId: string }> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new PaymentError(`Invoice ${invoiceId} not found`, 404);
  if (invoice.status === InvoiceStatus.PAID) {
    throw new PaymentError("Invoice is already paid", 409);
  }
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    throw new PaymentError(`A ${invoice.status} invoice cannot be paid`, 409);
  }

  const orders = getOrdersController();
  const value = toPaypalValue(invoice.amount, invoice.currency);

  // Reuse an existing order if it is still awaiting approval and unchanged.
  if (invoice.paypalOrderId) {
    try {
      const { result: existing } = await orders.getOrder({ id: invoice.paypalOrderId });
      if (orderMatchesInvoice(existing, invoice)) {
        if (existing.status === OrderStatus.Approved || existing.status === OrderStatus.Completed) {
          // Already approved/captured — finish via the return handler instead.
          const url = new URL("/api/paypal/return", appOrigin);
          url.searchParams.set("token", invoice.paypalOrderId);
          return { approveUrl: url.toString(), orderId: invoice.paypalOrderId };
        }
        const href = approvalUrl(existing);
        if (
          href &&
          (existing.status === OrderStatus.Created ||
            existing.status === OrderStatus.PayerActionRequired)
        ) {
          return { approveUrl: href, orderId: invoice.paypalOrderId };
        }
      }
    } catch (err) {
      // A missing/expired order is replaced below; anything else is fatal.
      if (!(err instanceof ApiError && err.statusCode === 404)) throw err;
    }
  }

  // Same previous state + amount → same PayPal-Request-Id, so concurrent
  // clicks resolve to one PayPal order instead of duplicates.
  const requestId = `cc-${invoice.id}-${invoice.paypalOrderId ?? "new"}-${value}${invoice.currency}`;

  const { result: order } = await orders.createOrder({
    paypalRequestId: requestId,
    prefer: "return=representation",
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          referenceId: String(invoice.id),
          customId: String(invoice.id),
          invoiceId: invoice.invoiceNumber,
          description: invoice.description.slice(0, 127),
          amount: { currencyCode: invoice.currency, value },
        },
      ],
      paymentSource: {
        paypal: {
          experienceContext: {
            brandName: "ClearCollect",
            userAction: PaypalExperienceUserAction.PayNow,
            shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
            returnUrl: new URL("/api/paypal/return", appOrigin).toString(),
            cancelUrl: new URL("/api/paypal/cancel", appOrigin).toString(),
          },
        },
      },
    },
  });

  const href = order.id ? approvalUrl(order) : undefined;
  if (!order.id || !href) throw new PaymentError("PayPal did not return an approval link", 502);

  // Only store the order if the invoice hasn't changed underneath us.
  const { count } = await prisma.invoice.updateMany({
    where: {
      id: invoice.id,
      paypalOrderId: invoice.paypalOrderId,
      status: { in: PAYABLE_STATUSES },
      paypalCaptureId: null,
    },
    data: { paypalOrderId: order.id },
  });
  if (count === 0) {
    const current = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      select: { paypalOrderId: true },
    });
    if (current?.paypalOrderId !== order.id) {
      throw new PaymentError("Invoice changed while creating the payment; please retry", 409);
    }
  }

  return { approveUrl: href, orderId: order.id };
}

// ── Capture ───────────────────────────────────────────────────────────────────

export type CaptureOutcome = {
  status: "paid" | "pending";
  invoiceNumber: string;
};

/**
 * Captures an approved PayPal order and marks its invoice PAID only after
 * verifying the completed capture against the invoice stored in MySQL.
 * Safe to call repeatedly for the same order.
 */
export async function captureOrderForInvoice(orderId: string): Promise<CaptureOutcome> {
  const invoice = await prisma.invoice.findUnique({ where: { paypalOrderId: orderId } });
  if (!invoice) throw new PaymentError("No invoice is associated with this PayPal order", 404);

  if (invoice.status === InvoiceStatus.PAID && invoice.paypalCaptureId) {
    return { status: "paid", invoiceNumber: invoice.invoiceNumber };
  }
  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    throw new PaymentError(`A ${invoice.status} invoice cannot be paid`, 409);
  }

  const orders = getOrdersController();
  let { result: order } = await orders.getOrder({ id: orderId });

  // Verify before moving money: the order must still match the invoice.
  if (order.id !== orderId || !orderMatchesInvoice(order, invoice)) {
    throw new PaymentError("PayPal order does not match this invoice", 409);
  }

  if (order.status === OrderStatus.Approved) {
    try {
      ({ result: order } = await orders.captureOrder({
        id: orderId,
        paypalRequestId: `cc-capture-${orderId}`,
        prefer: "return=representation",
      }));
    } catch (err) {
      if (paypalIssue(err) !== "ORDER_ALREADY_CAPTURED") throw err;
      ({ result: order } = await orders.getOrder({ id: orderId }));
    }
  }

  if (order.status !== OrderStatus.Completed) {
    throw new PaymentError(`PayPal order is ${order.status ?? "in an unknown state"}, not approved`, 409);
  }
  if (order.id !== orderId || !orderMatchesInvoice(order, invoice)) {
    throw new PaymentError("PayPal order does not match this invoice", 409);
  }

  const captures = order.purchaseUnits?.[0]?.payments?.captures ?? [];
  const capture = captures.find((c) => c.status === CaptureStatus.Completed);
  if (!capture) {
    if (captures.some((c) => c.status === CaptureStatus.Pending)) {
      return { status: "pending", invoiceNumber: invoice.invoiceNumber };
    }
    throw new PaymentError("PayPal capture did not complete", 402);
  }
  if (!capture.id || !amountsMatch(capture.amount, invoice)) {
    throw new PaymentError("Captured amount does not match the invoice", 409);
  }

  // Conditional update: only transitions an unpaid invoice still tied to
  // this order. The unique paypalCaptureId column blocks reuse of a capture.
  const { count } = await prisma.invoice.updateMany({
    where: {
      id: invoice.id,
      paypalOrderId: orderId,
      paypalCaptureId: null,
      status: { in: PAYABLE_STATUSES },
    },
    data: { status: InvoiceStatus.PAID, paypalCaptureId: capture.id },
  });

  if (count === 0) {
    const current = await prisma.invoice.findUnique({
      where: { id: invoice.id },
      select: { status: true, paypalCaptureId: true },
    });
    if (current?.status !== InvoiceStatus.PAID || current.paypalCaptureId !== capture.id) {
      console.error(
        `[paypal] capture ${capture.id} completed but invoice ${invoice.id} could not be marked PAID`
      );
      throw new PaymentError("Payment captured but invoice state changed; needs review", 409);
    }
  }

  return { status: "paid", invoiceNumber: invoice.invoiceNumber };
}

/** Converts any thrown error into a safe status + message (no secrets). */
export function describePaymentError(err: unknown): { status: number; message: string } {
  if (err instanceof PaymentError) return { status: err.status, message: err.message };
  if (err instanceof ApiError) {
    return { status: 502, message: `PayPal request failed${paypalIssue(err) ? `: ${paypalIssue(err)}` : ""}` };
  }
  return { status: 500, message: "Payment processing failed" };
}

/** Public origin used for PayPal return/cancel URLs. */
export function getAppOrigin(requestUrl: string): string {
  return process.env.APP_URL?.replace(/\/$/, "") || new URL(requestUrl).origin;
}
