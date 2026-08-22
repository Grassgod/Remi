import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cliCommandInventory } from "../../../apps/remi/cli/index.js";
import { CLI_CAPABILITIES_RUNTIME } from "../../../packages/server/src/api/cli-capabilities-generated.js";
import {
  cliCoverageReport,
  cliRuntimeCapabilities,
  type CliCapabilitiesManifest,
  validateCliCapabilities,
} from "../../../scripts/cli-capabilities.js";

const root = resolve(import.meta.dir, "../../..");
const golden = JSON.parse(readFileSync(resolve(root, "scripts/api-routes.golden.json"), "utf8")) as { routes: string[] };
const manifest = JSON.parse(readFileSync(resolve(root, "cli-capabilities.json"), "utf8")) as CliCapabilitiesManifest;

describe("CLI capabilities manifest", () => {
  it("matches golden routes in both directions and Registry commands in both directions", () => {
    expect(validateCliCapabilities(golden.routes, manifest, cliCommandInventory())).toEqual([]);
    expect(new Set(Object.keys(manifest.routes))).toEqual(new Set(golden.routes));
    expect(new Set(Object.keys(manifest.commands))).toEqual(new Set(cliCommandInventory().map((entry) => entry.id)));
  });

  it("keeps the server runtime projection synchronized with the root manifest", () => {
    const generatedRuntime: unknown = CLI_CAPABILITIES_RUNTIME;
    expect(generatedRuntime).toEqual(cliRuntimeCapabilities(manifest));
  });

  it("keeps staged user routes visible as missing and records compatibility aliases", () => {
    expect(cliCoverageReport(manifest)).toEqual({
      mapped: 2,
      exempt: 62,
      missing: 505,
      total: 569,
    });
    expect(manifest.max_planned_routes).toBe(505);
    expect(cliCoverageReport(manifest).missing).toBeLessThanOrEqual(manifest.max_planned_routes);
    expect(manifest.routes["GET /api/cli/context"]).toEqual({ command: "context.get" });
    expect(manifest.routes["GET /api/cli/capabilities"]).toEqual({ command: "context.get" });
    expect(manifest.aliases["remi multiremi"]).toEqual({
      command: "legacy.multiremi",
      deprecated_since: "0.3.0",
      replacement: "remi <command>",
      hidden: true,
    });
    expect(Object.values(manifest.routes).filter((route) => "planned_command" in route).length).toBeGreaterThan(0);
  });

  it("rejects growth beyond the staged migration ratchet", () => {
    const overBudget = structuredClone(manifest);
    overBudget.max_planned_routes--;
    expect(validateCliCapabilities(golden.routes, overBudget, cliCommandInventory())).toContain(
      "planned route count 505 exceeds ratchet 504",
    );
  });
});
