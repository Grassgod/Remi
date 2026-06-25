# Remi 后台 (admin) inside the console — integration notes

The `(remi)` route group renders the **real** Remi admin UI, not a placeholder.

## What renders today

`app/(remi)/admin/page.tsx` mounts `RemiAdminApp.tsx`, a client-only island that
runs the full legacy admin SPA (originally the Vite app `remi-dashboard`,
relocated to `apps/console/(remi)/` in D11). The SPA source is staged here under
`_app/src/` and routed internally by **wouter hash-routing** — every admin view
is reachable:

- Overview: Dashboard
- Workspace: Conversations, Memory (+ entity / daily), Wiki, Skills, MCP,
  Prompts, Providers
- Observability: Analytics, Traces, Logs, Scheduler
- System: Agents, Projects, Bot Menu, Auth, Database, Config, Symlinks

It talks to the Remi admin backend over `/api/v1/*` (proxied by the console's
`next.config.ts` rewrites to the Remi server).

## How the Vite→Next adaptation was done (first cut)

Rather than re-author 63 framework-agnostic React files page-by-page, the whole
real app is mounted as a CSR island — the standard, honest way to host an
existing client SPA inside Next. Concrete adaptations:

1. **Source staged** at `_app/src/` (copied from `apps/console/(remi)/src/`,
   the canonical Vite source which stays in place).
2. **Alias rewrite**: the SPA's `@/…` (its own src-root alias) → `~remiadmin/…`
   so it does not collide with the console's `@/…` → app root. Mapped in
   `tsconfig.json`.
3. **Vite-only bits removed**: `import.meta.env.DEV` in `api/client.ts` →
   same-origin `BASE = ""`. `.js` import specifiers in `configkit/index.ts`
   stripped (webpack can't resolve `.js`→`.tsx` the way Vite's bundler did).
4. **Tailwind v3 → v4 theme bridge** (`admin.css`): the SPA was authored for
   Tailwind v3 (JS config + `--token` colors); the console runs Tailwind v4
   (CSS-first). `admin.css` re-declares every admin design token as a v4
   `@theme` and `@source`-scans the staged source, so the SPA's utilities
   (`bg-card`, `text-muted-foreground`, `text-success`, `border-border`, …)
   generate. Scoped under `.remi-admin-root` so it can't leak into the board.
5. **Fonts** (`Geist*`) copied to `public/fonts/`.

## What remains (incremental, not blocking)

- **File-by-file Next port**: the views still render via the SPA's own
  client router (hash URLs like `/admin#/conversations`) rather than as native
  Next route segments (`/admin/conversations`). Converting each page to a real
  Next page/layout — so deep links, SSR, and server components apply — is the
  remaining incremental work. The island is the bridge, not the destination.
- **Auth unification**: the admin keeps its own `useAuthStore`/SSO `fetchMe`
  flow; it is not yet unified with the board's `@multiremi/core` auth.
- **Design-system convergence**: the admin's local `ui/*` primitives and token
  set are bridged, not merged with `@multiremi/ui`. A later pass can migrate
  admin components onto the shared design system.

The canonical Vite app under `apps/console/(remi)/` is intentionally left in
place until this port is proven, per the integration plan.
