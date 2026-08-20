#!/usr/bin/env bun
/**
 * Strip mirror-registry URLs out of bun.lock.
 *
 * WHY: bun writes the resolved tarball URL into a lock entry only when the
 * package did NOT come from registry.npmjs.org — for the default registry the
 * field is the empty string. Developers behind an internal mirror (a
 * `registry=` line in ~/.npmrc or ~/.bunfig.toml) therefore get entries like
 *
 *   "is-odd": ["is-odd@3.0.1", "https://mirror.example/is-odd/-/is-odd-3.0.1.tgz", {...}, "sha512-..."],
 *
 * every time bun re-resolves a package (`bun add`, a changed dependency
 * range, `--force`). That leaks an internal hostname into the repository and
 * breaks CI, which installs with `--registry https://registry.npmjs.org
 * --frozen-lockfile`. Bun has no option to fetch from a mirror while
 * writing a registry-neutral lockfile, so this script does it after the fact.
 *
 *   bun run lock:clean
 *
 * The rewrite is textual and surgical: only the resolution field is blanked,
 * and only when the URL is exactly the registry tarball layout for that
 * entry's own name@version (`<origin>/<name>/-/<basename>-<version>.tgz`).
 * Integrity hashes, dependency metadata, key order, and every other byte are
 * left untouched — the result is byte-identical to what bun itself writes
 * against the default registry.
 *
 * Anything else in the resolution field is left alone: workspace entries have
 * no field at all, and git/file/link specifiers are legitimate. An http(s)
 * URL that does NOT match the canonical layout is a shape this script does
 * not understand — it is reported and the run exits non-zero rather than
 * guessing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_PATH = join(import.meta.dir, "..", "bun.lock");

/** `    "key": [ ... ],` — every packages entry in bun.lock is one line. */
const ENTRY_RE = /^ {4}("(?:[^"\\]|\\.)*"): (\[.*\]),$/;

/** Split `@scope/name@1.2.3` into its name and version halves. */
function splitSpec(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/**
 * True if `url` is the standard registry tarball URL for `spec`, i.e.
 * `<origin>/<name>/-/<basename>-<version>.tgz`, for any http(s) origin.
 */
function isRegistryTarball(url: string, spec: string): boolean {
  if (!/^https?:\/\//.test(url)) return false;
  const parsed = splitSpec(spec);
  if (parsed === null) return false;
  const basename = parsed.name.slice(parsed.name.lastIndexOf("/") + 1);
  const suffix = `/${parsed.name}/-/${basename}-${parsed.version}.tgz`;
  if (!url.endsWith(suffix)) return false;
  const origin = url.slice(0, -suffix.length);
  return /^https?:\/\/[^/]+$/.test(origin);
}

function main(): number {
  const lines = readFileSync(LOCK_PATH, "utf8").split("\n");

  let cleaned = 0;
  let alreadyClean = 0;
  let nonRegistry = 0;
  const surprises: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = ENTRY_RE.exec(lines[i]!);
    if (match === null) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(match[2]!);
    } catch {
      surprises.push(`line ${i + 1}: entry value is not valid JSON`);
      continue;
    }
    if (!Array.isArray(entry)) {
      surprises.push(`line ${i + 1}: entry value is not an array`);
      continue;
    }

    const [spec, resolution] = entry as [unknown, unknown];
    // Workspace entries are `["name@workspace:path"]` — no resolution field.
    if (entry.length < 2) continue;
    if (typeof spec !== "string" || typeof resolution !== "string") {
      surprises.push(`line ${i + 1}: expected string spec and resolution`);
      continue;
    }

    if (resolution === "") {
      alreadyClean++;
      continue;
    }
    // git+/github:/file:/link: resolutions are not registry downloads.
    if (!/^https?:\/\//.test(resolution)) {
      nonRegistry++;
      continue;
    }
    if (!isRegistryTarball(resolution, spec)) {
      surprises.push(`line ${i + 1}: ${spec} has an unrecognized URL: ${resolution}`);
      continue;
    }

    const specStart = lines[i]!.indexOf(JSON.stringify(spec));
    const urlStart = lines[i]!.indexOf(JSON.stringify(resolution), specStart);
    if (specStart < 0 || urlStart < 0) {
      surprises.push(`line ${i + 1}: ${spec} resolution not found verbatim in the line`);
      continue;
    }
    lines[i] =
      lines[i]!.slice(0, urlStart) +
      '""' +
      lines[i]!.slice(urlStart + JSON.stringify(resolution).length);
    cleaned++;
  }

  if (surprises.length > 0) {
    console.error("bun.lock has entries this script does not understand:");
    for (const surprise of surprises) console.error(`  ${surprise}`);
    console.error("Nothing was written. Inspect the lockfile by hand.");
    return 1;
  }

  if (cleaned > 0) writeFileSync(LOCK_PATH, lines.join("\n"));

  const parts = [`${cleaned} cleaned`, `${alreadyClean} already clean`];
  if (nonRegistry > 0) parts.push(`${nonRegistry} non-registry`);
  console.log(`bun.lock: ${parts.join(", ")}`);
  if (cleaned === 0) console.log("Nothing to do.");
  return 0;
}

process.exit(main());
