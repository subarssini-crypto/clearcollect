/**
 * Strict validation for AI-generated invoice drafts.
 *
 * The AI only proposes line items, currency, explicitly stated dates, the
 * client name as written in the request, and clarification questions. This
 * module rejects anything else (status, payment fields, amounts, totals,
 * client ids), recomputes every line amount and the total in integer cents,
 * resolves the client against database records, applies visible date
 * defaults, flags numbers the user never stated, and finally runs the result
 * through the regular invoice validation. Nothing here saves data.
 */

import { VALID_CURRENCIES, validateCreateInvoice, type ValidationError, type ValidationResult } from "@/lib/validation";

export const MAX_DRAFT_REQUEST_LENGTH = 2000;
export const DEFAULT_DUE_DAYS = 14;
export const DEFAULT_CURRENCY = "USD";
const MAX_LINE_ITEMS = 50;
const MAX_QUESTIONS = 5;
const MAX_PAYMENT_TERMS_DAYS = 365;
const MAX_AMOUNT_CENTS = 9_999_999_999; // 99,999,999.99 — matches validation.ts
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY"]);

/** Where a draft value came from, so the UI can label defaults honestly. */
export type DateSource = "request" | "payment_terms" | "form" | "default";

export interface DraftClient {
  id: number;
  name: string;
  company: string | null;
}

/** What a line item's quantity counts; "fixed" is a single fixed price. */
export const LINE_UNITS = ["hour", "day", "week", "month", "item", "fixed"] as const;
export type LineUnit = (typeof LINE_UNITS)[number];

export interface DraftLineItem {
  description: string;
  quantity: number;
  unit: LineUnit;
  rate: number;
  amount: number; // computed server-side
  /** Quantity or rate does not appear in the user's request. */
  needsConfirmation: boolean;
}

/**
 * One clarification question. Field questions (`field` set) have a stable id
 * such as "lineItems[0].rate" and are answered one value per question;
 * general questions (`field` null, id "q0", "q1", …) are answered in words.
 */
export interface ClarifyQuestion {
  id: string;
  text: string;
  field: "quantity" | "rate" | null;
  /** Why the previous answer to this question was not accepted. */
  problem?: string;
  previousAnswer?: string;
}

export interface ClarifyAnswer {
  id: string;
  /** Echo of the question text (general questions only). */
  question?: string;
  answer: string;
}

export interface InvoiceDraft {
  clientId: number | null;
  /** Shown prominently when the client changed or must be chosen. */
  clientNotice: string | null;
  currency: string;
  currencySource: "request" | "default";
  issueDate: string; // YYYY-MM-DD
  issueDateSource: DateSource;
  dueDate: string; // YYYY-MM-DD
  dueDateSource: DateSource;
  lineItems: DraftLineItem[];
  total: number; // computed server-side
  assumptions: string[];
  /** Values the user must explicitly confirm before saving. */
  confirmations: string[];
}

export interface Clarification {
  kind: "clarification";
  questions: ClarifyQuestion[];
  /**
   * The partial draft whose missing fields the field questions ask for. It is
   * sent back with the answers and fully re-validated; null for general
   * questions, which are answered by drafting again.
   */
  pending: Record<string, unknown> | null;
  notes: string[];
}

export type DraftOutcome = Clarification | ({ kind: "draft" } & InvoiceDraft);

/** General (free-text) clarification, e.g. from the deterministic pre-check. */
export function generalClarification(texts: string[]): Clarification {
  return { kind: "clarification", questions: texts.map((text, i) => ({ id: `q${i}`, text, field: null })), pending: null, notes: [] };
}

export interface DraftContext {
  /** The user's request, used to check which numbers were actually stated. */
  request: string;
  clients: DraftClient[];
  /** Client selected in the form; validated against `clients` by the caller. */
  selectedClientId: number | null;
  today: string; // YYYY-MM-DD
  /** Dates the user set by hand in the form; used before app defaults. */
  formDates?: { issueDate?: string | null; dueDate?: string | null };
}

const nullable = <T extends object>(schema: T) => ({ anyOf: [schema, { type: "null" }] });

