import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";

// One PrismaClient per process (§3). Two writer processes exist in total:
// web (user actions + runner sync) and the orchestrator (lifecycle).

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  const adapter = new PrismaBetterSqlite3({ url });
  const client = new PrismaClient({ adapter });
  // Connection pragmas (§3). Fired immediately — the adapter executes queries in
  // order on its single connection, so these land before any application query.
  // journal_mode / busy_timeout return rows → $queryRawUnsafe; foreign_keys doesn't.
  void client.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch(() => {});
  void client.$queryRawUnsafe("PRAGMA busy_timeout=5000").catch(() => {});
  void client.$executeRawUnsafe("PRAGMA foreign_keys=ON").catch(() => {});
  return client;
}

const globalForDb = globalThis as unknown as { __waypointDb?: PrismaClient };

export const db: PrismaClient = globalForDb.__waypointDb ?? createClient();

// Reuse across Next.js hot reloads in development.
if (process.env.NODE_ENV !== "production") globalForDb.__waypointDb = db;

export * from "./generated/prisma/client";
