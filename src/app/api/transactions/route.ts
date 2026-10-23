/**
 * GET /api/transactions — verified successful payments (PAID invoices), newest
 * first, with optional ?page= and ?limit= (max 100). Read-only.
 */

import type { NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth";
import { listTransactions } from "@/lib/transactions";
import { serverErrorResponse } from "@/lib/validation";

export async function GET(request: NextRequest): Promise<Response> {
  const denied = await requireOwner(request);
  if (denied) return denied;

  const { searchParams } = request.nextUrl;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10) || 50, 100);
  const page = Math.max(parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);

  try {
    return Response.json({ ok: true, ...(await listTransactions({ page, limit })) });
  } catch (err) {
    console.error("[GET /api/transactions]", err);
    return serverErrorResponse();
  }
}
