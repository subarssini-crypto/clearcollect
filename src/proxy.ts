/**
 * Proxy: route-level access control. This is a convenience layer only —
 * every protected route handler also checks its own session
 * (requireOwner() or requireCustomer()).
 *
 * Three areas, with separate sessions that never grant each other access:
 *
 * Public (no session):
 *   /                    — landing page (static, no private data)
 *   /login, /api/auth/login, /api/auth/logout
 *   /api/auth/status     — only "is sign-in configured / signed in" booleans
 *   /api/paypal/webhook  — PayPal servers; secured by signature verification
 *   /api/paypal/return   — the payer's browser; capture verified server-side
 *   /api/paypal/cancel   — redirect only, no state change
 *   /pay/<token>, /api/pay/<token>[/order] — the client's payment page; the
 *                          unguessable token is the credential (src/lib/payment-link.ts)
 *   /portal/login, /portal/signup, /portal/invite, /portal/forgot-password,
 *   /portal/reset-password, /api/customer/auth/*
 *
 * Customer Portal (customer session, src/lib/customer-auth.ts):
 *   /portal, /portal/*, /api/customer/*
 *
 * Owner (owner session, src/lib/auth.ts): everything else.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isOwnerRequest, requireOwner } from "@/lib/auth";
import { getCustomer, requireCustomer } from "@/lib/customer-auth";

const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/paypal/webhook",
  "/api/paypal/return",
  "/api/paypal/cancel",
  "/api/customer/auth/login",
  "/api/customer/auth/signup",
  "/api/customer/auth/logout",
  "/api/customer/auth/invite",
  "/api/customer/auth/forgot-password",
  "/api/customer/auth/reset-password",
]);

const PUBLIC_PAGES = new Set(["/", "/portal/login", "/portal/signup", "/portal/invite", "/portal/forgot-password", "/portal/reset-password"]);

/** /pay/<token> and /api/pay/<token>[/order]: exactly one token segment, nothing deeper. */
function isPublicPayPath(pathname: string): boolean {
  return /^\/pay\/[^/]+$/.test(pathname) || /^\/api\/pay\/[^/]+(\/order)?$/.test(pathname);
}

function isPortalPath(pathname: string): boolean {
  return pathname === "/portal" || pathname.startsWith("/portal/");
}

export async function proxy(request: NextRequest): Promise<Response> {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_API_PATHS.has(pathname) || isPublicPayPath(pathname)) return NextResponse.next();

  if (pathname.startsWith("/api/customer/")) {
    const auth = await requireCustomer(request);
    return "response" in auth ? auth.response : NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return (await requireOwner(request)) ?? NextResponse.next();
  }

  if (isPortalPath(pathname)) {
    const customer = await getCustomer(request).catch(() => null);
    if (pathname === "/portal/login" || pathname === "/portal/signup") {
      if (!customer) return NextResponse.next();
      // Signed-in customers skip the forms; an invitation is accepted explicitly on /portal/invite.
      const invite = request.nextUrl.searchParams.get("invite");
      const target = new URL(invite ? "/portal/invite" : "/portal", request.url);
      if (invite) target.searchParams.set("token", invite);
      return NextResponse.redirect(target);
    }
    if (PUBLIC_PAGES.has(pathname) || customer) return NextResponse.next();
    const login = new URL("/portal/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  if (PUBLIC_PAGES.has(pathname)) return NextResponse.next();

  const signedIn = await isOwnerRequest(request);
  if (pathname === "/login") {
    return signedIn ? NextResponse.redirect(new URL("/dashboard", request.url)) : NextResponse.next();
  }
  if (signedIn) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except build assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
