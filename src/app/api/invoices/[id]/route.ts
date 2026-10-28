/**
 * GET    /api/invoices/[id]  — fetch a single invoice with client details
 * PATCH  /api/invoices/[id]  — update allowed fields (description, amount, currency, dueDate, status)
 * DELETE /api/invoices/[id]  — delete a DRAFT invoice with no payment, email, or reminder history
 *                             (see src/lib/invoice-deletion.ts; checked atomically on the server)
 *
 * Security note: PAID status cannot be set via PATCH.
 * Status may only be set to PAID by the verified PayPal capture flow (src/lib/paypal.ts).
 */

import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { readJsonBody, rejectCrossSite } from "@/lib/request";
import {
  validateUpdateInvoice,
  validationErrorResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/validation";
import { InvoiceStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { isSendInProgress } from "@/lib/invoice-email";
import { InvoiceDeletionError, deleteDraftInvoice } from "@/lib/invoice-deletion";

const SEND_IN_PROGRESS = "This invoice is being emailed right now; try again in a moment";

// Helper: parse and validate the [id] route segment
function parseId(ctx: RouteContext<"/api/invoices/[id]">): Promise<number | null> {
  return ctx.params.then(({ id }) => {
    const parsed = parseInt(id, 10);
    // Digits only: "12abc" or "1.5" must not resolve to another invoice.
    return /^\d+$/.test(id) && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  });
}

export async function GET(
  request: Request,
  ctx: RouteContext<"/api/invoices/[id]">
): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const id = await parseId(ctx);
  if (id === null) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        client: { select: { id: true, name: true, email: true, company: true } },
      },
    });
    if (!invoice) return notFoundResponse(`Invoice ${id} not found`);
    return Response.json({ ok: true, data: invoice });
  } catch (err) {
    console.error(`[GET /api/invoices/${id}]`, err);
    return serverErrorResponse();
  }
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/invoices/[id]">
): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const id = await parseId(ctx);
  if (id === null) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const result = validateUpdateInvoice(body);
  if (!result.ok) return validationErrorResponse(result.errors);

  try {
    // Fetch current invoice to enforce transition rules
    const existing = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, status: true, emailState: true, emailStateAt: true },
    });
    if (!existing) return notFoundResponse(`Invoice ${id} not found`);

    // Prevent editing a PAID or CANCELLED invoice (other than re-opening a CANCELLED)
    if (existing.status === InvoiceStatus.PAID) {
      return Response.json(
        { ok: false, error: "A PAID invoice cannot be modified" },
        { status: 409 }
      );
    }

    // The email being sent was built from the current values.
    if (isSendInProgress(existing, Date.now())) {
      return Response.json({ ok: false, error: SEND_IN_PROGRESS }, { status: 409 });
    }

    const { amount, ...rest } = result.data;

    const updated = await prisma.invoice.update({
      where: { id },
      data: {
        ...rest,
        ...(amount !== undefined ? { amount: amount.toFixed(2) } : {}),
        // Stored line items describe the old amount/description; drop them so
        // an invoice email never lists items that no longer match.
        ...(amount !== undefined || rest.description !== undefined ? { lineItems: Prisma.DbNull } : {}),
        // A pending PayPal order was priced from the old amount/currency;
        // detach it so payment must start over with the new values.
        ...(amount !== undefined || rest.currency !== undefined ? { paypalOrderId: null } : {}),
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
      },
    });
    return Response.json({ ok: true, data: updated });
  } catch (err) {
    console.error(`[PATCH /api/invoices/${id}]`, err);
    return serverErrorResponse();
  }
}

export async function DELETE(
  request: Request,
  ctx: RouteContext<"/api/invoices/[id]">
): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const id = await parseId(ctx);
  if (id === null) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;

  try {
    const { invoiceNumber } = await deleteDraftInvoice(id);
    return Response.json({ ok: true, message: `${invoiceNumber} deleted`, data: { id, invoiceNumber } });
  } catch (err) {
    if (err instanceof InvoiceDeletionError) {
      return Response.json({ ok: false, error: err.message }, { status: err.status });
    }
    console.error(`[DELETE /api/invoices/${id}]`, err);
    return serverErrorResponse();
  }
}
