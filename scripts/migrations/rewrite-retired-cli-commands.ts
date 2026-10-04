#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { RETIRED_CLI_COMMANDS } from "../../apps/remi/cli/core/retired-commands.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createId } from "@multiremi/ids.js";

export interface RewriteCandidate {
  entity: "workspace" | "agent" | "squad";
  id: string;
  workspaceId: string;
  field: string;
  /** updated_at is the version of agent/squad rows, which have no numeric version column. */
  expected_version: string;
  expected_revision?: number;
  original: string;
  replacement: string;
  storedValue: string;
}
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const paths = Object.keys(RETIRED_CLI_COMMANDS).sort((a, b) => b.length - a.length);
const commandPattern = new RegExp(`\\bremi\\s+(${paths.map((p) => p.split(" ").map(escapeRegex).join("\\s+")).join("|")})(?![\\w-])`, "g");

export function rewriteText(text: string): string {
  const replace = (command: string) => command.replace(commandPattern, (_matched, spelling: string) =>
    RETIRED_CLI_COMMANDS[spelling.replace(/\s+/g, " ")]!);
  return text.split("\n").map((line) => {
    // Use complete reviewed templates. Legacy seq/task/request ids cannot be
    // translated to message/turn ids by a free-text migration.
    const rewritten = line.replace(/`(remi\s+[^`]+)`/g, (span, command: string) => {
      commandPattern.lastIndex = 0;
      const match = commandPattern.exec(command);
      return match?.index === 0 ? `\`${RETIRED_CLI_COMMANDS[match[1]!.replace(/\s+/g, " ")]}\`` : span;
    });
    commandPattern.lastIndex = 0;
    const match = commandPattern.exec(rewritten);
    if (!match) return rewritten;
    if (/^\s*(?:\$\s*)?remi\s/.test(rewritten)) {
      return rewritten.slice(0, match.index) + RETIRED_CLI_COMMANDS[match[1]!.replace(/\s+/g, " ")];
    }
    const suffix = rewritten.slice(match.index + match[0].length);
    if (/^\s+(?:--|<|[a-z]+_|[A-Z]+-\d|\d)/.test(suffix)) {
      throw new Error("Ambiguous embedded legacy command: put the complete invocation in backticks before rewriting");
    }
    return replace(rewritten);
  }).join("\n");
}

export function scanRewriteCandidates(db: SqlDatabase): RewriteCandidate[] {
  const candidates: RewriteCandidate[] = [];
  const workspaces = db.query("SELECT id, settings, updated_at FROM multiremi_workspaces ORDER BY id").all() as Array<{ id: string; settings: string; updated_at: string }>;
  for (const row of workspaces) {
    const settings = JSON.parse(row.settings) as Record<string, unknown>;
    const original = settings.prompt_bootstrap_appendix;
    if (typeof original !== "string") continue;
    const replacement = rewriteText(original);
    if (replacement !== original) candidates.push({ entity: "workspace", id: row.id, workspaceId: row.id,
      field: "settings.prompt_bootstrap_appendix", expected_version: row.updated_at,
      expected_revision: Number(settings.prompt_revision ?? 0), original, replacement, storedValue: row.settings });
  }
  for (const entity of ["agent", "squad"] as const) {
    const table = entity === "agent" ? "multiremi_agents" : "multiremi_squads";
    const rows = db.query(`SELECT id, name, workspace_id, instructions, updated_at FROM ${table} ORDER BY id`).all() as Array<{ id: string; name: string; workspace_id: string; instructions: string; updated_at: string }>;
    for (const row of rows) {
      if (entity === "agent" && ["Remi", "Remi-CC"].includes(row.name)) continue;
      const replacement = rewriteText(row.instructions);
      if (replacement !== row.instructions) candidates.push({ entity, id: row.id, workspaceId: row.workspace_id,
        field: "instructions", expected_version: row.updated_at, original: row.instructions, replacement, storedValue: row.instructions });
    }
  }
  return candidates;
}

