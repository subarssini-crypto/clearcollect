/**
 * Server-side PayPal Orders v2 integration.
 *
 * All amounts, currencies, and payment outcomes come from MySQL and from
 * PayPal's API directly — never from the browser. Only this module may set
 * an invoice to PAID, and only after verifying a COMPLETED capture whose
 * order, invoice reference, amount, and currency all match the invoice.
 * Any failed check on PayPal-verified data holds the payment for owner review
 * (src/lib/payment-risk.ts) instead of marking it paid.
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
  type OAuthToken,
  type Order,
} from "@paypal/paypal-server-sdk";
import { prisma } from "@/lib/prisma";
import { InvoiceStatus } from "@/generated/prisma/enums";
import {
  PAYABLE_STATUSES,
  checkCapture,
  checkInvoiceTotals,
  invoiceStateChangedFlag,
  orderMismatchFlag,
  prismaReviewStore,
  reviewRows,
  type ReviewContext,
  type ReviewStore,
  type RiskFlag,
} from "@/lib/payment-risk";

export { PAYABLE_STATUSES };

/** PayPal currencies that do not support decimals. */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "HUF", "TWD"]);

// ── Client ────────────────────────────────────────────────────────────────────

let paypalClient: { client: Client; environment: Environment } | null = null;
let ordersController: OrdersController | null = null;

function getPaypalClient(): { client: Client; environment: Environment } {
  if (paypalClient) return paypalClient;

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

  paypalClient = { client, environment };
  return paypalClient;
}

function getOrdersController(): OrdersController {
  ordersController ??= new OrdersController(getPaypalClient().client);
  return ordersController;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class PaymentError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** The payment was held for owner review; the review row is already stored. */
export class PaymentHoldError extends PaymentError {
  constructor(public flags: RiskFlag[]) {
    super(`Payment held for review: ${flags.map((f) => f.code).join(", ")}`, 409);
  }
}

/**
 * Durably records the flags, then throws PaymentHoldError. If recording fails
 * the error is a 503 (transient) so webhook callers return 5xx and PayPal retries.
 */
export async function holdPayment(flags: RiskFlag[], ctx: ReviewContext, reviews: ReviewStore): Promise<never> {
  try {
    await reviews.save(reviewRows(flags, ctx));
  } catch (err) {
    console.error("[paypal] could not record payment review", err);
    throw new PaymentError("Payment needs review but the review could not be recorded", 503);
  }
  console.warn(`[paypal] payment held: ${flags.map((f) => f.code).join(", ")} (order ${ctx.orderId ?? "?"})`);
  throw new PaymentHoldError(flags);
}

/** True for a Prisma unique-constraint error on paypalCaptureId. */
function isCaptureIdConflict(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code !== "P2002") return false;
  return String((err as { meta?: { target?: unknown } }).meta?.target ?? "").includes("paypalCaptureId");
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
  if (checkInvoiceTotals(invoice).length > 0) {
    throw new PaymentError("This invoice's total could not be verified; please contact the sender", 409);
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
  /** True when the invoice was already PAID with this capture: nothing was written. */
  alreadyPaid?: boolean;
};

/**
 * Captures an approved PayPal order and marks its invoice PAID only after
 * verifying the completed capture against the invoice stored in MySQL.
 * Safe to call repeatedly for the same order.
 */
export async function captureOrderForInvoice(
  orderId: string,
  reviews: ReviewStore = prismaReviewStore
): Promise<CaptureOutcome> {
  const invoice = await prisma.invoice.findUnique({ where: { paypalOrderId: orderId } });
  if (!invoice) throw new PaymentError("No invoice is associated with this PayPal order", 404);

  if (invoice.status === InvoiceStatus.PAID && invoice.paypalCaptureId) {
    return { status: "paid", invoiceNumber: invoice.invoiceNumber, alreadyPaid: true };
  }

  const orders = getOrdersController();
  const ctx: ReviewContext = { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, orderId };

  if (!PAYABLE_STATUSES.includes(invoice.status)) {
    // Never capture; but if PayPal already captured funds (e.g. the invoice was
    // cancelled after the payer approved), hold it so the owner can refund.
    const existing = await orders.getOrder({ id: orderId }).then(
      (r) => r.result,
      (err) => {
        // Only a missing order is safe to ignore; transient errors must surface so PayPal retries.
        if (err instanceof ApiError && err.statusCode === 404) return null;
        throw err;
      }
    );
    const captured = existing?.status === OrderStatus.Completed
      ? existing.purchaseUnits?.[0]?.payments?.captures?.find((c) => c.status === CaptureStatus.Completed)
      : undefined;
    if (captured?.id) {
      await holdPayment(checkCapture(invoice, { id: captured.id, amount: captured.amount }, { captureInvoiceId: null }), { ...ctx, captureId: captured.id }, reviews);
    }
    throw new PaymentError(`A ${invoice.status} invoice cannot be paid`, 409);
  }

  let { result: order } = await orders.getOrder({ id: orderId });

  // Verify before moving money: the order must still match the invoice, and
  // the invoice's stored line items must still add up to its amount.
  if (order.id !== orderId || !orderMatchesInvoice(order, invoice)) {
    await holdPayment([orderMismatchFlag(invoice, order.purchaseUnits?.[0]?.amount)], ctx, reviews);
  }
  const totals = checkInvoiceTotals(invoice);
  if (totals.length > 0) await holdPayment(totals, ctx, reviews);

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
    await holdPayment([orderMismatchFlag(invoice, order.purchaseUnits?.[0]?.amount)], ctx, reviews);
  }

  const captures = order.purchaseUnits?.[0]?.payments?.captures ?? [];
  const capture = captures.find((c) => c.status === CaptureStatus.Completed);
  if (!capture) {
    if (captures.some((c) => c.status === CaptureStatus.Pending)) {
      return { status: "pending", invoiceNumber: invoice.invoiceNumber };
    }
    throw new PaymentError("PayPal capture did not complete", 402);
  }
  if (!capture.id) throw new PaymentError("PayPal capture has no ID", 502);

  // Final deterministic checks on the verified capture before anything is recorded.
  const captureCtx = { ...ctx, captureId: capture.id };
  const holder = await prisma.invoice.findUnique({ where: { paypalCaptureId: capture.id }, select: { id: true } });
  const flags = checkCapture(invoice, { id: capture.id, amount: capture.amount }, { captureInvoiceId: holder?.id ?? null });
  if (flags.length > 0) await holdPayment(flags, captureCtx, reviews);

  const record = verifiedPaymentRecord(
    { id: capture.id, createTime: capture.createTime },
    getPaypalClient().environment,
    new Date()
  );
  let recorded: "recorded" | "already_recorded";
  try {
    recorded = await recordVerifiedPayment(invoice.id, orderId, record);
  } catch (err) {
    // A concurrent write took this capture ID or changed the invoice: hold, never guess.
    if (isCaptureIdConflict(err)) {
      const other = await prisma.invoice.findUnique({ where: { paypalCaptureId: capture.id }, select: { id: true } });
      await holdPayment(checkCapture(invoice, { id: capture.id, amount: capture.amount }, { captureInvoiceId: other?.id ?? -1 }), captureCtx, reviews);
    }
    if (err instanceof PaymentError && err.status === 409) {
      await holdPayment([invoiceStateChangedFlag(invoice, capture.id)], captureCtx, reviews);
    }
    throw err;
  }

  return { status: "paid", invoiceNumber: invoice.invoiceNumber, ...(recorded === "already_recorded" && { alreadyPaid: true }) };
}

