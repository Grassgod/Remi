#!/usr/bin/env bun
/**
 * rebuild-metrics.ts — One-time historical data correction.
 *
 * Strategy:
 * - Historical "cli" source entries have accurate cache token data (scanned from CC tracing)
 * - Historical "remi" source entries are duplicates with missing cache data → DELETE them
 * - Re-label remaining "cli" entries as "remi" (single source going forward)
 * - Recalculate cost for all entries
 * - Update SQLite conversations with aggregated token data from metrics
 *
 * Usage: bun run scripts/rebuild-metrics.ts [--dry-run]
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  cpSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "bun:sqlite";

const DRY_RUN = process.argv.includes("--dry-run");
const REMI_DIR = join(homedir(), ".remi");
const METRICS_DIR = join(REMI_DIR, "metrics");
const DB_PATH = join(REMI_DIR, "remi.db");

// ── Pricing (mirrors collector.ts) ──────────────────────

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  "claude-opus-4-6[1m]": { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
};
const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };

function estimateCost(model: string | null, inp: number, out: number, cacheRead: number, cacheCreate: number): number {
  const p = (model && MODEL_PRICING[model]) || DEFAULT_PRICING;
  return (inp * p.input + out * p.output + cacheRead * p.cacheRead + cacheCreate * p.cacheCreate) / 1_000_000;
}

interface MetricEntry {
  ts: string;
  src: string;
  sid: string | null;
  model: string | null;
  in: number;
  out: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number | null;
  dur: number | null;
  project: string | null;
  connector: string | null;
}

// ── Step 1: Backup ──────────────────────────────────────

console.log("=== Step 1: Backup ===");
const backupDir = join(REMI_DIR, "metrics.bak");
if (existsSync(backupDir)) {
  console.log(`  Backup already exists at ${backupDir}, skipping`);
} else if (!DRY_RUN) {
  cpSync(METRICS_DIR, backupDir, { recursive: true });
  console.log(`  Backed up → ${backupDir}`);
} else {
  console.log(`  [DRY-RUN] Would backup`);
}

// ── Step 2: Process JSONL files ─────────────────────────

console.log("\n=== Step 2: Clean JSONL metrics ===");

const jsonlFiles = readdirSync(METRICS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
let totalBefore = 0;
let totalAfter = 0;
let remiRemoved = 0;
let cliRelabeled = 0;
let costRecalculated = 0;

// Collect all cleaned entries per session for DB update later
const sessionEntries = new Map<string, MetricEntry[]>();

for (const file of jsonlFiles) {
  const filePath = join(METRICS_DIR, file);
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  totalBefore += lines.length;

  const cleaned: MetricEntry[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as MetricEntry;

      if (entry.src === "remi") {
        // Drop remi source entries — they're duplicates with missing cache data
        remiRemoved++;
        continue;
      }

      // Re-label cli → remi (single source going forward)
      if (entry.src === "cli") {
        entry.src = "remi";
        cliRelabeled++;
      }

      // Recalculate cost
      entry.cost = estimateCost(entry.model, entry.in, entry.out, entry.cacheRead, entry.cacheCreate);
      costRecalculated++;

      cleaned.push(entry);

      // Track per session for DB update
      if (entry.sid) {
        const list = sessionEntries.get(entry.sid) || [];
        list.push(entry);
        sessionEntries.set(entry.sid, list);
      }
    } catch { /* skip malformed */ }
  }

  totalAfter += cleaned.length;

  if (!DRY_RUN) {
    if (cleaned.length === 0) {
      rmSync(filePath);
    } else {
      writeFileSync(filePath, cleaned.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    }
  }
}

// Clean up stale position tracking file
const posFile = join(METRICS_DIR, ".cli-scan-positions.json");
if (existsSync(posFile) && !DRY_RUN) {
  rmSync(posFile);
  console.log("  Removed .cli-scan-positions.json");
}

console.log(`  Files: ${jsonlFiles.length}`);
console.log(`  Before: ${totalBefore} entries`);
console.log(`  Removed ${remiRemoved} duplicate remi entries`);
console.log(`  Re-labeled ${cliRelabeled} cli → remi`);
console.log(`  Recalculated cost for ${costRecalculated} entries`);
console.log(`  After: ${totalAfter} entries`);

// ── Step 3: Update SQLite conversations ──────────────────

console.log("\n=== Step 3: Update SQLite conversations ===");

if (!DRY_RUN) {
  const db = new Database(DB_PATH);

  // Ensure cache columns exist
  const cols = db.query("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
  const colSet = new Set(cols.map((c) => c.name));
  if (!colSet.has("cache_create_tokens")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cache_create_tokens INTEGER");
  }
  if (!colSet.has("cache_read_tokens")) {
    db.exec("ALTER TABLE conversations ADD COLUMN cache_read_tokens INTEGER");
  }

  // Load conversations
  const convRows = db.query(`
    SELECT id, cli_session_id FROM conversations WHERE status = 'completed' AND cli_session_id IS NOT NULL
  `).all() as Array<{ id: number; cli_session_id: string }>;

  const updateStmt = db.prepare(`
    UPDATE conversations
    SET input_tokens = ?, output_tokens = ?,
        cache_create_tokens = ?, cache_read_tokens = ?,
        cost_usd = ?
    WHERE id = ?
  `);

  let updated = 0;
  let skipped = 0;

  for (const row of convRows) {
    const entries = sessionEntries.get(row.cli_session_id);
    if (!entries || entries.length === 0) { skipped++; continue; }

    // Aggregate all entries for this session
    let totalIn = 0, totalOut = 0, totalCC = 0, totalCR = 0, totalCost = 0;
    for (const e of entries) {
      totalIn += e.in;
      totalOut += e.out;
      totalCC += e.cacheCreate;
      totalCR += e.cacheRead;
      totalCost += e.cost ?? 0;
    }

    updateStmt.run(totalIn, totalOut, totalCC, totalCR, totalCost, row.id);
    updated++;
  }

  // Mark stuck processing rows as failed
  const stuckResult = db.run(`
    UPDATE conversations
    SET status = 'failed', error = 'stuck in processing (auto-cleaned)'
    WHERE status = 'processing'
      AND created_at < datetime('now', '-1 day')
  `);

  db.close();
  console.log(`  Updated ${updated} conversations, skipped ${skipped}`);
  console.log(`  Marked ${stuckResult.changes} stuck rows as failed`);
} else {
  console.log(`  [DRY-RUN] Would update conversations with session data`);
}

// ── Step 4: Summary ──────────────────────────────────────

console.log("\n=== Summary ===");
console.log(`  Entries: ${totalBefore} → ${totalAfter} (removed ${totalBefore - totalAfter})`);
console.log(`  Sessions with data: ${sessionEntries.size}`);

// Calculate totals from remaining entries
let sumIn = 0, sumOut = 0, sumCR = 0, sumCC = 0, sumCost = 0;
for (const entries of sessionEntries.values()) {
  for (const e of entries) {
    sumIn += e.in;
    sumOut += e.out;
    sumCR += e.cacheRead;
    sumCC += e.cacheCreate;
    sumCost += e.cost ?? 0;
  }
}
console.log(`  Input: ${sumIn.toLocaleString()}, Output: ${sumOut.toLocaleString()}`);
console.log(`  Cache read: ${sumCR.toLocaleString()}, Cache create: ${sumCC.toLocaleString()}`);
console.log(`  Estimated total cost: $${sumCost.toFixed(2)}`);
console.log(`\nDone! ${DRY_RUN ? "(DRY RUN — no changes)" : ""}`);
