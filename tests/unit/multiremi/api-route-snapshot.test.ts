import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { captureApiSnapshot, GOLDEN_PATH, serializeSnapshot, type SnapshotFile } from "../../../scripts/snapshot-api-routes.js";

const goldenText = readFileSync(GOLDEN_PATH, "utf8");
const golden = JSON.parse(goldenText) as SnapshotFile;

/** First line where two documents diverge, or null when byte-identical. The
 *  golden is ~560 KB, so a raw string equality failure would be unreadable. */
function firstDiff(actual: string, expected: string): string | null {
  if (actual === expected) return null;
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
    if (actualLines[i] === expectedLines[i]) continue;
    return [
      `line ${i + 1} differs (${actual.length} chars captured vs ${expected.length} golden)`,
      `  captured: ${actualLines[i] ?? "<end of document>"}`,
      `  golden:   ${expectedLines[i] ?? "<end of document>"}`,
      `regenerate with: bun run scripts/snapshot-api-routes.ts`,
    ].join("\n");
  }
  return `documents differ but no differing line found (${actual.length} vs ${expected.length} chars)`;
}

describe("api route golden snapshot", () => {
  it("runs green and matches the golden route inventory", async () => {
    const snapshot = await captureApiSnapshot();

    // (a) the harness itself is healthy
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.entries.some((entry) => entry.status === "threw")).toBe(false);

    // (b) route COUNT matches the golden file — catches a registration dropped
    // by a router move even where body scrubbing is loose.
    expect(snapshot.meta.routeCount).toBe(golden.meta.routeCount);
    expect(snapshot.meta.routeCountByPrefix).toEqual(golden.meta.routeCountByPrefix);
    expect(snapshot.routes).toEqual(golden.routes);

    // Coverage must not silently shrink either.
    expect(snapshot.coveredRoutes).toEqual(golden.coveredRoutes);
    expect(snapshot.entries.map((entry) => entry.key)).toEqual(golden.entries.map((entry) => entry.key));

    // (c) byte-identical to the committed golden. (a)/(b) only compare keys,
    // statuses and the route inventory, so a changed RESPONSE BODY slips past
    // them; this makes plain `bun test` as strict as the --check CLI. The
    // harness pins clock, uuid, random, hostname and env, so it is stable.
    expect(firstDiff(serializeSnapshot(snapshot), goldenText)).toBeNull();
  }, 15_000);

  it("covers every GET route (websocket upgrades status-only)", async () => {
    const getRoutes = golden.routes.filter((route) => route.startsWith("GET "));
    const covered = new Set(golden.coveredRoutes);
    for (const route of getRoutes) expect(covered.has(route)).toBe(true);
    expect(golden.meta.statusOnlyRoutes).toEqual(["GET /api/daemon/ws", "GET /api/realtime/ws", "GET /ws"]);
  });
});
