import Link from "next/link";

/**
 * Remi 后台 (admin) — route group `(remi)` scaffold.
 *
 * Scaffold only. The full admin UI is the Vite app co-located at
 * `apps/console/(remi)/` (a nested, non-workspace dir). Porting it into this
 * Next route group is the remaining Vite→Next integration tracked in
 * docs/DIR-REDESIGN-STATUS.md.
 */
export default function RemiAdmin() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1>Remi 后台</h1>
      <p>Admin area (scaffold). The Vite admin UI lives in apps/console/(remi)/.</p>
      <p>
        <Link href="/">← Back to console</Link>
      </p>
    </main>
  );
}
