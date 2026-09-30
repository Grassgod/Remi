import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { PostgresSyncDatabase, type SqlDatabase } from "../packages/server/src/store/db/postgres.js";
import { reconcileConversationLog, type ConversationBackfillReport, type ConversationReconciliation } from "../packages/server/src/store/conversation-log-backfill.js";

export interface ConversationMigrationEvidence {
  generatedAt: string;
  scope: string;
  runs: Array<{ label: string; migration?: ConversationBackfillReport; startupMs?: number; secondStartupMs?: number;
    reconciliation: ConversationReconciliation }>;
}

export interface ConversationReconciliationTarget { sqlite?: string; pgEnv?: string }

/** Opens the selected target exactly the way the CLI does: SQLite read-only, Postgres behind the sync bridge. */
export function openConversationLogTarget(target: ConversationReconciliationTarget): SqlDatabase {
  return target.sqlite
    ? openSqliteDatabase(target.sqlite, { readonly: true })
    : new PostgresSyncDatabase(process.env[target.pgEnv!]!);
}

/** Runs `run` inside the read-only transaction that guards every reconciliation read. */
export function readOnlyConversationTransaction<T>(db: SqlDatabase, run: () => T): T {
  return db.transaction(() => {
    if (db instanceof PostgresSyncDatabase) db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return run();
  })();
}

export function readOnlyConversationReconciliation(db: SqlDatabase): ConversationReconciliation {
  return readOnlyConversationTransaction(db, () => reconcileConversationLog(db));
}

function reportMarkdown(evidence: ConversationMigrationEvidence): string {
  const lines = ["# MUL-402 conversation log reconciliation", "", evidence.scope, "", `Generated: ${evidence.generatedAt}`,
    "", "Authority: MUL-427; cmt_gestk2r6imjh (f)(g), cmt_o1oocq58vsbg (s), Senior cmt_u7m8e7yitmai.",
    "", "Counts and digests are read from synthetic/local sources. The reconciliation command opens no Store and runs no migrations.",
    "Hash: SHA-256 over canonical tuples of mapped kind, author type/id, raw body, created_at, task_id and parent_id.",
    "Comment task ids come from comments (NULL for tombstones), other Issue rows from events, Chat rows from messages, heads from NULL.",
    "JSON metadata is parsed in Bun, without SQL JSON casts; marker targets and tombstones are checked separately."];
  for (const run of evidence.runs) {
    lines.push("", `## ${run.label}`, "", `Mismatch: **${run.reconciliation.mismatches.length}**`, "");
    if (run.startupMs != null) lines.push(`Cold startup: ${run.startupMs.toFixed(2)} ms; second startup: ${run.secondStartupMs?.toFixed(2)} ms.`, "");
    lines.push("| Counter | Reconciliation | Migration |", "| --- | ---: | ---: |");
    for (const [key, value] of Object.entries(run.reconciliation.counts)) {
      lines.push(`| ${key} | ${value} | ${run.migration?.counts[key as keyof typeof run.migration.counts] ?? "n/a"} |`);
    }
    const sessions = run.reconciliation.sessions;
    lines.push("", `Sessions: ${sessions.length}; expected rows: ${sessions.reduce((sum, row) => sum + row.expectedCount, 0)}; actual rows: ${sessions.reduce((sum, row) => sum + row.actualCount, 0)}.`,
      `Equal session digests: ${sessions.filter((row) => row.sourceDigest === row.logDigest).length}/${sessions.length}.`,
      "", "Orphan dispositions and Chat sequence remaps are listed in the JSON report; all per-session source/log digests are included.");
    if (run.reconciliation.mismatches.length) lines.push("", "```json", JSON.stringify(run.reconciliation.mismatches, null, 2), "```");
  }
  return lines.join("\n") + "\n";
}

export async function writeConversationMigrationEvidence(base: string, evidence: ConversationMigrationEvidence): Promise<void> {
  await mkdir(dirname(base), { recursive: true });
  const markdown = reportMarkdown(evidence);
  await Bun.write(`${base}.json`, JSON.stringify(evidence, null, 2) + "\n");
  await Bun.write(`${base}.md`, markdown);
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  await Bun.write(`${base}.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MUL-427 migration evidence</title><style>body{margin:0;color:#20242a;background:#f7f8fa;font:14px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}h1{font-size:22px}</style><main><h1>MUL-427 migration evidence</h1><pre>${escape(markdown)}</pre></main></html>\n`);
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    sqlite: { type: "string" }, "postgres-env": { type: "string" }, out: { type: "string" }, help: { type: "boolean" },
  } });
  const sqlite = values.sqlite;
  const pgEnv = values["postgres-env"];
  const out = values.out ?? `reports/migrations/MUL-402-conversation-log-${new Date().toISOString().slice(0, 10)}`;
  if ((!sqlite && !pgEnv) || (sqlite && pgEnv) || values.help) {
    console.log("Usage: bun run scripts/reconcile-conversation-log.ts (--sqlite PATH | --postgres-env ENV_NAME) [--out REPORT_BASE]");
    process.exit(values.help ? 0 : 2);
  }
  if (pgEnv && !process.env[pgEnv]) throw new Error("The selected PostgreSQL environment variable is not set");
  const db = openConversationLogTarget({ sqlite, pgEnv });
  try {
    const reconciliation = readOnlyConversationReconciliation(db);
    await writeConversationMigrationEvidence(out, { generatedAt: new Date().toISOString(), scope: "Read-only reconciliation; no data exported except ids, counts and digests.",
      runs: [{ label: sqlite ? "SQLite" : "PostgreSQL", reconciliation }] });
    console.log(JSON.stringify({ mismatch: reconciliation.mismatches.length, reports: [`${out}.json`, `${out}.md`, `${out}.html`] }));
    process.exitCode = reconciliation.mismatches.length ? 1 : 0;
  } finally { db.close(); }
}
