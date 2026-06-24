import Link from "next/link";

/**
 * Unified console entry page (DIR-REDESIGN.md §1/§6).
 *
 * Landing for the consolidated frontend. Two areas, each scoped to a Next.js
 * route group under `app/`:
 *   - `(remi)`      → Remi 后台 (admin). The legacy admin UI still lives as a
 *                     co-located Vite app under `apps/console/(remi)/` (relocated
 *                     from the old top-level web/frontend in D11). The Next route
 *                     group here is scaffold pending the incremental Vite→Next port.
 *   - `(multiremi)` → Multiremi 看板. The full board currently ships from
 *                     `apps/web` (@multiremi/web); the route group here is scaffold.
 */
export default function ConsoleHome() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1>Remi Console</h1>
      <p>Unified entry for the Remi admin and the Multiremi board.</p>
      <ul>
        <li>
          <Link href="/admin">Remi 后台 (admin)</Link>
        </li>
        <li>
          <Link href="/board">Multiremi 看板 (board)</Link>
        </li>
      </ul>
    </main>
  );
}
