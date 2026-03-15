#!/usr/bin/env bun
/**
 * One-time migration: ~/.remi/traces/*.jsonl → conversations DB table.
 *
 * Usage: bun run scripts/migrate-traces.ts [--dry-run]
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDb } from "../src/db/index.js";

const TRACES_DIR = join(homedir(), ".remi", "traces");
const DRY_RUN = process.argv.includes("--dry-run");

interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: string;
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
  events?: unknown[];
}

function readJsonlFile(filePath: string): SpanData[] {
  const content = readFileSync(filePath, "utf-8");
  const spans: SpanData[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      spans.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
  return spans;
}

function main() {
  if (!existsSync(TRACES_DIR)) {
    console.log("No traces directory found at", TRACES_DIR);
    return;
  }

  const files = readdirSync(TRACES_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .sort();

  if (files.length === 0) {
    console.log("No JSONL files found.");
    return;
  }

  console.log(`Found ${files.length} JSONL files in ${TRACES_DIR}`);

  const db = getDb();

  // Pre-load existing records for dedup: cli_session_id → created_at
  const existingRows = db.query(
    "SELECT cli_session_id, created_at FROM conversations WHERE cli_session_id IS NOT NULL"
  ).all() as Array<{ cli_session_id: string; created_at: string }>;

  const existingMap = new Map<string, number>();
  for (const row of existingRows) {
    existingMap.set(row.cli_session_id, new Date(row.created_at + "Z").getTime());
  }
  console.log(`Existing DB records with cli_session_id: ${existingMap.size}`);

  // Prepare insert statement
  const insertStmt = db.prepare(`
    INSERT INTO conversations (
      status, chat_id, sender_id, connector, cli_session_id, cli_cwd,
      cli_round_start, cli_round_end,
      cost_usd, duration_ms, model, input_tokens, output_tokens,
      spans, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = join(TRACES_DIR, file);
    const allSpans = readJsonlFile(filePath);

    // Group spans by traceId
    const traceMap = new Map<string, SpanData[]>();
    for (const span of allSpans) {
      const arr = traceMap.get(span.traceId) ?? [];
      arr.push(span);
      traceMap.set(span.traceId, arr);
    }

    for (const [_traceId, spans] of traceMap) {
      try {
        const rootSpan = spans.find(s => !s.parentSpanId);
        if (!rootSpan) { skipped++; continue; }

        const providerSpan = spans.find(s => s.operationName === "provider.chat");

        // Extract fields
        const chatId = (rootSpan.attributes["chat.id"] as string) ?? "";
        const connector = (rootSpan.attributes["connector.name"] as string) ?? "";
        const cliSessionId = providerSpan
          ? (providerSpan.attributes["session.id"] as string) ?? null
          : null;
        const model = providerSpan
          ? (providerSpan.attributes["llm.model"] as string) ?? null
          : null;
        const inputTokens = providerSpan
          ? (providerSpan.attributes["llm.input_tokens"] as number) ?? null
          : null;
        const outputTokens = providerSpan
          ? (providerSpan.attributes["llm.output_tokens"] as number) ?? null
          : null;
        const costUsd = providerSpan
          ? (providerSpan.attributes["llm.cost_usd"] as number) ?? null
          : null;

        const status = rootSpan.status === "ERROR" ? "failed" : "completed";
        const startTime = rootSpan.startTime;
        const endTime = rootSpan.endTime ?? startTime;
        const durationMs = rootSpan.durationMs ?? 0;

        // Dedup check: same cli_session_id + within 60s
        if (cliSessionId && existingMap.has(cliSessionId)) {
          const existingTs = existingMap.get(cliSessionId)!;
          const thisTs = new Date(startTime).getTime();
          if (Math.abs(existingTs - thisTs) < 60_000) {
            skipped++;
            continue;
          }
        }

        // Build spans summary (same format as core.ts writes)
        const spansSummary: Array<Record<string, unknown>> = [];
        for (const s of spans) {
          if (s === rootSpan) continue;
          const entry: Record<string, unknown> = {
            op: s.operationName,
            ms: s.durationMs ?? 0,
          };
          if (s.operationName === "provider.chat" && model) {
            entry.model = model;
            entry.tool_count = spans.filter(sp =>
              sp.operationName.startsWith("tool.") && sp.parentSpanId === s.spanId
            ).length;
          }
          spansSummary.push(entry);
        }

        if (!DRY_RUN) {
          insertStmt.run(
            status,
            chatId,
            null, // sender_id not in JSONL
            connector,
            cliSessionId,
            null, // cli_cwd not in JSONL
            startTime,
            endTime,
            costUsd,
            durationMs,
            model,
            inputTokens,
            outputTokens,
            JSON.stringify(spansSummary),
            startTime, // created_at = startTime
          );
        }

        inserted++;

        // Also add to dedup map for intra-file dedup
        if (cliSessionId) {
          existingMap.set(cliSessionId, new Date(startTime).getTime());
        }
      } catch (e) {
        errors++;
        if (errors <= 5) console.error(`  Error processing trace:`, e);
      }
    }

    console.log(`  ${file}: ${traceMap.size} traces processed`);
  }

  console.log(`\nDone${DRY_RUN ? " (DRY RUN)" : ""}!`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Errors:   ${errors}`);

  // Verify
  if (!DRY_RUN) {
    const count = db.query("SELECT COUNT(*) as cnt FROM conversations").get() as { cnt: number };
    console.log(`  Total conversations in DB: ${count.cnt}`);
  }
}

main();
