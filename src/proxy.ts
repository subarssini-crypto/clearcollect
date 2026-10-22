/**
 * Proxy: send signed-out visitors to /login and refuse unauthenticated /api
 * calls early. This is a convenience layer only — every protected route
 * handler also calls requireOwner() itself.
 *
 * Public paths:
 *   /login, /api/auth/login, /api/auth/logout
 *   /api/auth/status     — only "is sign-in configured / signed in" booleans
 *   /api/paypal/webhook  — PayPal servers; secured by signature verification
 *   /api/paypal/return   — the payer's browser; capture verified server-side
 *   /api/paypal/cancel   — redirect only, no state change
 */

import { NextResponse, type NextRequest } from "next/server";
import { isOwnerRequest, requireOwner } from "@/lib/auth";

const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/paypal/webhook",
  "/api/paypal/return",
  "/api/paypal/cancel",
]);

export async function proxy(request: NextRequest): Promise<Response> {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return (await requireOwner(request)) ?? NextResponse.next();
  }

  const signedIn = await isOwnerRequest(request);
  if (pathname === "/login") {
    return signedIn ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (signedIn) return NextResponse.next();

  const login = new URL("/login", request.url);
  if (pathname !== "/" || search) login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except build assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
