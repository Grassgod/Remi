import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { Database } from "bun:sqlite";
import {
  HERMETIC_ENV_SENTINEL,
  SCRUBBED_ENV_KEYS,
  SCRUBBED_ENV_PREFIXES,
  isScrubbedEnvKey,
} from "../setup/hermetic-env.js";

/**
 * The backend suite must not read this repo's configuration out of the host shell.
 *
 * MUL-318: every Agent process inherits `MULTIREMI_TOKEN` from the daemon, and
 * `createMultiremiApp()` falls back to it when no `authToken` option is passed —
 * so `bun test` inside an Agent turned dashboard auth on for the whole unit suite
 * and reported 242 false 401 failures, while CI (no such variable) stayed green.
 * `tests/setup/hermetic-env.ts` strips the namespace in a `bun test` preload; these
 * tests are the ratchet that keeps it wired up.
 */

const ROOT = join(import.meta.dir, "../..");
const PRELOAD_PATH = "./tests/setup/hermetic-env.ts";

const FIX = `restore \`preload = ["${PRELOAD_PATH}"]\` under [test] in bunfig.toml`;

describe("hermetic test environment", () => {
  test("bunfig.toml preloads the env scrubber", () => {
    const bunfig = parseToml(readFileSync(join(ROOT, "bunfig.toml"), "utf8")) as {
      test?: { preload?: string | string[] };
    };
    const preload = bunfig.test?.preload;
    const entries = typeof preload === "string" ? [preload] : preload ?? [];
    expect(entries, `bunfig.toml no longer preloads the env scrubber — ${FIX}`).toContain(PRELOAD_PATH);
  });

  test("the preload actually ran in this test process", () => {
    const sentinel = (globalThis as Record<symbol, unknown>)[HERMETIC_ENV_SENTINEL] as
      | { removed: string[] }
      | undefined;
    expect(sentinel, `the env scrubber never ran — ${FIX}`).toBeDefined();
    expect(Array.isArray(sentinel?.removed)).toBe(true);
  });

  test("no repo-owned env var survives into the test process", () => {
    const leaked = Object.keys(process.env).filter(isScrubbedEnvKey).sort();
    expect(
      leaked,
      "these env vars change server behavior and must not be inherited or leaked between "
        + `tests (set and restore them inside the test that needs them): ${leaked.join(", ")}`,
    ).toEqual([]);
  });

  test("the scrub list covers the auth-relevant variables", () => {
    // Named explicitly so dropping a prefix or key is a test failure, not a silent
    // widening of what the host can influence.
    for (const name of ["MULTIREMI_TOKEN", "MULTIREMI_SHARE_SECRET", "JWT_SECRET"]) {
      expect(isScrubbedEnvKey(name), `${name} must stay in the scrub list`).toBe(true);
    }
    expect([...SCRUBBED_ENV_PREFIXES]).toContain("MULTIREMI_");
    // A host-provided sqlite build is a capability, not a behavior toggle.
    expect([...SCRUBBED_ENV_KEYS]).not.toContain("SQLITE_LIB_PATH");
  });

  test("an app built without authToken serves unauthenticated requests", async () => {
    // The exact shape of the MUL-318 false failure: no Authorization header,
    // and the response must not be a 401 produced by an inherited token.
    const db = new Database(":memory:");
    try {
      const app = createMultiremiApp({ store: new MultiremiStore(db) });
      const res = await app.request("/api/multiremi/projects");
      expect(res.status, "dashboard auth switched on without an explicit authToken").not.toBe(401);
    } finally {
      db.close();
    }
  });
});
