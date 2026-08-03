import path from "node:path";
import type { NextConfig } from "next";

// Workspaces are hoisted, so `next` and @waypoint/core both live above apps/web.
// Turbopack won't compile anything outside its root, so point it at the repo root.
const workspaceRoot = path.join(import.meta.dirname, "..", "..");

const nextConfig: NextConfig = {
  transpilePackages: ["@waypoint/core"],
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
  turbopack: { root: workspaceRoot },
};

export default nextConfig;
