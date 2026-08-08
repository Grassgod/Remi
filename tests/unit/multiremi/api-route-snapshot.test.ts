import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { captureApiSnapshot, GOLDEN_PATH, type SnapshotFile } from "../../../scripts/snapshot-api-routes.js";

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as SnapshotFile;

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
  });

  it("covers every GET route (websocket upgrades status-only)", async () => {
    const getRoutes = golden.routes.filter((route) => route.startsWith("GET "));
    const covered = new Set(golden.coveredRoutes);
    for (const route of getRoutes) expect(covered.has(route)).toBe(true);
    expect(golden.meta.statusOnlyRoutes).toEqual(["GET /api/daemon/ws", "GET /api/realtime/ws", "GET /ws"]);
  });
});