export function printRewritePlan(candidates: readonly RewriteCandidate[], print: (line: string) => void = console.log): void {
  for (const candidate of candidates) {
    const original = candidate.original.split("\n"), replacement = candidate.replacement.split("\n");
    for (let line = 0; line < original.length; line++) {
      if (original[line] !== replacement[line]) print(JSON.stringify({
        "实体": `${candidate.entity}:${candidate.id}`, "字段": candidate.field,
        "原句": original[line], "建议替换": replacement[line],
      }));
    }
  }
}

export function executeRewrite(db: SqlDatabase, candidate: RewriteCandidate, actor: string, timestamp = new Date().toISOString()): void {
  db.transaction(() => {
    let changed: number;
    if (candidate.entity === "workspace") {
      const settings = JSON.parse(candidate.storedValue);
      if (Number(settings.prompt_revision ?? 0) !== candidate.expected_revision) throw new Error("Invalid expected_revision");
      settings.prompt_bootstrap_appendix = candidate.replacement;
      settings.prompt_revision = candidate.expected_revision! + 1;
      settings.prompt_updated_at = timestamp;
      settings.prompt_updated_by = actor;
      changed = db.run("UPDATE multiremi_workspaces SET settings = ?, updated_at = ? WHERE id = ? AND updated_at = ? AND settings = ?",
        [JSON.stringify(settings), timestamp, candidate.id, candidate.expected_version, candidate.storedValue]).changes;
    } else {
      const table = candidate.entity === "agent" ? "multiremi_agents" : "multiremi_squads";
      changed = db.run(`UPDATE ${table} SET instructions = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND updated_at = ? AND instructions = ?`,
        [candidate.replacement, timestamp, candidate.id, candidate.workspaceId, candidate.expected_version, candidate.storedValue]).changes;
    }
    if (changed !== 1) throw new Error(`rewrite_conflict: ${candidate.entity}:${candidate.id} changed after scan`);
    // Processed system events are durable activity evidence, never automation triggers.
    db.run(`INSERT INTO multiremi_system_events
      (id, workspace_id, resource, event, resource_id, payload, status, available_at, created_at, processed_at)
      VALUES (?, ?, ?, 'retired_cli_commands_rewritten', ?, ?, 'processed', ?, ?, ?)`,
      [createId("sev"), candidate.workspaceId, candidate.entity, candidate.id, JSON.stringify({
        actor_id: actor, field: candidate.field, expected_version: candidate.expected_version,
        expected_revision: candidate.expected_revision, before_sha256: digest(candidate.original), after_sha256: digest(candidate.replacement),
      }), timestamp, timestamp, timestamp]);
  })();
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export async function main(args = process.argv.slice(2)): Promise<void> {
  const execute = args.includes("--execute"), dryRun = args.includes("--dry-run");
  if (execute === dryRun) throw new Error("Choose exactly one of --dry-run or --execute");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (["--dry-run", "--execute"].includes(arg)) continue;
    if (!["--sqlite", "--actor"].includes(arg) || !args[index + 1] || args[index + 1]!.startsWith("--")) {
      throw new Error(`Invalid argument ${arg}`);
    }
    index++;
  }
  const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const sqlite = value("--sqlite"), url = process.env.MULTIREMI_DATABASE_URL?.trim();
  if (!sqlite && !url) throw new Error("Supply --sqlite <existing-file> or MULTIREMI_DATABASE_URL; this script never initializes a database");
  const actor = value("--actor") ?? "operator:retired-cli-rewrite";
  const db: SqlDatabase = sqlite ? openSqliteDatabase(sqlite, { readonly: dryRun, create: false }) as unknown as SqlDatabase : new PostgresSyncDatabase(url!);
  try {
    const candidates = scanRewriteCandidates(db);
    printRewritePlan(candidates);
    if (execute) for (const candidate of candidates) executeRewrite(db, candidate, actor);
    console.log(`${dryRun ? "dry-run" : "execute"}: ${candidates.length} entities; ${dryRun ? "0 writes" : "optimistic writes and activity recorded"}`);
  } finally { db.close(); }
}
if (import.meta.main) await main();
