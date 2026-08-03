import { NextResponse } from "next/server";
import { auth } from "@waypoint/core/auth";
import { db } from "@waypoint/core/db";

/**
 * Default-deny proxy — §4/§11.
 *
 * Public surface:   /signin + /api/auth/*  (the OAuth dance itself)
 * Self-authed:      /api/runner/**         (per-task bearer token)
 *                   /api/webhooks/resend   (Svix signature)
 *                   /api/health            (not proxied by Caddy; internal only)
 * Everything else requires a valid session AND a live AllowedEmail row —
 * the allowlist is re-checked per request so JWT sessions can be revoked
 * instantly by removing an email.
 */
const PUBLIC_PATHS = [/^\/signin$/, /^\/api\/auth\//];
const SELF_AUTHED_PATHS = [/^\/api\/runner\//, /^\/api\/webhooks\/resend$/, /^\/api\/health$/];

const devBypass = () =>
  process.env.AUTH_DEV_BYPASS === "1" && process.env.NODE_ENV === "development";

export default auth(async (req) => {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((r) => r.test(pathname)) ||
    SELF_AUTHED_PATHS.some((r) => r.test(pathname))
  ) {
    return NextResponse.next();
  }

  // AUTH_DEV_BYPASS is honored only in development builds; the code path is
  // excluded from production behavior by the NODE_ENV guard (§11 self-hosting).
  if (devBypass()) return NextResponse.next();

  const deny = () =>
    pathname.startsWith("/api/")
      ? new NextResponse(null, { status: 401 }) // bare 401, no detail leakage
      : NextResponse.redirect(new URL("/signin", req.nextUrl));

  const email = req.auth?.user?.email;
  if (!email) return deny();

  const allowed = await db.allowedEmail.findUnique({ where: { email } });
  if (!allowed) return deny();

  return NextResponse.next();
});

export const config = {
  // everything except Next static assets; API routes included
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