/**
 * JSON schema the model must follow. Deliberately has no status, payment,
 * total, or client-id fields: the client is resolved server-side.
 */
export const DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions", "clientMention", "currency", "issueDate", "dueDate", "paymentTermsDays", "lineItems", "assumptions"],
  properties: {
    questions: {
      type: "array",
      items: { type: "string" },
      description: "questions about missing information other than a line item's quantity or rate; usually empty",
    },
    clientMention: {
      ...nullable({ type: "string" }),
      description: "client or company name exactly as written in the request, or null if not named",
    },
    currency: { ...nullable({ type: "string", enum: [...VALID_CURRENCIES] }), description: "only if stated or implied by a symbol" },
    issueDate: { ...nullable({ type: "string" }), description: "YYYY-MM-DD only if the request states it" },
    dueDate: { ...nullable({ type: "string" }), description: "YYYY-MM-DD only if the request states it" },
    paymentTermsDays: { ...nullable({ type: "integer" }), description: "days, only if the request states payment terms" },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "quantity", "unit", "rate"],
        properties: {
          description: { type: "string" },
          quantity: { ...nullable({ type: "number" }), description: "units exactly as stated, or null if not stated" },
          unit: { type: "string", enum: [...LINE_UNITS], description: "what the quantity counts; fixed = one fixed price" },
          rate: { ...nullable({ type: "number" }), description: "price per unit exactly as stated, or null if not stated" },
        },
      },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "anything interpreted that the user should check",
    },
  },
} as const;

const TOP_LEVEL_KEYS = new Set<string>(DRAFT_JSON_SCHEMA.required);
const LINE_ITEM_KEYS = new Set<string>(DRAFT_JSON_SCHEMA.properties.lineItems.items.required);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Converts a number with at most 2 decimals to an integer scaled by 100; null if invalid. */
function toHundredths(v: unknown, decimals: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const scaled = Math.round(v * 100);
  if (Math.abs(v * 100 - scaled) > 1e-6) return null; // more than 2 decimals
  if (decimals === 0 && scaled % 100 !== 0) return null;
  return scaled;
}

function cleanStrings(list: unknown[], max: number): string[] {
  return list.map((s) => String(s).trim().slice(0, 300)).filter(Boolean).slice(0, max);
}

// ── What the user actually said ───────────────────────────────────────────

const WORD_NUMBERS: Record<string, number> = {
  half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, dozen: 12,
};
const WORD_NUMBER_PATTERN = Object.keys(WORD_NUMBERS).join("|");

/** Every number written in the request ("1,200.50", "2k", "three"), scaled by 100. */
export function extractStatedNumbers(request: string): Set<number> {
  const found = new Set<number>();
  for (const m of request.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*k\b)?/gi)) {
    const value = parseFloat(m[1].replace(/,/g, "") + (m[2] ?? "")) * (m[3] ? 1000 : 1);
    if (Number.isFinite(value)) found.add(Math.round(value * 100));
  }
  for (const m of request.toLowerCase().matchAll(new RegExp(`\\b(${WORD_NUMBER_PATTERN})\\b`, "g"))) {
    found.add(Math.round(WORD_NUMBERS[m[1]] * 100));
  }
  return found;
}

const COUNT = `(?:\\d+(?:\\.\\d+)?|a|an|${WORD_NUMBER_PATTERN}|several|a few|few)`;
const DURATION_IN_DAYS = new RegExp(`\\b${COUNT}\\s*(?:full\\s+|working\\s+|work\\s+|business\\s+)?(?:days?|weeks?|months?)\\b`, "i");
const HOURLY_RATE = /\bper\s+(?:hour|hr)\b|\b(?:an|a|each)\s+hour\b|\/\s*(?:hour|hr|h)\b|\bhourly\b|\bp\/?h\b/i;
const HOURS_STATED = new RegExp(`\\b(?:\\d+(?:\\.\\d+)?|${WORD_NUMBER_PATTERN})[\\s-]*(?:billable\\s+)?(?:hours?|hrs?|h)\\b(?!\\s*rate)`, "i");

/**
 * Deterministic check for missing financially significant details, run
 * before the AI is called. Returns clarification questions (empty = OK).
 *
 * An hourly rate with work described in days/weeks/months but no hours is
 * ambiguous: the app never assumes a working day is 8 billable hours.
 */
