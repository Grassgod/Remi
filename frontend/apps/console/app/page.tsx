/**
 * Unified console entry page.
 *
 * Landing for the consolidated frontend → Remi 后台 (admin) + Multiremi 看板.
 * The Remi admin UI currently lives as a co-located Vite app under
 * `(remi)/` (relocated from the old top-level web/frontend in D11); the
 * Multiremi console is the Next app in `frontend/apps/web`. Wiring both into
 * this single Next app (route groups (remi) / (multiremi)) is the remaining
 * Vite→Next integration tracked in docs/DIR-REDESIGN-STATUS.md.
 */
export default function ConsoleHome() {
  return (
    <main>
      <h1>Remi Console</h1>
      <ul>
        <li>
          <a href="/(remi)">Remi 后台</a>
        </li>
        <li>
          <a href="/(multiremi)">Multiremi 看板</a>
        </li>
      </ul>
    </main>
  );
}