// ── Verified payment record ───────────────────────────────────────────────────

export type PaymentEnvironmentName = "SANDBOX" | "LIVE";

/** What is stored when a capture has been verified (see captureOrderForInvoice). */
export interface VerifiedPaymentRecord {
  captureId: string;
  paidAt: Date;
  environment: PaymentEnvironmentName;
}

/**
 * Builds the stored record from a capture PayPal returned to the server.
 * The payment time is PayPal's capture create_time; if PayPal omits it or it
 * is unparseable, the server's verification time is used instead. The
 * environment is the server's own PayPal client configuration.
 */
export function verifiedPaymentRecord(
  capture: { id: string; createTime?: string },
  environment: Environment,
  verifiedAt: Date
): VerifiedPaymentRecord {
  const captured = capture.createTime ? new Date(capture.createTime) : null;
  return {
    captureId: capture.id,
    paidAt: captured && !Number.isNaN(captured.getTime()) ? captured : verifiedAt,
    environment: environment === Environment.Production ? "LIVE" : "SANDBOX",
  };
}

/** Conditional writes for recording a verified payment. */
export interface PaymentStore {
  /** Unpaid invoice still tied to `orderId`, with no capture yet → PAID + record. False if nothing matched. */
  markPaid(invoiceId: number, orderId: string, record: VerifiedPaymentRecord): Promise<boolean>;
  current(invoiceId: number): Promise<{ status: string; paypalCaptureId: string | null } | null>;
}