export function findMissingDetails(request: string): string[] {
  const questions: string[] = [];
  if (HOURLY_RATE.test(request) && DURATION_IN_DAYS.test(request) && !HOURS_STATED.test(request)) {
    questions.push(
      "Your rate is per hour, but the work is described in days, weeks, or months. How many billable hours were worked in total (or per day)? ClearCollect does not assume a number of hours per day."
    );
  }
  return questions;
}

// ── Client resolution ─────────────────────────────────────────────────────

function normalizeName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function clientLabel(c: DraftClient): string {
  return c.company ? `${c.name} (${c.company})` : c.name;
}

/**
 * Resolves the client for a draft against database records only.
 * - No client named in the request → the selected client (default).
 * - A name that matches exactly one client → that client, with a notice if
 *   it differs from the selection (the user asked for it explicitly).
 * - No match or several matches → no client and a notice asking the user
 *   to choose; never a guess.
 */
export function resolveDraftClient(
  mention: string | null,
  selectedClientId: number | null,
  clients: DraftClient[]
): { clientId: number | null; clientNotice: string | null } {
  const selected = clients.find((c) => c.id === selectedClientId) ?? null;
  const wanted = mention ? normalizeName(mention) : "";
  if (!wanted) {
    return selected
      ? { clientId: selected.id, clientNotice: null }
      : { clientId: null, clientNotice: "No client is selected. Choose the client before saving." };
  }

  const names = (c: DraftClient) => [c.name, c.company].filter((n): n is string => Boolean(n)).map(normalizeName);
  const contains = (outer: string, inner: string) => inner.length >= 3 && ` ${outer} `.includes(` ${inner} `);
  let matches = clients.filter((c) => names(c).includes(wanted));
  if (matches.length === 0) {
    matches = clients.filter((c) => names(c).some((n) => contains(n, wanted) || contains(wanted, n)));
  }

  if (selected && matches.some((c) => c.id === selected.id)) return { clientId: selected.id, clientNotice: null };

  const shown = (mention ?? "").trim().slice(0, 80);
  if (matches.length === 1) {
    const [match] = matches;
    return {
      clientId: match.id,
      clientNotice: selected
        ? `Your request names “${shown}”, so the client was changed from ${clientLabel(selected)} to ${clientLabel(match)}. Check this before saving.`
        : `Client set to ${clientLabel(match)} because your request names “${shown}”.`,
    };
  }
  if (matches.length === 0) {
    return {
      clientId: null,
      clientNotice: `Your request mentions “${shown}”, but no saved client matches. Select the correct client (or add it on the Clients page) before saving.`,
    };
  }
  return {
    clientId: null,
    clientNotice: `“${shown}” matches more than one client (${matches.slice(0, 5).map(clientLabel).join(", ")}). Select the correct client before saving.`,
  };
}

// ── Field questions ───────────────────────────────────────────────────────

const UNIT_WORDS: Record<LineUnit, { one: string; many: string; rate: string }> = {
  hour: { one: "hour", many: "hours", rate: "hourly rate" },
  day: { one: "day", many: "days", rate: "daily rate" },
  week: { one: "week", many: "weeks", rate: "weekly rate" },
  month: { one: "month", many: "months", rate: "monthly rate" },
  item: { one: "item", many: "items", rate: "price per item" },
  fixed: { one: "fixed price", many: "fixed prices", rate: "fixed price" },
};

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

/**
 * One explicit question for one missing field, naming the item, the unit,
 * and the currency, e.g. "Frontend: 3 hours at what hourly rate (USD/hour)?"
 */
function fieldQuestion(
  index: number,
  field: "quantity" | "rate",
  description: string,
  unit: LineUnit,
  known: { quantity: number | null; rate: number | null },
  currency: string
): ClarifyQuestion {
  const words = UNIT_WORDS[unit];
  const label = description.slice(0, 80);
  const id = `lineItems[${index}].${field}`;
  if (field === "rate") {
    if (unit === "fixed") return { id, field, text: `${label}: what is the fixed price (${currency})?` };
    const count = known.quantity === null ? "" : ` ${formatNumber(known.quantity)} ${known.quantity === 1 ? words.one : words.many}`;
    return { id, field, text: `${label}:${count} at what ${words.rate} (${currency}/${words.one})?` };
  }
  const at = known.rate === null ? "" : ` at ${formatNumber(known.rate)} ${currency}/${words.one}`;
  return { id, field, text: `${label}: how many ${words.many}${at}?` };
}

