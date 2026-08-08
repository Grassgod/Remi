import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * bun.lock must stay registry-neutral.
 *
 * bun records a tarball URL in a lock entry only when the package came from
 * somewhere other than registry.npmjs.org; for the default registry the field
 * is the empty string. A developer installing through an internal mirror
 * (`registry=` in ~/.npmrc or ~/.bunfig.toml) gets absolute mirror URLs for
 * every package bun re-resolves, which leaks an internal hostname into the
 * repository and breaks CI — release workflows install with
 * `--registry https://registry.npmjs.org --frozen-lockfile`, and neither flag
 * saves them: the frozen install accepts a mirror URL (the lockfile still
 * matches package.json) and bun downloads from the URL recorded in the lock
 * rather than from `--registry`, so the runner dies fetching a host it cannot
 * reach. This test is the only gate that catches it first.
 *
 * `bun run lock:clean` blanks those URLs back to the default-registry form.
 */

const LOCK_PATH = join(import.meta.dir, "../../bun.lock");

/** `    "key": [ ... ],` — every packages entry in bun.lock is one line. */
const ENTRY_RE = /^ {4}("(?:[^"\\]|\\.)*"): (\[.*\]),$/;

const FIX = "run `bun run lock:clean` and commit the result";

describe("bun.lock registry neutrality", () => {
  const raw = readFileSync(LOCK_PATH, "utf8");

  test("no internal mirror hostname anywhere in the lockfile", () => {
    // Counted rather than asserted with toContain: a failing toContain would
    // print the entire 100KB lockfile and bury the instruction below.
    const hits = raw.split("byted.org").length - 1;
    expect(hits, `bun.lock leaks the internal npm mirror hostname — ${FIX}`).toBe(0);
  });

  test("every package resolves through the default registry", () => {
    // Entry shapes: workspace packages are ["name@workspace:path"] (no
    // resolution field); registry packages are ["name@version", "", {…}, "sha512-…"]
    // where "" means "the default registry". git/file/link specifiers are
    // legitimate non-empty resolutions; an absolute http(s) URL is not.
    const offenders: string[] = [];
    let entries = 0;

    for (const line of raw.split("\n")) {
      const match = ENTRY_RE.exec(line);
      if (match === null) continue;
      entries++;

      const entry = JSON.parse(match[2]!) as unknown[];
      if (entry.length < 2) continue;

      const resolution = entry[1];
      if (typeof resolution !== "string") continue;
      if (/^https?:\/\//.test(resolution)) offenders.push(`${String(entry[0])} -> ${resolution}`);
    }

    // A parser that matched nothing would pass vacuously.
    expect(entries).toBeGreaterThan(0);
    // A polluted lock has ~1300 offenders; show a sample, not the flood.
    const sample = offenders.length > 5
      ? [...offenders.slice(0, 5), `… and ${offenders.length - 5} more`]
      : offenders;
    expect(sample, `bun.lock pins ${offenders.length} absolute tarball URL(s) — ${FIX}`).toEqual([]);
  });
});
