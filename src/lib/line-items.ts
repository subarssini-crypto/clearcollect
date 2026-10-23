/**
 * Invoice line items as stored in Invoice.lineItems (JSON) and shown in
 * invoice emails. Pure functions only, shared by the Create Invoice page and
 * the server so both compute amounts with the same integer-cents rounding.
 */

export const LINE_UNITS = ["hour", "day", "week", "month", "item", "fixed"] as const;
export type LineUnit = (typeof LINE_UNITS)[number];

export const MAX_LINE_ITEMS = 50;
export const MAX_LINE_DESCRIPTION_LENGTH = 200;
const MAX_QUANTITY = 1_000_000;
const MAX_RATE = 99_999_999.99;

export interface StoredLineItem {
  description: string;
  quantity: number;
  rate: number;
  unit?: LineUnit;
}

/** Line amount in integer cents: quantity and rate rounded to cents first. */
export function lineItemCents(item: { quantity: number; rate: number }): number {
  return Math.round((Math.round(item.quantity * 100) * Math.round(item.rate * 100)) / 100);
}

export function lineItemsTotalCents(items: { quantity: number; rate: number }[]): number {
  return items.reduce((sum, item) => sum + lineItemCents(item), 0);
}

type Errors = { field: string; message: string }[];

/** Validates line items sent by the browser. */
export function validateLineItems(raw: unknown, field = "lineItems"): { ok: true; data: StoredLineItem[] } | { ok: false; errors: Errors } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LINE_ITEMS) {
    return { ok: false, errors: [{ field, message: `${field} must be a list of 1–${MAX_LINE_ITEMS} items` }] };
  }
  const errors: Errors = [];
  const data: StoredLineItem[] = [];
  raw.forEach((item, i) => {
    const f = `${field}[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push({ field: f, message: "each line item must be an object" });
      return;
    }
    const { description, quantity, rate, unit } = item as Record<string, unknown>;
    const desc = typeof description === "string" ? description.trim() : "";
    if (!desc || desc.length > MAX_LINE_DESCRIPTION_LENGTH) {
      errors.push({ field: `${f}.description`, message: `description must be 1–${MAX_LINE_DESCRIPTION_LENGTH} characters` });
    }
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) {
      errors.push({ field: `${f}.quantity`, message: "quantity must be a positive number" });
    }
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > MAX_RATE) {
      errors.push({ field: `${f}.rate`, message: "rate must be a positive number" });
    }
    if (unit !== undefined && !LINE_UNITS.includes(unit as LineUnit)) {
      errors.push({ field: `${f}.unit`, message: `unit must be one of: ${LINE_UNITS.join(", ")}` });
    }
    data.push({
      description: desc,
      quantity: quantity as number,
      rate: rate as number,
      ...(unit !== undefined ? { unit: unit as LineUnit } : {}),
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, data };
}

/** Reads Invoice.lineItems from the database; null when absent or malformed. */
export function parseStoredLineItems(json: unknown): StoredLineItem[] | null {
  if (json === null || json === undefined) return null;
  const result = validateLineItems(json);
  return result.ok ? result.data : null;
}