export const prismaPaymentStore: PaymentStore = {
  async markPaid(invoiceId, orderId, record) {
    const { count } = await prisma.invoice.updateMany({
      where: {
        id: invoiceId,
        paypalOrderId: orderId,
        paypalCaptureId: null,
        status: { in: PAYABLE_STATUSES },
      },
      data: {
        status: InvoiceStatus.PAID,
        paypalCaptureId: record.captureId,
        paidAt: record.paidAt,
        paypalEnvironment: record.environment,
      },
    });
    return count === 1;
  },
  current: (invoiceId) =>
    prisma.invoice.findUnique({ where: { id: invoiceId }, select: { status: true, paypalCaptureId: true } }),
};

/**
 * Marks the invoice PAID with its verified capture, exactly once. The update
 * only matches an unpaid invoice still tied to this order with no capture, and
 * paypalCaptureId is unique, so a repeated webhook or return for the same
 * capture is a no-op ("already_recorded") that leaves the first record intact.
 */
export async function recordVerifiedPayment(
  invoiceId: number,
  orderId: string,
  record: VerifiedPaymentRecord,
  store: PaymentStore = prismaPaymentStore
): Promise<"recorded" | "already_recorded"> {
  if (await store.markPaid(invoiceId, orderId, record)) return "recorded";

  const current = await store.current(invoiceId);
  if (current?.status === InvoiceStatus.PAID && current.paypalCaptureId === record.captureId) {
    return "already_recorded";
  }
  console.error(`[paypal] capture ${record.captureId} completed but invoice ${invoiceId} could not be marked PAID`);
  throw new PaymentError("Payment captured but invoice state changed; needs review", 409);
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

const WEBHOOK_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

let cachedToken: OAuthToken | undefined;

async function getAccessToken(): Promise<string> {
  const auth = getPaypalClient().client.clientCredentialsAuthManager;
  if (!auth.isValid(cachedToken) || auth.isExpired(cachedToken)) {
    cachedToken = await auth.fetchToken();
  }
  return cachedToken.accessToken;
}

/**
 * Verifies a webhook delivery with PayPal's verify-webhook-signature API
 * (the SDK has no webhook controller). The raw body is embedded unmodified
 * so re-serialization cannot alter the signed payload.
 * Returns false for missing headers or a failed verification.
 */
export async function verifyWebhookSignature(headers: Headers, rawBody: string): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new PaymentError("PAYPAL_WEBHOOK_ID is not configured", 500);

  // Must be exactly one JSON object, so embedding it below cannot inject fields.
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  } catch {
    return false;
  }

  const fields: Record<string, string> = { webhook_id: webhookId };
  for (const [field, header] of Object.entries(WEBHOOK_HEADERS)) {
    const value = headers.get(header);
    if (!value) return false;
    fields[field] = value;
  }

  // Use the SDK-selected environment's fixed host so the token is never sent elsewhere.
  const apiBase =
    getPaypalClient().environment === Environment.Production
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const body = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${rawBody}}`;
  const response = await fetch(`${apiBase}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
    },
    body,
    cache: "no-store",
  });

  if (response.status >= 500) {
    throw new PaymentError(`PayPal verification unavailable (${response.status})`, 502);
  }
  if (!response.ok) return false;
  const result = (await response.json()) as { verification_status?: string };
  return result.verification_status === "SUCCESS";
}

/** Converts any thrown error into a safe status + message (no secrets). */
export function describePaymentError(err: unknown): { status: number; message: string } {
  if (err instanceof PaymentError) return { status: err.status, message: err.message };
  if (err instanceof ApiError) {
    return { status: 502, message: `PayPal request failed${paypalIssue(err) ? `: ${paypalIssue(err)}` : ""}` };
  }
  return { status: 500, message: "Payment processing failed" };
}

/** Public origin used to redirect the browser back into the app. */
export function getAppOrigin(requestUrl: string): string {
  return process.env.APP_URL?.replace(/\/$/, "") || new URL(requestUrl).origin;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Trusted origin for the return/cancel URLs embedded in a new PayPal order.
 * Orders are stored and reused for later payers, so this must never come from
 * a spoofable Host header: it is APP_URL, or — when APP_URL is unset — only a
 * local development origin.
 */
export function getPaymentReturnOrigin(requestUrl: string, appUrl = process.env.APP_URL): string {
  const configured = appUrl?.trim();
  if (configured) {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      throw new PaymentError("APP_URL is not a valid URL", 500);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new PaymentError("APP_URL must be an http(s) URL", 500);
    }
    return parsed.origin;
  }
  const request = new URL(requestUrl);
  if (!LOCAL_HOSTNAMES.has(request.hostname)) {
    throw new PaymentError("APP_URL must be set to accept payments outside local development", 500);
  }
  return request.origin;
}
