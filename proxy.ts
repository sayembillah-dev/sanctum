import { NextRequest, NextResponse } from "next/server";

/**
 * The gate (Next 16 "proxy", formerly middleware). OPTIMISTIC check only:
 * cookie PRESENCE, not validity — verifying a session needs the DB, which is
 * not edge-safe here. Real verification happens server-side via requireUser()
 * in every API route. An expired cookie gets past this file and is bounced
 * by the route handlers instead.
 *
 * Public surface:
 *   /login, /signup            — the auth pages
 *   /api/auth/*                — better-auth's own endpoints
 *   /api/settings              — GET is public (signup page), POST is admin-gated in the route
 *   /api/admin/consolidate     — Vercel Cron, guarded by CRON_SECRET inside the route
 */
const PUBLIC_PREFIXES = ["/login", "/signup", "/api/auth", "/api/settings", "/api/admin/consolidate"];

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  const token =
    req.cookies.get("__Secure-better-auth.session_token")?.value ??
    req.cookies.get("better-auth.session_token")?.value;
  if (!token) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  // everything except Next internals and static files
  matcher: ["/((?!_next|favicon.ico).*)"],
};
