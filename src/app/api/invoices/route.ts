/**
 * GET  /api/invoices        — list invoices (with optional ?status= and ?clientId= filters)
 * POST /api/invoices        — create a new invoice (invoiceNumber optional: omitted/blank
 *                               assigns the next INV-YYYY-NNN number for the issue year)
 *
 * Security note: PAID status cannot be set via this endpoint.
 * Invoice status may only be set to PAID by a verified payment webhook.
 */

import { requireOwner } from "@/lib/auth";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJsonBody } from "@/lib/request";
import { InvoiceStatus } from "@/generated/prisma/enums";
import {
  validateCreateInvoice,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/validation";
import {
  InvoiceNumberExhaustedError,
  createWithInvoiceNumber,
  isInvoiceNumberConflict,
} from "@/lib/invoice-number";

const VALID_STATUSES = new Set(Object.values(InvoiceStatus));

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  try {
    const { searchParams } = request.nextUrl;

    // Optional filters
    const rawStatus = searchParams.get("status");
    const rawClientId = searchParams.get("clientId");
    const rawLimit = searchParams.get("limit");
    const rawPage = searchParams.get("page");

    // Validate status filter
    if (rawStatus && !VALID_STATUSES.has(rawStatus as InvoiceStatus)) {
      return Response.json(
        {
          ok: false,
          errors: [
            {
              field: "status",
              message: `status filter must be one of: ${[...VALID_STATUSES].join(", ")}`,
            },
          ],
        },
        { status: 400 }
      );
    }

    const clientId = rawClientId ? parseInt(rawClientId, 10) : undefined;
    if (rawClientId && (isNaN(clientId!) || clientId! < 1)) {
      return Response.json(
        { ok: false, errors: [{ field: "clientId", message: "clientId must be a positive integer" }] },
        { status: 400 }
      );
    }

    // Pagination (max 100 per page)
    const limit = Math.min(parseInt(rawLimit ?? "50", 10) || 50, 100);
    const page = Math.max(parseInt(rawPage ?? "1", 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {
      ...(rawStatus ? { status: rawStatus as InvoiceStatus } : {}),
      ...(clientId ? { clientId } : {}),
    };

    const [invoices, total] = await prisma.$transaction([
      prisma.invoice.findMany({
        where,
        orderBy: { dueDate: "asc" },
        take: limit,
        skip,
        include: {
          client: { select: { id: true, name: true, email: true, company: true } },
        },
      }),
      prisma.invoice.count({ where }),
    ]);

    return Response.json({
      ok: true,
      data: invoices,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("[GET /api/invoices]", err);
    return serverErrorResponse();
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const result = validateCreateInvoice(body);
  if (!result.ok) return validationErrorResponse(result.errors);

  const { amount, invoiceNumber, ...rest } = result.data;

  try {
    // Verify the referenced client exists before creating the invoice
    const client = await prisma.client.findUnique({
      where: { id: rest.clientId },
      select: { id: true },
    });
    if (!client) {
      return Response.json(
        { ok: false, errors: [{ field: "clientId", message: `No client found with id ${rest.clientId}` }] },
        { status: 422 }
      );
    }

    const create = (number: string) =>
      prisma.invoice.create({
        data: {
          ...rest,
          invoiceNumber: number,
          // Convert to string for Prisma's Decimal field — avoids floating point drift
          amount: amount.toFixed(2),
        },
        include: {
          client: { select: { id: true, name: true, email: true } },
        },
      });

    const invoice = invoiceNumber
      ? await create(invoiceNumber)
      : await createWithInvoiceNumber(rest.issueDate.getUTCFullYear(), create);
    return Response.json({ ok: true, data: invoice }, { status: 201 });
  } catch (err: unknown) {
    if (err instanceof InvoiceNumberExhaustedError) {
      return Response.json(
        { ok: false, errors: [{ field: "invoiceNumber", message: err.message }] },
        { status: 409 }
      );
    }
    // Unique constraint on a user-supplied invoiceNumber
    if (isInvoiceNumberConflict(err)) {
      return Response.json(
        {
          ok: false,
          errors: [{ field: "invoiceNumber", message: "An invoice with this number already exists" }],
        },
        { status: 409 }
      );
    }
    console.error("[POST /api/invoices]", err);
    return serverErrorResponse();
  }
}
