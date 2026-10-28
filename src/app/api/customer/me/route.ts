/**
 * GET /api/customer/me — the signed-in customer's name, email, and linked
 * client display name (null until an invite is redeemed).
 */

import { requireCustomer } from "@/lib/customer-auth";
import { prisma } from "@/lib/prisma";
import { serverErrorResponse } from "@/lib/validation";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireCustomer(request);
  if ("response" in auth) return auth.response;
  try {
    const { customer } = auth;
    const client = customer.clientId
      ? await prisma.client.findUnique({ where: { id: customer.clientId }, select: { name: true, company: true } })
      : null;
    return Response.json(
      { ok: true, data: { name: customer.name, email: customer.email, client: client ? { name: client.name, company: client.company } : null } },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    console.error("[GET /api/customer/me]", err);
    return serverErrorResponse();
  }
}
