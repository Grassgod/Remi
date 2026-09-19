/**
 * MUL-338 round C — architecture guard for "catalog reads never probe".
 *
 * The behavioural test (tests/unit/multiremi/gateway-read-path-no-probe.test.ts)
 * proves that a read leaves the snapshot untouched, but it is a runtime proof of
 * one call shape at a time. This guard pins the structural reason: the modules
 * that serve model-catalog reads must not import the discovery module at all, so
 * there is no code path from a read to a network probe — not even a forgotten
 * fire-and-forget one, which a read would not wait for and the unit test could
 * therefore miss.
 *
 * The explicit-action surfaces are asserted to still reference discovery, so the
 * pattern this guard bans cannot be satisfied by a typo or a rename.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");

/** Modules on the model-catalog read path (agent dropdown, settings listing). */
const READ_PATH = [
  "packages/server/src/api/routers/runtimes.ts",
  "packages/server/src/store/runtime-model-catalog.ts",
  "packages/server/src/api/helpers/agents.ts",
];

/** Modules whose whole job is to probe — they must keep doing it. */
const EXPLICIT_ACTION_PATHS = [
  "packages/server/src/api/routers/workspaces.ts",
];

const BANNED = [
  "@multiremi/relay/discovery",
  "discoverGatewayModels",
  "probeGatewayModels",
  "triggerGatewayDiscovery",
  "refreshPreNativeCodexSnapshots",
];

function source(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

describe("MUL-338: catalog reads cannot probe the gateway", () => {
  test("no read-path module references the discovery module", () => {
    for (const path of READ_PATH) {
      const src = source(path);
      expect(src.length, `${path} must be readable`).toBeGreaterThan(0);
      for (const symbol of BANNED) {
        expect(src.includes(symbol), `${path} must not reference ${symbol}`).toBe(false);
      }
    }
  });

  test("the pattern is not vacuous: explicit actions still call discovery", () => {
    const src = source(EXPLICIT_ACTION_PATHS[0]!);
    expect(src).toContain("@multiremi/relay/discovery");
    expect(src).toContain("probeGatewayModels");
    expect(src).toContain("triggerGatewayDiscovery");
  });

  test("the fleet model read endpoint still lives in the guarded router", () => {
    const src = source(READ_PATH[0]!);
    expect(src).toContain("const fleetModelsHandler");
    expect(src).toContain('app.get("/api/models", fleetModelsHandler)');
  });

  test("discovery keeps the trigger it is supposed to have", () => {
    const src = source("packages/server/src/relay/discovery.ts");
    for (const symbol of ["export async function discoverGatewayModels", "export async function probeGatewayModels", "export function triggerGatewayDiscovery"]) {
      expect(src).toContain(symbol);
    }
  });
});
