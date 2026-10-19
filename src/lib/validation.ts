/**
 * Server-side validation utilities for the ClearCollect API.
 *
 * All validation runs on the server. Client input is never trusted for
 * fields that affect business logic (e.g. status cannot be set to PAID
 * via a create or update call — only explicit transitions are allowed).
 */

import { InvoiceStatus } from "@/generated/prisma/enums";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ValidationError = { field: string; message: string };

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: ValidationError[] };

// ── Client validation ─────────────────────────────────────────────────────────

export interface CreateClientInput {
  name: string;
  email?: string | null;
  company?: string | null;
}

export function validateCreateClient(
  body: unknown
): ValidationResult<CreateClientInput> {
  const errors: ValidationError[] = [];

  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: [{ field: "body", message: "Invalid JSON body" }] };
  }

  const b = body as Record<string, unknown>;

  const name = b["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    errors.push({ field: "name", message: "name is required and must be a non-empty string" });
  } else if (name.trim().length > 191) {
    errors.push({ field: "name", message: "name must be 191 characters or fewer" });
  }

  const email = b["email"];
  if (email !== undefined && email !== null && email !== "") {
    if (typeof email !== "string") {
      errors.push({ field: "email", message: "email must be a string" });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ field: "email", message: "email must be a valid email address" });
    } else if (email.length > 191) {
      errors.push({ field: "email", message: "email must be 191 characters or fewer" });
    }
  }

  const company = b["company"];
  if (company !== undefined && company !== null && company !== "") {
    if (typeof company !== "string") {
      errors.push({ field: "company", message: "company must be a string" });
    } else if (company.length > 191) {
      errors.push({ field: "company", message: "company must be 191 characters or fewer" });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      name: (name as string).trim(),
      email: typeof email === "string" && email.trim() !== "" ? email.trim() : null,
      company: typeof company === "string" && company.trim() !== "" ? company.trim() : null,
    },
  };
}

// ── Invoice validation ────────────────────────────────────────────────────────

/** Statuses that a client is allowed to set when creating an invoice. */
const ALLOWED_CREATE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.SENT,
];

/** Statuses that a client is allowed to transition to when updating. */
const ALLOWED_UPDATE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.SENT,
  InvoiceStatus.OVERDUE,
  InvoiceStatus.CANCELLED,
  // PAID is intentionally excluded — only the verified PayPal capture may set PAID.
];

export const VALID_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "CAD", "AUD", "INR", "JPY", "SGD", "AED",
]);

export interface CreateInvoiceInput {
  invoiceNumber: string | null; // null = assign the next INV-YYYY-NNN number on the server
  clientId: number;
  description: string;
  amount: number; // validated positive number; stored as Decimal by Prisma
  currency: string;
  issueDate: Date;
  dueDate: Date;
  status: InvoiceStatus;
}

export function validateCreateInvoice(
  body: unknown
): ValidationResult<CreateInvoiceInput> {
  const errors: ValidationError[] = [];

  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: [{ field: "body", message: "Invalid JSON body" }] };
  }

  const b = body as Record<string, unknown>;

  // invoiceNumber — optional; omitted/blank means auto-assign
  const invoiceNumber = b["invoiceNumber"];
  const autoNumber =
    invoiceNumber === undefined ||
    invoiceNumber === null ||
    (typeof invoiceNumber === "string" && invoiceNumber.trim().length === 0);
  if (!autoNumber && typeof invoiceNumber !== "string") {
    errors.push({ field: "invoiceNumber", message: "invoiceNumber must be a string" });
  } else if (!autoNumber && (invoiceNumber as string).trim().length > 191) {
    errors.push({ field: "invoiceNumber", message: "invoiceNumber must be 191 characters or fewer" });
  }

  // clientId
  const clientId = b["clientId"];
  if (typeof clientId !== "number" || !Number.isInteger(clientId) || clientId < 1) {
    errors.push({ field: "clientId", message: "clientId must be a positive integer" });
  }

  // description
  const description = b["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push({ field: "description", message: "description is required" });
  }

  // amount
  const amount = b["amount"];
  if (typeof amount !== "number" || isNaN(amount) || amount <= 0) {
    errors.push({ field: "amount", message: "amount must be a positive number" });
  } else if (amount > 99999999.99) {
    errors.push({ field: "amount", message: "amount exceeds maximum (99,999,999.99)" });
  }

  // currency
  const currency = b["currency"];
  const currencyStr = typeof currency === "string" ? currency.toUpperCase() : "";
  if (!VALID_CURRENCIES.has(currencyStr)) {
    errors.push({
      field: "currency",
      message: `currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`,
    });
  }

  // issueDate
  const issueDate = b["issueDate"];
  const issueDateObj = issueDate ? new Date(issueDate as string) : null;
  if (!issueDateObj || isNaN(issueDateObj.getTime())) {
    errors.push({ field: "issueDate", message: "issueDate must be a valid ISO date string" });
  }

  // dueDate
  const dueDate = b["dueDate"];
  const dueDateObj = dueDate ? new Date(dueDate as string) : null;
  if (!dueDateObj || isNaN(dueDateObj.getTime())) {
    errors.push({ field: "dueDate", message: "dueDate must be a valid ISO date string" });
  } else if (issueDateObj && dueDateObj <= issueDateObj) {
    errors.push({ field: "dueDate", message: "dueDate must be after issueDate" });
  }

  // status — only safe creation statuses allowed
  const status = b["status"];
  const resolvedStatus: InvoiceStatus =
    status === undefined ? InvoiceStatus.DRAFT : (status as InvoiceStatus);
  if (!ALLOWED_CREATE_STATUSES.includes(resolvedStatus)) {
    errors.push({
      field: "status",
      message: `status must be one of: ${ALLOWED_CREATE_STATUSES.join(", ")} when creating an invoice`,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      invoiceNumber: autoNumber ? null : (invoiceNumber as string).trim(),
      clientId: clientId as number,
      description: (description as string).trim(),
      amount: amount as number,
      currency: currencyStr,
      issueDate: issueDateObj!,
      dueDate: dueDateObj!,
      status: resolvedStatus,
    },
  };
}

