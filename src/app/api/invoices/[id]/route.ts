/**
 * GET    /api/invoices/[id]  — fetch a single invoice with client details
 * PATCH  /api/invoices/[id]  — update allowed fields (description, amount, currency, dueDate, status)
 * DELETE /api/invoices/[id]  — delete an invoice (only DRAFT or CANCELLED invoices may be deleted)
 *
 * Security note: PAID status cannot be set via PATCH.
 * Status may only be set to PAID by the verified PayPal capture flow (src/lib/paypal.ts).
 */

import { prisma } from "@/lib/prisma";
import {
  validateUpdateInvoice,
  validationErrorResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/validation";
import { InvoiceStatus } from "@/generated/prisma/enums";

// Helper: parse and validate the [id] route segment
function parseId(ctx: RouteContext<"/api/invoices/[id]">): Promise<number | null> {
  return ctx.params.then(({ id }) => {
    const parsed = parseInt(id, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  });
}

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/invoices/[id]">
): Promise<Response> {
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
  const id = await parseId(ctx);
  if (id === null) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, errors: [{ field: "body", message: "Request body must be valid JSON" }] },
      { status: 400 }
    );
  }

  const result = validateUpdateInvoice(body);
  if (!result.ok) return validationErrorResponse(result.errors);

  try {
    // Fetch current invoice to enforce transition rules
    const existing = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) return notFoundResponse(`Invoice ${id} not found`);

    // Prevent editing a PAID or CANCELLED invoice (other than re-opening a CANCELLED)
    if (existing.status === InvoiceStatus.PAID) {
      return Response.json(
        { ok: false, error: "A PAID invoice cannot be modified" },
        { status: 409 }
      );
    }

    const { amount, ...rest } = result.data;

    const updated = await prisma.invoice.update({
      where: { id },
      data: {
        ...rest,
        ...(amount !== undefined ? { amount: amount.toFixed(2) } : {}),
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
  _request: Request,
  ctx: RouteContext<"/api/invoices/[id]">
): Promise<Response> {
  const id = await parseId(ctx);
  if (id === null) {
    return Response.json({ ok: false, error: "id must be a positive integer" }, { status: 400 });
  }

  try {
    const existing = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) return notFoundResponse(`Invoice ${id} not found`);

    // Only DRAFT or CANCELLED invoices may be deleted
    const deletableStatuses: InvoiceStatus[] = [InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED];
    if (!deletableStatuses.includes(existing.status as InvoiceStatus)) {
      return Response.json(
        {
          ok: false,
          error: `Only DRAFT or CANCELLED invoices can be deleted. This invoice is ${existing.status}.`,
        },
        { status: 409 }
      );
    }

    await prisma.invoice.delete({ where: { id } });
    return Response.json({ ok: true, message: `Invoice ${id} deleted` });
  } catch (err) {
    console.error(`[DELETE /api/invoices/${id}]`, err);
    return serverErrorResponse();
  }
}