// ── Validation ────────────────────────────────────────────────────────────

export function validateInvoiceDraft(raw: unknown, ctx: DraftContext): ValidationResult<DraftOutcome> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ field: "draft", message: "Draft must be a JSON object" }] };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push({ field: key, message: "Unexpected field in AI draft" });
  }
  if (!Array.isArray(raw.questions) || !raw.questions.every((q) => typeof q === "string")) {
    errors.push({ field: "questions", message: "questions must be a list of strings" });
  }
  if (!Array.isArray(raw.assumptions) || !raw.assumptions.every((a) => typeof a === "string")) {
    errors.push({ field: "assumptions", message: "assumptions must be a list of strings" });
  }
  if (raw.clientMention !== null && typeof raw.clientMention !== "string") {
    errors.push({ field: "clientMention", message: "clientMention must be a string or null" });
  }
  if (errors.length > 0) return { ok: false, errors };

  // Missing details: ask instead of drafting with invented numbers.
  const questions = cleanStrings(raw.questions as unknown[], MAX_QUESTIONS);
  if (questions.length > 0) return { ok: true, data: generalClarification(questions) };
  if (!Array.isArray(raw.lineItems) || raw.lineItems.length === 0) {
    return { ok: true, data: generalClarification(["What work should be invoiced, and at what quantity and rate (or fixed price)?"]) };
  }

  const assumptions = cleanStrings(raw.assumptions as unknown[], 10);
  const { clientId, clientNotice } = resolveDraftClient(raw.clientMention as string | null, ctx.selectedClientId, ctx.clients);

  let currency = DEFAULT_CURRENCY;
  let currencySource: InvoiceDraft["currencySource"] = "default";
  if (raw.currency !== null) {
    currency = typeof raw.currency === "string" ? raw.currency.toUpperCase() : "";
    currencySource = "request";
    if (!VALID_CURRENCIES.has(currency)) errors.push({ field: "currency", message: "Unsupported currency" });
  } else {
    assumptions.push(`No currency was stated, so the app default ${DEFAULT_CURRENCY} is used.`);
  }

  // Dates: stated in the request > set by hand in the form > app default.
  // A default never replaces a date the user gave.
  if (raw.issueDate !== null && !isIsoDate(raw.issueDate)) errors.push({ field: "issueDate", message: "issueDate must be YYYY-MM-DD or null" });
  if (raw.dueDate !== null && !isIsoDate(raw.dueDate)) errors.push({ field: "dueDate", message: "dueDate must be YYYY-MM-DD or null" });
  const terms = raw.paymentTermsDays;
  if (terms !== null && (typeof terms !== "number" || !Number.isInteger(terms) || terms < 1 || terms > MAX_PAYMENT_TERMS_DAYS)) {
    errors.push({ field: "paymentTermsDays", message: `paymentTermsDays must be 1–${MAX_PAYMENT_TERMS_DAYS} or null` });
  }
  const form = ctx.formDates ?? {};
  const [issueDate, issueDateSource]: [string, DateSource] = isIsoDate(raw.issueDate)
    ? [raw.issueDate, "request"]
    : isIsoDate(form.issueDate) ? [form.issueDate, "form"] : [ctx.today, "default"];
  const [dueDate, dueDateSource]: [string, DateSource] = isIsoDate(raw.dueDate)
    ? [raw.dueDate, "request"]
    : typeof terms === "number" && Number.isInteger(terms) && terms >= 1 && terms <= MAX_PAYMENT_TERMS_DAYS
      ? [addDays(issueDate, terms), "payment_terms"]
      : isIsoDate(form.dueDate) ? [form.dueDate, "form"] : [addDays(issueDate, DEFAULT_DUE_DAYS), "default"];

  const stated = extractStatedNumbers(ctx.request);
  const confirmations: string[] = [];
  const lineItems: DraftLineItem[] = [];
  // Quantities or rates the model left null: asked for one by one.
  const missing: ClarifyQuestion[] = [];
  let totalCents = 0;
  if (raw.lineItems.length > MAX_LINE_ITEMS) {
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
        if (!LINE_ITEM_KEYS.has(key)) errors.push({ field: `${field}.${key}`, message: "Unexpected field in line item" });
      }
      const description = typeof item.description === "string" ? item.description.trim() : "";
      if (!description || description.length > 200) {
        errors.push({ field: `${field}.description`, message: "Description must be 1–200 characters" });
      }
      const unit: LineUnit = item.unit === undefined ? "item" : (item.unit as LineUnit);
      if (!LINE_UNITS.includes(unit)) errors.push({ field: `${field}.unit`, message: `unit must be one of: ${LINE_UNITS.join(", ")}` });
      // A fixed price is one unit by definition; nothing else is filled in.
      const rawQty = item.quantity === null && unit === "fixed" ? 1 : item.quantity;
      const qty = rawQty === null ? null : toHundredths(rawQty, 2);
      if (rawQty !== null && (qty === null || qty > 100_000_00)) {
        errors.push({ field: `${field}.quantity`, message: "Quantity must be positive with at most 2 decimals" });
      }
      const rateCents = item.rate === null ? null : toHundredths(item.rate, rateDecimals);
      if (item.rate !== null && rateCents === null) {
        errors.push({
          field: `${field}.rate`,
          message: rateDecimals === 0 ? `${currency} rates must be whole numbers` : "Rate must be positive with at most 2 decimals",
        });
      }
      if (description && LINE_UNITS.includes(unit)) {
        const known = { quantity: rawQty === null ? null : (qty ?? 0) / 100, rate: item.rate === null ? null : (rateCents ?? 0) / 100 };
        if (known.quantity === null) missing.push(fieldQuestion(i, "quantity", description, unit, known, currency));
        if (known.rate === null) missing.push(fieldQuestion(i, "rate", description, unit, known, currency));
      }
      if (qty !== null && rateCents !== null && description) {
        const amountCents = Math.round((qty * rateCents) / 100);
        totalCents += amountCents;
        // A quantity of 1 is a fixed fee; every other number must come from the user.
        const unstated = [
          ...(qty !== 100 && !stated.has(qty) ? [`quantity ${qty / 100}`] : []),
          ...(!stated.has(rateCents) ? [`rate ${(rateCents / 100).toFixed(rateDecimals)}`] : []),
        ];
        if (unstated.length > 0) {
          confirmations.push(`“${description.slice(0, 80)}”: ${unstated.join(" and ")} ${unstated.length > 1 ? "were" : "was"} not stated in your request.`);
        }
        lineItems.push({
          description,
          quantity: qty / 100,
          unit,
          rate: rateCents / 100,
          amount: amountCents / 100,
          needsConfirmation: unstated.length > 0,
        });
      }
    });
  }

  if (totalCents > MAX_AMOUNT_CENTS) errors.push({ field: "total", message: "Total exceeds maximum (99,999,999.99)" });
  if (ZERO_DECIMAL_CURRENCIES.has(currency) && totalCents % 100 !== 0) {
    errors.push({ field: "total", message: `${currency} totals must be whole numbers` });
  }
  if (errors.length > 0) return { ok: false, errors };

  // Missing quantities/rates: one question per field, never a guess.
  if (missing.length > 0) {
    const notes =
      currencySource === "default"
        ? [`No currency was stated, so amounts are read as ${DEFAULT_CURRENCY} (the app default). Write another currency (e.g. € or EUR) in your answers to use it instead.`]
        : [];
    return { ok: true, data: { kind: "clarification", questions: missing, pending: raw, notes } };
  }

  // Contradictory dates are the user's call, never silently replaced.
  if (dueDate <= issueDate) {
    return {
      ok: true,
      data: generalClarification([
        `The due date (${dueDate}) is not after the issue date (${issueDate}). Which issue and due dates should the invoice use?`,
      ]),
    };
  }

  // Final check with the same rules the invoice API applies on save.
  const check = validateCreateInvoice({
    invoiceNumber: "DRAFT-CHECK",
    clientId: clientId ?? 1,
    description: lineItems.map((l) => l.description).join("; "),
    amount: totalCents / 100,
    currency,
    issueDate,
    dueDate,
  });
  if (!check.ok) return check;

  return {
    ok: true,
    data: {
      kind: "draft",
      clientId,
      clientNotice,
      currency,
      currencySource,
      issueDate,
      issueDateSource,
      dueDate,
      dueDateSource,
      lineItems,
      total: totalCents / 100,
      assumptions,
      confirmations,
    },
  };
}

