import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Waypoint",
  description: "Headless Claude Code pipelines",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark h-full bg-zinc-950">
      <body className="h-full">{children}</body>
    </html>
  );
}
