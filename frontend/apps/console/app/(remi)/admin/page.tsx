"use client";

import dynamic from "next/dynamic";

/**
 * Remi 后台 (admin) — route group `(remi)`.
 *
 * Renders the REAL admin UI: the legacy Vite SPA (dashboard shell + all admin
 * views — conversations, memory, skills, MCP, providers, analytics, traces,
 * logs, scheduler, agents, projects, config, database, …) mounted as a
 * client-only island. The SPA source lives under `app/(remi)/_app/` and is
 * routed internally by wouter hash-routing (e.g. `/admin#/conversations`).
 *
 * This is the Vite→Next first cut: the full real app renders inside the single
 * console Next app. See _app/README for what's wholesale-mounted vs. the
 * incremental file-by-file Next port that remains.
 */
const RemiAdminApp = dynamic(() => import("../_app/RemiAdminApp"), {
  ssr: false,
  loading: () => (
    <div className="flex h-svh items-center justify-center text-sm text-muted-foreground">
      Loading Remi admin…
    </div>
  ),
});

export default function RemiAdminPage() {
  return <RemiAdminApp />;
}