// ── Clarification answers ─────────────────────────────────────────────────
// Answers to field questions are matched by question id (never by position)
// and parsed deterministically: no second AI call, and nothing is guessed.
// Each answer must contain exactly one exact, positive number; a different
// time unit, another item's name, or a conflicting currency sends that one
// question back with the reason. Accepted answers are kept.

const MAX_ANSWERS = 50;
const MAX_ANSWER_LENGTH = 200;
const DOLLAR_CURRENCIES = new Set(["USD", "CAD", "AUD", "SGD"]);

/** Matches whole words, including when glued to a number ("6dollars"). */
const words = (pattern: string) => new RegExp(`(?:^|[^\\p{L}])(?:${pattern})(?![\\p{L}])`, "iu");

const CURRENCY_MARKERS: [string, RegExp][] = [
  ["$", /\$|(?:^|[^\p{L}])(?:dollars?|bucks)(?![\p{L}])/iu], // resolved against the invoice currency
  ["USD", words("usd")],
  ["CAD", words("cad")],
  ["AUD", words("aud")],
  ["SGD", words("sgd")],
  ["EUR", /€|(?:^|[^\p{L}])(?:eur|euros?)(?![\p{L}])/iu],
  ["GBP", /£|(?:^|[^\p{L}])(?:gbp|pounds?)(?![\p{L}])/iu],
  ["INR", /₹|(?:^|[^\p{L}])(?:inr|rupees?|rs)(?![\p{L}])/iu],
  ["JPY", /¥|(?:^|[^\p{L}])(?:jpy|yen)(?![\p{L}])/iu],
  ["AED", words("aed|dirhams?")],
];

