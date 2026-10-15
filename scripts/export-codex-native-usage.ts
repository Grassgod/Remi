/**
 * Read-only export of Codex per-request usage from native rollouts on a daemon
 * host, for the reviewed backfill in reconcile-task-usage.ts --native-evidence.
 * Writes only --out: counters, thread/response IDs, timestamps and models,
 * never transcript content. Rollouts stay on the daemon (ADR 0018).
 */
import { readdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { TaskUsageUnit } from "../packages/contracts/src/usage-accounting.js";
import { parseNativeUsageEvidence } from "./usage-evidence.js";

export const CODEX_NATIVE_USAGE_EXPORT_KIND = "remi.codex-native-usage";
export interface CodexNativeRequestEvidence {
  /** Codex `session_id`: the root thread, which is the Remi attempt's session. */
  rootSessionId: string;
  unit: TaskUsageUnit;
}
export interface CodexNativeUsageExport {
  version: 1; kind: typeof CODEX_NATIVE_USAGE_EXPORT_KIND; generatedAt: string; host: string;
  sources: string[]; since: string | null;
  counts: { files: number; requests: number; rejected: number; replayed: number; unreadable: number; beforeSince: number };
  files: Array<{ ref: string; requests: number; rejected: number; replayed: number }>;
  requests: CodexNativeRequestEvidence[];
}

// Provider homes per daemon layout: v0.2.89 `.runtime/<subject>/<agent>/…/home`,
// ADR 0018 `env/<subject>/…/home`, and the upgrade sweep's `legacy-<date>/`.
const RUNTIME_TOP_LEVEL = (name: string) => name === ".runtime" || name === "env" || /^legacy-/.test(name);
// Agent work trees and provider caches never hold native session history.
const SKIPPED = new Set([".git", "node_modules", "work", "task-tmp", "tmp", ".tmp", "plugins", "vendor_imports", "skills",
  "cache", ".cache", "memories", "memories_v2", "projects", "traces", "registry", "shared", "wiki"]);
const MAX_DEPTH = 16;
const isRollout = (name: string) => name.startsWith("rollout-") && name.endsWith(".jsonl");

async function collectRollouts(root: string, workspaces: boolean): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number, inHistory: boolean): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      // Never follow links out of the scanned tree.
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isFile() && isRollout(entry.name) && (inHistory || !workspaces)) found.push(path);
      if (!entry.isDirectory()) continue;
      if (workspaces && depth === 0 && !RUNTIME_TOP_LEVEL(entry.name)) continue;
      if (SKIPPED.has(entry.name)) continue;
      await walk(path, depth + 1, inHistory || entry.name === "sessions" || entry.name === "archived_sessions");
    }
  };
  await walk(resolve(root), 0, false);
  return found.sort();
}

export async function exportCodexNativeUsage(options: {
  workspacesRoots?: string[]; scanDirs?: string[]; since?: string | null; host?: string; now?: Date;
}): Promise<CodexNativeUsageExport> {
  const since = options.since ? new Date(options.since).toISOString() : null;
  const host = options.host ?? hostname();
  const result: CodexNativeUsageExport = {
    version: 1, kind: CODEX_NATIVE_USAGE_EXPORT_KIND, generatedAt: (options.now ?? new Date()).toISOString(), host, since,
    sources: [], counts: { files: 0, requests: 0, rejected: 0, replayed: 0, unreadable: 0, beforeSince: 0 }, files: [], requests: [],
  };
  const roots = [...(options.workspacesRoots ?? []).map(root => ({ root, workspaces: true })),
    ...(options.scanDirs ?? []).map(root => ({ root, workspaces: false }))];
  for (const [index, { root, workspaces }] of roots.entries()) {
    // Refs name the host and a path relative to the scanned root, not the host's absolute layout.
    const label = `${workspaces ? "workspaces" : "scan"}${index}`;
    result.sources.push(`${label}=${resolve(root)}`);
    for (const path of await collectRollouts(root, workspaces)) {
      const ref = `native:${host}:${label}/${relative(resolve(root), path).split(sep).join("/")}`;
      let body: string;
      try { body = await readFile(path, "utf8"); } catch { result.counts.unreadable++; continue; }
      result.counts.files++;
      const parsed = parseNativeUsageEvidence("codex", body, ref);
      const roots = new Map((parsed.sourceScopes ?? []).filter(scope => scope.kind === "request").map(scope => [scope.unitId, scope.rootSessionId]));
      let requests = 0;
      for (const unit of parsed.units) {
        if (unit.identityKind !== "request" || !unit.providerSessionId || !unit.providerRequestId) continue;
        if (since && unit.occurredAt < since) { result.counts.beforeSince++; continue; }
        result.requests.push({ rootSessionId: roots.get(unit.unitId) ?? unit.providerSessionId, unit });
        requests++;
      }
      result.counts.requests += requests;
      result.counts.rejected += parsed.rejected;
      result.counts.replayed += parsed.replayed;
      result.files.push({ ref, requests, rejected: parsed.rejected, replayed: parsed.replayed });
    }
  }
  return result;
}

if (import.meta.main) {
  const values = (name: string) => process.argv.filter(arg => arg.startsWith(`--${name}=`)).map(arg => arg.slice(name.length + 3));
  const out = values("out")[0];
  const workspacesRoots = values("workspaces-root"), scanDirs = values("scan");
  if (!out || (!workspacesRoots.length && !scanDirs.length)) {
    console.error("Usage: bun run scripts/export-codex-native-usage.ts --workspaces-root=<daemon workspaces root> [--scan=<CODEX_HOME or extracted archive>] [--since=<ISO>] --out=<file.json>");
    process.exit(2);
  }
  const exported = await exportCodexNativeUsage({ workspacesRoots, scanDirs, since: values("since")[0] ?? null });
  await Bun.write(out, JSON.stringify(exported));
  process.stdout.write(`${JSON.stringify({ out, host: exported.host, since: exported.since, sources: exported.sources, counts: exported.counts }, null, 2)}\n`);
}
