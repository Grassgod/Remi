import Link from "next/link";

/**
 * Multiremi 看板 (board) — route group `(multiremi)` scaffold.
 *
 * Scaffold only. The full Multiremi console currently ships from the
 * `apps/web` (@multiremi/web) Next app. Consolidating it into this route group
 * is the remaining work tracked in docs/DIR-REDESIGN-STATUS.md.
 */
export default function MultiremiBoard() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1>Multiremi 看板</h1>
      <p>Board area (scaffold). The full console currently lives in apps/web.</p>
      <p>
        <Link href="/">← Back to console</Link>
      </p>
    </main>
  );
}