const TIME_UNIT_MARKERS: [LineUnit, RegExp][] = [
  ["hour", words("hours?|hrs?|h|hourly")],
  ["day", words("days?|daily")],
  ["week", words("weeks?|weekly")],
  ["month", words("months?|monthly")],
];

const UNCLEAR_ANSWER = new RegExp(
  `[~?]|${words("about|around|approx|approximately|roughly|maybe|perhaps|probably|ish|or so|unsure|not sure|unknown|tbd|idk|same").source}`,
  "iu"
);

function numbersIn(text: string): number[] {
  const values: number[] = [];
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*k(?![\p{L}]))?/giu)) {
    values.push(parseFloat(m[1].replace(/,/g, "") + (m[2] ?? "")) * (m[3] ? 1000 : 1));
  }
  for (const m of text.toLowerCase().matchAll(new RegExp(`\\b(${WORD_NUMBER_PATTERN})\\b`, "g"))) {
    values.push(WORD_NUMBERS[m[1]]);
  }
  return [...new Set(values)];
}

export type ParsedAnswer = { ok: true; value: number; currency: string | null } | { ok: false; problem: string };

/** Reads one answer for one field question. Never splits or reorders values. */
export function parseClarificationAnswer(
  answer: string,
  q: {
    field: "quantity" | "rate";
    unit: LineUnit;
    description: string;
    otherDescriptions: string[];
    /** Currency stated in the request, or null if none was. */
    currency: string | null;
  }
): ParsedAnswer {
  const text = answer.trim();
  const unitWords = UNIT_WORDS[q.unit];
  const what = q.field === "rate" ? unitWords.rate : `number of ${unitWords.many}`;
  const target = `${what} for “${q.description.slice(0, 80)}”`;
  const shown = `“${text.slice(0, 60)}”`;
  const fail = (problem: string): ParsedAnswer => ({ ok: false, problem });

  if (!text) return fail(`No answer was given. Enter the ${target}.`);
  if (text.length > MAX_ANSWER_LENGTH) return fail(`Keep the answer short: just the ${target}.`);

  const own = normalizeName(q.description);
  const padded = ` ${normalizeName(text)} `;
  const other = q.otherDescriptions.find((d) => {
    const name = normalizeName(d);
    return name.length >= 3 && !own.includes(name) && padded.includes(` ${name} `);
  });
  if (other) return fail(`This answer mentions “${other.slice(0, 80)}”. Enter only the ${target} here; each item has its own answer box.`);

  if (UNCLEAR_ANSWER.test(text)) return fail(`${shown} is not an exact value. Enter the exact ${target}.`);
  if (/(?:^|[^\d.])[-−]\s*\d/.test(text)) return fail(`Enter a ${what} greater than 0.`);

  const values = numbersIn(text);
  if (values.length === 0) return fail(`No number was found in ${shown}. Enter the ${target} as a number.`);
  if (values.length > 1) {
    return fail(`${shown} contains more than one number (${values.map(formatNumber).join(", ")}). Enter only the ${target}; each item has its own answer box.`);
  }
  const [value] = values;
  if (!(value > 0)) return fail(`Enter a ${what} greater than 0.`);
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) return fail("Use at most 2 decimal places.");

  const otherUnit = TIME_UNIT_MARKERS.find(([unit, re]) => unit !== q.unit && re.test(text))?.[0];
  if (otherUnit) {
    return fail(
      q.field === "quantity"
        ? `This asks for ${unitWords.many}, but the answer is in ${UNIT_WORDS[otherUnit].many}. Enter the number of ${unitWords.many}; units are not converted.`
        : `This asks for the ${unitWords.rate}${q.unit === "fixed" || q.unit === "item" ? "" : ` per ${unitWords.one}`}, but the answer is per ${UNIT_WORDS[otherUnit].one}. Rates are not converted.`
    );
  }

  const currencies = [
    ...new Set(
      CURRENCY_MARKERS.filter(([, re]) => re.test(text)).map(([code]) =>
        code === "$" ? (q.currency && DOLLAR_CURRENCIES.has(q.currency) ? q.currency : "USD") : code
      )
    ),
  ];
  if (q.field === "quantity" && currencies.length > 0) return fail(`This asks for the ${target}, not an amount of money.`);
  if (currencies.length > 1) return fail(`The answer mentions more than one currency (${currencies.join(", ")}).`);
  const currency = currencies[0] ?? null;
  if (currency && q.currency && currency !== q.currency) {
    return fail(`This invoice is in ${q.currency}, but the answer is in ${currency}. Enter the amount in ${q.currency}; currencies are not converted.`);
  }
  if (q.field === "rate" && (currency ?? q.currency) === "JPY" && !Number.isInteger(value)) return fail("JPY amounts must be whole numbers.");
  return { ok: true, value, currency };
}

