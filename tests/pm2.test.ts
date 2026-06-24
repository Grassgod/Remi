/**
 * Characterization test for pm2 ecosystem generation.
 *
 * Locks the load-bearing behavior of REMI_ROOT (resolved from the module's own
 * location): the generated "remi" PM2 app must run with cwd = the repo root, i.e.
 * a directory that actually contains src/main.ts. This pins the import.meta.dir
 * depth so the D6 move src/pm2.ts → src/daemon/pm2.ts cannot silently break it.
 */

import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateEcosystem } from "../src/pm2.js";
import type { RemiConfig } from "../src/config.js";

test("pm2 ecosystem: remi app cwd resolves to the repo root (contains src/main.ts)", () => {
  const config = { proxy: { http: "" }, services: [] } as unknown as RemiConfig;
  const content = generateEcosystem(config);
  const cwd = content.match(/"name":\s*"remi"[\s\S]*?"cwd":\s*"([^"]+)"/)?.[1];
  expect(cwd).toBeDefined();
  expect(existsSync(join(cwd!, "src", "main.ts"))).toBe(true);
});
