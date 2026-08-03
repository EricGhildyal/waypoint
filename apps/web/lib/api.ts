import { NextResponse } from "next/server";
import { TransitionError } from "@waypoint/core";
import { auth } from "@waypoint/core/auth";
import { db } from "@waypoint/core/db";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const devBypass = () =>
  process.env.AUTH_DEV_BYPASS === "1" && process.env.NODE_ENV === "development";

/** Resolve the signed-in user (attribution only — no RBAC in v1). */
export async function requireUser(): Promise<{ id: string; email: string }> {
  if (devBypass()) {
    const u = await db.user.upsert({
      where: { email: "dev@waypoint.local" },
      update: {},
      create: { email: "dev@waypoint.local", name: "Dev Bypass" },
    });
    return { id: u.id, email: u.email };
  }
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new ApiError(401, "unauthenticated");
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new ApiError(401, "unauthenticated");
  return { id: user.id, email: user.email };
}

/**
 * CSRF/origin check for state-changing handlers (§11): reject requests whose
 * Origin / Sec-Fetch-Site isn't same-origin.
 */
export function assertSameOrigin(req: Request): void {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError(403, "cross-origin request rejected");
  }
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("host");
    try {
      if (new URL(origin).host !== host) throw new ApiError(403, "cross-origin request rejected");
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(403, "cross-origin request rejected");
    }
  }
}

export function apiError(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof TransitionError) {
    // a user action the state machine disallows (e.g. pausing a QUEUED task)
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "invalid request", issues: err.issues }, { status: 400 });
  }
  console.error(err);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
