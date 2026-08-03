import { NextResponse } from "next/server";
import { db } from "@waypoint/core";

/**
 * Internal-network healthcheck only — Caddy does not proxy this route (§4).
 * Docker healthchecks hit it directly on the compose network.
 */
export async function GET() {
  try {
    await db.$queryRawUnsafe("SELECT 1");
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