export interface UpdateInvoiceInput {
  description?: string;
  amount?: number;
  currency?: string;
  dueDate?: Date;
  status?: InvoiceStatus;
}

export function validateUpdateInvoice(
  body: unknown
): ValidationResult<UpdateInvoiceInput> {
  const errors: ValidationError[] = [];

  if (typeof body !== "object" || body === null) {
    return { ok: false, errors: [{ field: "body", message: "Invalid JSON body" }] };
  }

  const b = body as Record<string, unknown>;
  const data: UpdateInvoiceInput = {};

  if (b["description"] !== undefined) {
    if (typeof b["description"] !== "string" || b["description"].trim().length === 0) {
      errors.push({ field: "description", message: "description must be a non-empty string" });
    } else {
      data.description = b["description"].trim();
    }
  }

  if (b["amount"] !== undefined) {
    const amount = b["amount"];
    if (typeof amount !== "number" || isNaN(amount) || amount <= 0) {
      errors.push({ field: "amount", message: "amount must be a positive number" });
    } else if (amount > 99999999.99) {
      errors.push({ field: "amount", message: "amount exceeds maximum (99,999,999.99)" });
    } else {
      data.amount = amount;
    }
  }

  if (b["currency"] !== undefined) {
    const currencyStr = typeof b["currency"] === "string" ? b["currency"].toUpperCase() : "";
    if (!VALID_CURRENCIES.has(currencyStr)) {
      errors.push({
        field: "currency",
        message: `currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`,
      });
    } else {
      data.currency = currencyStr;
    }
  }

  if (b["dueDate"] !== undefined) {
    const dueDateObj = new Date(b["dueDate"] as string);
    if (isNaN(dueDateObj.getTime())) {
      errors.push({ field: "dueDate", message: "dueDate must be a valid ISO date string" });
    } else {
      data.dueDate = dueDateObj;
    }
  }

  if (b["status"] !== undefined) {
    const status = b["status"] as InvoiceStatus;
    if (!ALLOWED_UPDATE_STATUSES.includes(status)) {
      errors.push({
        field: "status",
        message: `status must be one of: ${ALLOWED_UPDATE_STATUSES.join(", ")} — PAID is set only by the verified PayPal checkout`,
      });
    } else {
      data.status = status;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  if (Object.keys(data).length === 0) {
    return { ok: false, errors: [{ field: "body", message: "No updatable fields provided" }] };
  }

  return { ok: true, data };
}

// ── Response helpers ──────────────────────────────────────────────────────────

export function validationErrorResponse(errors: ValidationError[]): Response {
  return Response.json({ ok: false, errors }, { status: 422 });
}

export function notFoundResponse(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 404 });
}

export function serverErrorResponse(message = "Internal server error"): Response {
  return Response.json({ ok: false, error: message }, { status: 500 });
}
