#!/usr/bin/env bun
/**
 * Layer dependency checker for the block architecture (see docs/DIR-REDESIGN.md §3).
 *
 *   L0  shared         ← imports nobody
 *   L1  acp memory queue connectors auth  ← only L0; L1 blocks have zero cross-deps
 *   L2  daemon         ← L0 + L1
 *   L3  remi multiremi ← L0 + L1 + L2; remi and multiremi do not import each other
 *   L4  cli (entry)    ← anything
 *
 * Every src/ module now lives in a classified layer — the directory restructure
 * is complete and no legacy/unmoved dirs or re-export shims remain. Any module
 * NOT in the LAYER map is treated as external/unclassified and exempt (source and
 * target), so a newly-added unclassified dir stays quiet until it is classified.
 *
 * Usage:
 *   bun run scripts/check-layers.ts          # WARN only, always exit 0
 *   bun run scripts/check-layers.ts --strict # exit 1 if any violation
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, normalize } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** module name → layer number. Modules not listed are "legacy" (exempt). */
const LAYER: Record<string, number> = {
  shared: 0,
  acp: 1,
  memory: 1,
  queue: 1,
  connectors: 1,
  auth: 1,
  daemon: 2,
  remi: 3,
  multiremi: 3,
  cli: 4,
};

/** Loose entry files under src/ that may import anything (treated as L4). */
const ENTRY_FILES = new Set(["main.ts", "multiremi-main.ts", "index.ts"]);

/**
 * Per-path layer overrides — files whose layer differs from their top-level dir.
 *
 * queue/index.ts (RemiQueueManager) and queue/handlers/** are Remi-product
 * *orchestration*: they wire the Remi product's cron queues and `import type
 * { Remi }` from remi/core.ts to dispatch jobs against product internals. They
 * are not generic L1 queue infrastructure — that is queue/queues.ts (name
 * constants + job-data types, zero deps), which stays L1. Classifying these two
 * at L3 makes their dependency on Remi a within-layer (downward) edge rather
 * than an upward violation, and keeps D4's "L1 blocks are independent" check
 * meaningful for the genuinely-infra part of the block. Longest matching prefix
 * wins.
 */
const PATH_LAYER_OVERRIDE: Array<{ prefix: string; layer: number }> = [
  { prefix: "queue/index.ts", layer: 3 },
  { prefix: "queue/handlers/", layer: 3 },
];

/** Alias prefix → module. Longest prefix wins, so order does not matter here. */
const ALIAS_MODULE: Record<string, string> = {
  "@shared/": "shared",
  "@acp/": "acp",
  "@memory/": "memory",
  "@queue/": "queue",
  "@connectors/": "connectors",
  "@auth/": "auth",
  "@daemon/": "daemon",
  "@multiremi/": "multiremi",
  // package-scoped alias (the one remaining workspace package)
  "@remi/plugin-sdk": "__external__",
  // bare product alias — must be matched AFTER the package-scoped one above
  "@remi/": "remi",
};

const L1_BLOCKS = new Set(["acp", "memory", "queue", "connectors", "auth"]);

/** The two L3 product roots that must not import each other. */
const L3_PRODUCTS = new Set(["remi", "multiremi"]);

interface Violation {
  file: string;
  spec: string;
  srcModule: string;
  tgtModule: string;
  reason: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** First path segment (dir or loose file) of a path relative to src/. */
function moduleOf(relPathFromSrc: string): string {
  return relPathFromSrc.split("/")[0];
}

function layerOf(mod: string): number | undefined {
  if (LAYER[mod] !== undefined) return LAYER[mod];
  if (ENTRY_FILES.has(mod)) return 4;
  return undefined; // legacy / unclassified
}

/** Source-file layer: per-path override (longest prefix) takes precedence over the module layer. */
function sourceLayerOf(relPathFromSrc: string, mod: string): number | undefined {
  let best: { prefix: string; layer: number } | null = null;
  for (const o of PATH_LAYER_OVERRIDE) {
    if (relPathFromSrc.startsWith(o.prefix) && (!best || o.prefix.length > best.prefix.length)) best = o;
  }
  if (best) return best.layer;
  return layerOf(mod);
}

/** Extract import/export-from specifiers from source text. */
function extractSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    specs.push(m[1] ?? m[2] ?? m[3]);
  }
  return specs;
}

/** Resolve a specifier to a module name under src/, or null if external/unresolvable. */
function resolveModule(spec: string, fileDir: string): string | null {
  // relative import
  if (spec.startsWith(".")) {
    const abs = normalize(join(fileDir, spec));
    const rel = relative(SRC, abs);
    if (rel.startsWith("..")) return null; // resolves outside src/
    return moduleOf(rel);
  }
  // alias import — longest matching prefix wins
  let best: { prefix: string; mod: string } | null = null;
  for (const [prefix, mod] of Object.entries(ALIAS_MODULE)) {
    if (spec === prefix.replace(/\/$/, "") || spec.startsWith(prefix)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, mod };
    }
  }
  if (best) return best.mod === "__external__" ? null : best.mod;
  // @/foo → src/foo
  if (spec.startsWith("@/")) return moduleOf(spec.slice(2));
  return null; // node:/npm package
}

const files = walk(SRC);
const violations: Violation[] = [];

for (const file of files) {
  const relFromSrc = relative(SRC, file);
  const srcModule = moduleOf(relFromSrc);
  const srcLayer = sourceLayerOf(relFromSrc, srcModule);
  if (srcLayer === undefined) continue; // legacy source — not yet enforced

  const text = readFileSync(file, "utf-8");
  for (const spec of extractSpecifiers(text)) {
    const tgtModule = resolveModule(spec, dirname(file));
    if (!tgtModule) continue;
    if (tgtModule === srcModule) continue;
    const tgtLayer = layerOf(tgtModule);
    if (tgtLayer === undefined) continue; // legacy target — exempt

    if (tgtLayer > srcLayer) {
      violations.push({ file: relFromSrc, spec, srcModule, tgtModule, reason: `L${srcLayer} → L${tgtLayer} (imports upward)` });
    } else if (srcLayer === 1 && tgtLayer === 1 && L1_BLOCKS.has(srcModule) && L1_BLOCKS.has(tgtModule)) {
      violations.push({ file: relFromSrc, spec, srcModule, tgtModule, reason: "L1 cross-dependency (blocks must be independent)" });
    } else if (srcLayer === 3 && tgtLayer === 3 && L3_PRODUCTS.has(srcModule) && L3_PRODUCTS.has(tgtModule)) {
      // Only the two product roots must stay mutually independent. An L3-classified
      // orchestration file (e.g. queue/index.ts via PATH_LAYER_OVERRIDE) importing
      // its own product (remi) is a within-layer downward edge, not a cross-product one.
      violations.push({ file: relFromSrc, spec, srcModule, tgtModule, reason: "L3 cross-dependency (remi ↔ multiremi)" });
    }
  }
}

const strict = process.argv.includes("--strict");

if (violations.length === 0) {
  console.log(`[check-layers] OK — ${files.length} files scanned, 0 violations.`);
  process.exit(0);
}

console.log(`[check-layers] ${violations.length} violation(s) across ${files.length} files:\n`);
for (const v of violations) {
  console.log(`  WARN  ${v.file}`);
  console.log(`        ${v.srcModule} imports "${v.spec}" → ${v.tgtModule}  [${v.reason}]`);
}
console.log("");
process.exit(strict ? 1 : 0);