export interface ClarificationInput {
  pending: Record<string, unknown>;
  answers: ClarifyAnswer[];
  /** Text of answers from earlier rounds, so their numbers count as stated. */
  earlierAnswers: string[];
}

/** Shape check for the `clarification` field of the draft API body. */
export function parseClarificationInput(value: unknown): ValidationResult<ClarificationInput | null> {
  if (value === undefined || value === null) return { ok: true, data: null };
  const bad = (message: string): ValidationResult<never> => ({ ok: false, errors: [{ field: "clarification", message }] });
  if (!isPlainObject(value) || !isPlainObject(value.pending)) return bad("clarification.pending must be an object");
  const { answers, earlierAnswers = [] } = value;
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_ANSWERS) {
    return bad(`clarification.answers must list 1–${MAX_ANSWERS} answers`);
  }
  for (const a of answers) {
    if (!isPlainObject(a) || typeof a.id !== "string" || a.id.length > 40 || typeof a.answer !== "string" || a.answer.length > 500) {
      return bad("each answer needs an id and an answer of at most 500 characters");
    }
  }
  if (!Array.isArray(earlierAnswers) || earlierAnswers.length > 200 || !earlierAnswers.every((a) => typeof a === "string" && a.length <= 500)) {
    return bad("clarification.earlierAnswers must be a list of short strings");
  }
  return {
    ok: true,
    data: {
      pending: value.pending,
      answers: answers.map((a) => ({ id: a.id as string, answer: a.answer as string })),
      earlierAnswers: earlierAnswers as string[],
    },
  };
}

