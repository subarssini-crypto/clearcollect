/**
 * Strict validation for AI-generated invoice drafts.
 *
 * The AI only proposes client, currency, dates, and line items. This module
 * rejects anything else (status, payment fields, amounts, totals), recomputes
 * every line amount and the total in integer cents, and finally runs the
 * result through the regular invoice validation. Nothing here saves data.
 */

import { VALID_CURRENCIES, validateCreateInvoice, type ValidationError, type ValidationResult } from "@/lib/validation";

export const MAX_DRAFT_REQUEST_LENGTH = 2000;
const MAX_LINE_ITEMS = 50;
const MAX_AMOUNT_CENTS = 9_999_999_999; // 99,999,999.99 — matches validation.ts
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY"]);

export interface DraftLineItem {
  description: string;
  quantity: number;
  rate: number;
  amount: number; // computed server-side
}

export interface InvoiceDraft {
  clientId: number | null;
  currency: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  lineItems: DraftLineItem[];
  total: number; // computed server-side
  assumptions: string[];
}

/** JSON schema the model must follow. Deliberately has no status/payment/amount fields. */
export const DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clientId", "currency", "issueDate", "dueDate", "lineItems", "assumptions"],
  properties: {
    clientId: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "id of the matching client from the provided list, or null if unclear",
    },
    currency: { type: "string", enum: [...VALID_CURRENCIES] },
    issueDate: { type: "string", description: "YYYY-MM-DD" },
    dueDate: { type: "string", description: "YYYY-MM-DD, after issueDate" },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "rate"],
        properties: {
          description: { type: "string" },
          quantity: { type: "number", description: "units, e.g. hours" },
          rate: { type: "number", description: "price per unit" },
        },
      },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "anything inferred, defaulted, or missing that the user should check",
    },
  },
} as const;

const TOP_LEVEL_KEYS = new Set(DRAFT_JSON_SCHEMA.required);
const LINE_ITEM_KEYS = new Set(DRAFT_JSON_SCHEMA.properties.lineItems.items.required);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Converts a number with at most `decimals` decimals to an integer scaled by 100; null if invalid. */
function toHundredths(v: unknown, decimals: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const scaled = Math.round(v * 100);
  if (Math.abs(v * 100 - scaled) > 1e-6) return null; // more than 2 decimals
  if (decimals === 0 && scaled % 100 !== 0) return null;
  return scaled;
}

export function validateInvoiceDraft(
  raw: unknown,
  ctx: { clientIds: number[] }
): ValidationResult<InvoiceDraft> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field: "draft", message: "Draft must be a JSON object" }] };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key as never)) errors.push({ field: key, message: "Unexpected field in AI draft" });
  }

  // Client: only ids from the provided list; anything else becomes "unselected".
  const assumptions: string[] = [];
  let clientId: number | null = null;
  if (raw.clientId !== null) {
    if (typeof raw.clientId === "number" && ctx.clientIds.includes(raw.clientId)) {
      clientId = raw.clientId;
    } else {
      assumptions.push("The suggested client was not recognised; please select a client.");
    }
  }

  const currency = typeof raw.currency === "string" ? raw.currency.toUpperCase() : "";
  if (!VALID_CURRENCIES.has(currency)) {
    errors.push({ field: "currency", message: "Unsupported currency" });
  }

  if (!isIsoDate(raw.issueDate)) errors.push({ field: "issueDate", message: "issueDate must be YYYY-MM-DD" });
  if (!isIsoDate(raw.dueDate)) errors.push({ field: "dueDate", message: "dueDate must be YYYY-MM-DD" });
  else if (isIsoDate(raw.issueDate) && raw.dueDate <= raw.issueDate) {
    errors.push({ field: "dueDate", message: "dueDate must be after issueDate" });
  }

  const lineItems: DraftLineItem[] = [];
  let totalCents = 0;
  if (!Array.isArray(raw.lineItems) || raw.lineItems.length === 0) {
    errors.push({ field: "lineItems", message: "At least one line item is required" });
  } else if (raw.lineItems.length > MAX_LINE_ITEMS) {
    errors.push({ field: "lineItems", message: `At most ${MAX_LINE_ITEMS} line items are allowed` });
  } else {
    const rateDecimals = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
    raw.lineItems.forEach((item, i) => {
      const field = `lineItems[${i}]`;
      if (!isPlainObject(item)) {
        errors.push({ field, message: "Line item must be an object" });
        return;
      }
      for (const key of Object.keys(item)) {
        if (!LINE_ITEM_KEYS.has(key as never)) errors.push({ field: `${field}.${key}`, message: "Unexpected field in line item" });
      }
      const description = typeof item.description === "string" ? item.description.trim() : "";
      if (!description || description.length > 200) {
        errors.push({ field: `${field}.description`, message: "Description must be 1–200 characters" });
      }
      const qty = toHundredths(item.quantity, 2);
      if (qty === null || qty > 100_000_00) {
        errors.push({ field: `${field}.quantity`, message: "Quantity must be positive with at most 2 decimals" });
      }
      const rateCents = toHundredths(item.rate, rateDecimals);
      if (rateCents === null) {
        errors.push({
          field: `${field}.rate`,
          message: rateDecimals === 0 ? `${currency} rates must be whole numbers` : "Rate must be positive with at most 2 decimals",
        });
      }
      if (qty !== null && rateCents !== null && description) {
        const amountCents = Math.round((qty * rateCents) / 100);
        totalCents += amountCents;
        lineItems.push({ description, quantity: qty / 100, rate: rateCents / 100, amount: amountCents / 100 });
      }
    });
  }

  if (totalCents > MAX_AMOUNT_CENTS) errors.push({ field: "total", message: "Total exceeds maximum (99,999,999.99)" });
  if (ZERO_DECIMAL_CURRENCIES.has(currency) && totalCents % 100 !== 0) {
    errors.push({ field: "total", message: `${currency} totals must be whole numbers` });
  }

  if (!Array.isArray(raw.assumptions) || !raw.assumptions.every((a) => typeof a === "string")) {
    errors.push({ field: "assumptions", message: "assumptions must be a list of strings" });
  } else {
    assumptions.unshift(...raw.assumptions.map((a) => a.trim().slice(0, 300)).filter(Boolean).slice(0, 10));
  }

  if (errors.length > 0) return { ok: false, errors };

  // Final check with the same rules the invoice API applies on save.
  const check = validateCreateInvoice({
    invoiceNumber: "DRAFT-CHECK",
    clientId: clientId ?? 1,
    description: lineItems.map((l) => l.description).join("; "),
    amount: totalCents / 100,
    currency,
    issueDate: raw.issueDate,
    dueDate: raw.dueDate,
  });
  if (!check.ok) return check;

  return {
    ok: true,
    data: {
      clientId,
      currency,
      issueDate: raw.issueDate as string,
      dueDate: raw.dueDate as string,
      lineItems,
      total: totalCents / 100,
      assumptions,
    },
  };
}
