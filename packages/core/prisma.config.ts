import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7: connection URL lives here (not in schema.prisma).
// DATABASE_URL examples: file:/data/waypoint.db (prod), file:./prisma/dev.db (local)
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  },
});