function locate(id: string): { index: number; field: "quantity" | "rate" } {
  const m = /^lineItems\[(\d+)\]\.(quantity|rate)$/.exec(id)!;
  return { index: Number(m[1]), field: m[2] as "quantity" | "rate" };
}

/**
 * Applies answers to the pending draft's missing fields. The pending draft
 * comes back from the browser, so it is fully re-validated first and the
 * answers must match its open questions exactly. Returns a draft when every
 * field is answered, otherwise the remaining questions with reasons.
 */
export function resolveClarification(input: ClarificationInput, ctx: DraftContext): ValidationResult<DraftOutcome> {
  const stale: ValidationResult<never> = {
    ok: false,
    errors: [{ field: "clarification", message: "These answers no longer match the draft. Generate the draft again." }],
  };
  const initial = validateInvoiceDraft(input.pending, ctx);
  if (!initial.ok) return initial;
  if (initial.data.kind !== "clarification" || !initial.data.pending || initial.data.questions.some((q) => q.field === null)) {
    return stale;
  }

  const asked = new Set(initial.data.questions.map((q) => q.id));
  const answers = new Map<string, string>();
  for (const a of input.answers) {
    if (!asked.has(a.id) || answers.has(a.id)) return stale;
    answers.set(a.id, a.answer);
  }

  const draft = structuredClone(initial.data.pending) as Record<string, unknown> & { lineItems: Record<string, unknown>[] };
  const statedCurrency = typeof draft.currency === "string" ? draft.currency.toUpperCase() : null;
  const descriptions = draft.lineItems.map((item) => String(item.description).trim());
  const problems = new Map<string, string>();
  const namedCurrency = new Map<string, string>();

  for (const id of asked) {
    const { index, field } = locate(id);
    const item = draft.lineItems[index];
    const parsed = parseClarificationAnswer(answers.get(id) ?? "", {
      field,
      unit: (item.unit ?? "item") as LineUnit,
      description: descriptions[index],
      otherDescriptions: descriptions.filter((_, j) => j !== index),
      currency: statedCurrency,
    });
    if (!parsed.ok) {
      problems.set(id, parsed.problem);
      continue;
    }
    item[field] = parsed.value;
    if (parsed.currency) namedCurrency.set(id, parsed.currency);
  }

  // With no currency in the request, answers may name one — but only one.
  const named = new Set(namedCurrency.values());
  if (!statedCurrency && named.size > 1) {
    for (const id of namedCurrency.keys()) {
      const { index, field } = locate(id);
      draft.lineItems[index][field] = null;
      problems.set(id, `Your answers use more than one currency (${[...named].join(", ")}). Use one currency for the whole invoice.`);
    }
  } else if (!statedCurrency && named.size === 1) {
    draft.currency = [...named][0];
  }

  const answered = [...input.earlierAnswers, ...answers.values()].join("\n");
  const next = validateInvoiceDraft(draft, { ...ctx, request: `${ctx.request}\n${answered}` });
  if (!next.ok || next.data.kind === "draft") return next;
  return {
    ok: true,
    data: {
      ...next.data,
      questions: next.data.questions.map((q) =>
        problems.has(q.id) ? { ...q, problem: problems.get(q.id), previousAnswer: answers.get(q.id) } : q
      ),
    },
  };
}

/**
 * Appends answers to general questions as explicit question/answer pairs,
 * so a regenerated draft never has to match answers to questions by order.
 */
export function appendGeneralAnswers(request: string, pairs: { question: string; answer: string }[]): string {
  const lines = pairs.map((p) => `- Question: ${p.question.trim()}\n  Answer: ${p.answer.trim()}`);
  return `${request.trim()}\n\nClarifications (each answer belongs to the question directly above it):\n${lines.join("\n")}`;
}
