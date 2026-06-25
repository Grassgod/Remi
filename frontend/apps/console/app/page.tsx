import Link from "next/link";

/**
 * Unified console entry page (DIR-REDESIGN.md §1/§6).
 *
 * The console is the SINGLE Next.js app. Two real UIs render under two route
 * groups in `app/`:
 *   - `(multiremi)` → the Multiremi 看板 (board). The full Next App Router UI
 *     ported from `apps/web`: auth (`/login`), the workspace dashboard
 *     (`/[workspaceSlug]/issues|projects|agents|…`), Lark binding, changelog.
 *   - `(remi)`      → the Remi 后台 (admin) at `/admin`. First-cut Next port of
 *     the legacy Vite admin (dashboard shell + primary views).
 */
export default function ConsoleHome() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Remi Console</h1>
        <p className="text-muted-foreground">
          Unified entry for the Remi admin (后台) and the Multiremi board (看板).
        </p>
      </header>
      <nav className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/login"
          className="rounded-lg border border-border p-5 transition-colors hover:bg-accent"
        >
          <div className="text-lg font-medium">Multiremi 看板</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Task board: issues, projects, agents, runtimes, skills. Sign in to
            reach your workspace.
          </p>
        </Link>
        <Link
          href="/admin"
          className="rounded-lg border border-border p-5 transition-colors hover:bg-accent"
        >
          <div className="text-lg font-medium">Remi 后台</div>
          <p className="mt-1 text-sm text-muted-foreground">
            Admin: dashboard, conversations, memory, providers, config.
          </p>
        </Link>
      </nav>
    </main>
  );
}
