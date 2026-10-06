/** Offline operator planner. Reads private snapshots; never connects to a database. */
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { matchClaudeTask, matchCodexTask, parseNativeRecords, sha256, taskOutput, type RecoveryTask } from "./lib/native-trace-match.js";
import { convertCodexNativeTrace } from "./lib/native-trace-codex.js";
import { convertClaudeNativeTrace } from "./lib/native-trace-claude.js";
import { redactNativeTrace } from "./lib/native-trace-redaction.js";
import { prepareSessionArchive } from "../packages/daemon/src/agent-runtime/workspace/session-archive.js";
import { checkTraceFileLines, TRACE_FILE_FORMAT } from "../packages/contracts/src/trace-file.js";
import type { NativeTraceRecoveryTaskSnapshot } from "../packages/server/src/session-archive/native-recovery.js";
import type { MultiremiTaskTrace } from "../packages/contracts/src/session-archive.js";

const ALGORITHM = "native-trace-recovery-v1";
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const required = (name: string) => { const value = arg(name); if (!value) throw new Error(`--${name}= is required`); return resolve(value); };
const onlyIds = new Set(process.argv.filter(v => v.startsWith("--task-id=")).map(v => v.slice(10)));
const excludedIds = new Set(process.argv.filter(v => v.startsWith("--exclude-task-id=")).map(v => v.slice(18)));
const inputDir = required("input-dir"), outputDir = required("output-dir"), mapperPath = required("claude-mapper");
if (inputDir === outputDir || !lstatSync(inputDir).isDirectory() || lstatSync(inputDir).isSymbolicLink()) throw new Error("invalid snapshot directory");
mkdirSync(outputDir, { mode: 0o700 });
const json = (name: string) => JSON.parse(readFileSync(join(inputDir, name), "utf8"));
const identities = json("recovery-identities.json");
const sourceManifest = json("source-snapshots.json");
const childManifest: any[] = existsSync(join(inputDir, "subagent-snapshots.json")) ? json("subagent-snapshots.json") : [];
const runtimeDaemons: Record<string, string> = json("recovery-runtimes.json");
const anchors = new Map<string, any>(json("task-anchors.json").map((row: any) => [row.task_id, row]));
const candidates = new Map<string, any>(identities.candidates.map((row: any) => [row.task.id, row]));
const mapperHash = sha256(readFileSync(mapperPath));
const recoveryCodeHashes = Object.fromEntries(["native-trace-match.ts", "native-trace-codex.ts", "native-trace-claude.ts", "native-trace-claude-system.ts", "native-trace-redaction.ts"]
  .map(name => [name, sha256(readFileSync(join(import.meta.dir, "lib", name)))]));
const bridge = await import(pathToFileURL(mapperPath).href);
if (typeof bridge.toAcpNotifications !== "function") throw new Error("fixed Claude bridge lacks the history mapper");
const taskShape = (t: any): RecoveryTask => ({ id: t.id, provider: t.provider, workspaceId: t.workspace_id, runtimeId: t.runtime_id, agentId: t.agent_id,
  nativeSessionId: t.session_id, workDir: t.work_dir, prompt: anchors.get(t.id)?.prompt ?? "", output: taskOutput(anchors.get(t.id)?.result),
  status: t.status, startedAt: t.started_at, completedAt: t.completed_at, notBeforeAt: t.dispatched_at ?? t.created_at });
const allTasks = [...candidates.values()].map(row => taskShape(row.task));
const taskSnapshot = (t: any): NativeTraceRecoveryTaskSnapshot => ({ taskId: t.id, workspaceId: t.workspace_id, agentId: t.agent_id,
  runtimeId: t.runtime_id, provider: t.provider, status: t.status, issueId: t.issue_id, issueSessionId: t.issue_session_id,
  chatSessionId: t.chat_session_id, sessionId: t.session_id, startedAt: t.started_at, completedAt: t.completed_at,
  failedAt: t.failed_at, cancelledAt: t.cancelled_at, updatedAt: t.updated_at });
const pointer = (p: any): MultiremiTaskTrace => ({ taskId: p.task_id, location: p.location, runtimeId: p.runtime_id, archiveId: p.archive_id,
  memberPath: p.member_path, dataOffset: p.data_offset == null ? null : Number(p.data_offset), compressedSize: p.compressed_size == null ? null : Number(p.compressed_size),
  uncompressedSize: p.uncompressed_size == null ? null : Number(p.uncompressed_size), sha256: p.sha256, eventCount: p.event_count == null ? null : Number(p.event_count),
  headSeq: p.head_seq == null ? null : Number(p.head_seq), closed: p.closed == null ? null : Boolean(Number(p.closed)), updatedAt: p.updated_at });
const report: any = { schema: 1, algorithmVersion: ALGORITHM, createdAt: new Date().toISOString(), mapperHash, recoveryCodeHashes, prepared: [], skipped: [], redactions: 0 };
const plans: any[] = [];
const seen = new Set<string>();
function verifiedSnapshot(source: any): Buffer {
  const actual = realpathSync(source.snapshotPath);
  const rel = relative(realpathSync(inputDir), actual);
  if (rel.startsWith("..") || isAbsolute(rel) || lstatSync(source.snapshotPath).isSymbolicLink() || !lstatSync(source.snapshotPath).isFile()) throw new Error("source snapshot escapes input directory");
  const bytes = readFileSync(actual);
  if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) throw new Error("source snapshot hash changed");
  return bytes;
}
for (const source of sourceManifest.snapshots) {
  const ids = source.taskIds.filter((id: string) => candidates.has(id) && !excludedIds.has(id) && (!onlyIds.size || onlyIds.has(id)));
  if (!ids.length) continue;
  const bytes = verifiedSnapshot(source);
  const records = parseNativeRecords(bytes.toString("utf8"));
  for (const id of ids) {
    seen.add(id);
    const row = candidates.get(id), t = row.task, task = taskShape(t);
    try {
      if (!/^tsk_[a-z0-9]+$/.test(id) || !runtimeDaemons[t.runtime_id]) throw new Error("unsupported task or runtime identity");
      const siblings = allTasks.filter(t => t.nativeSessionId === task.nativeSessionId);
      const children = childManifest.filter(source => source.taskId === id).map(source => ({ sourceId: source.sourcePath, sourceSha256: source.sha256,
        agentId: source.agentId, parentToolUseId: source.parentToolUseId, records: parseNativeRecords(verifiedSnapshot(source).toString("utf8")) }));
      const match = task.provider === "codex" ? matchCodexTask(records, task, siblings) : matchClaudeTask(records, task, siblings, children);
      const converted = task.provider === "codex"
        ? convertCodexNativeTrace(match.records.map(r => r.value), { providerSessionId: task.nativeSessionId, turnIds: match.proof.turnIds })
        : convertClaudeNativeTrace(match.records.map(r => r.value), { providerSessionId: task.nativeSessionId, toAcpNotifications: bridge.toAcpNotifications, mapperVersion: `sha256:${mapperHash}` });
      const text = converted.events.filter(e => e.type === "text").map(e => e.content ?? "").join("");
      if (match.proof.outputMatch === "all-assistant-text" && text !== task.output) throw new Error("converted_output_anchor_mismatch");
      if (match.proof.outputMatch === "final-answer") {
        const final = converted.events.filter(e => e.type === "text" && e.meta?.phase === "final").map(e => e.content ?? "").join("");
        if (final !== task.output && converted.events.filter(e => e.type === "text").at(-1)?.content !== task.output) throw new Error("converted_final_output_anchor_mismatch");
      }
      if (!converted.events.length) throw new Error("empty_converted_trace");
      const redacted = redactNativeTrace(converted.events);
      const events = redacted.events;
      const sessionId = t.issue_session_id ?? t.chat_session_id ?? t.id;
      if (!/^[A-Za-z0-9_.:-]+$/.test(sessionId)) throw new Error("invalid session id");
      const taskRoot = join(outputDir, "tasks", id);
      const runtimeRoot = join(taskRoot, "data", ".runtime", sessionId);
      const traces = join(runtimeRoot, "traces");
      mkdirSync(traces, { recursive: true, mode: 0o700 });
      const eventLines = events.map(e => JSON.stringify(e));
      const lines = [JSON.stringify({ format: TRACE_FILE_FORMAT, task_id: id, session_id: sessionId, agent_id: t.agent_id, provider: t.provider, runtime_id: t.runtime_id, started_at: t.started_at }),
        ...eventLines, JSON.stringify({ end: { status: t.status, head: events.length, event_count: events.length, ended_at: t.completed_at } })];
      const checked = checkTraceFileLines(lines, { taskId: id, sessionId });
      if (!checked.ok || !checked.value.closed) throw new Error("generated_trace_invalid");
      writeFileSync(join(traces, `${id}.jsonl`), lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
      const subject = t.issue_id ? { kind: "issue" as const, id: t.issue_id } : t.chat_session_id ? { kind: "chat" as const, id: t.chat_session_id } : { kind: "task" as const, id };
      const prepared = await prepareSessionArchive(join(taskRoot, "data"), { subject, providerRoots: [{ sessionId, root: runtimeRoot }], storageBoundary: join(taskRoot, "data"), stagingRoot: join(taskRoot, "data", ".multiremi", "archive-staging") });
      const proof = { sourceSha256: source.sha256, sourceBytes: source.bytes, nativeSessionId: task.nativeSessionId, nativeTurnIds: match.proof.turnIds,
        taskIdentityEvidence: [match.proof.method, `prompt_sha256:${match.proof.promptSha256}`, `output_sha256:${match.proof.outputSha256}`, `output_match:${match.proof.outputMatch}`, `source_path_sha256:${sha256(source.sourcePath)}`, `claude_mapper_sha256:${mapperHash}`, `redactions:${redacted.redactions}`,
          ...Object.entries(recoveryCodeHashes).map(([name, hash]) => `recovery_code_sha256:${name}:${hash}`),
          ...(match.proof.additionalSources ?? []).map(child => `child_source:${JSON.stringify({ sha256: child.sourceSha256, sourcePathSha256: sha256(child.sourceId), agentId: child.agentId, parentToolUseId: child.parentToolUseId, firstLine: child.firstLine, lastLine: child.lastLine, promptSha256: child.promptSha256 })}`)],
        sourceStartLine: match.proof.firstLine, sourceEndLine: match.proof.lastLine, recoveredEventKinds: [...new Set(events.map(e => e.type))],
        omissions: ["Original streaming chunk boundaries and Remi seq numbers are not recoverable.", "Daemon-only execution/permission/question/steer events without provider-native evidence are not invented.",
          "Historical task status, usage and original card statistics are preserved.", ...(redacted.redactions ? [`${redacted.redactions} credential occurrences were redacted.`] : []),
          ...(task.provider === "claude" ? [`Claude mapper sha256:${mapperHash}; auxiliary and empty/encrypted records counted in the conversion audit.`] : ["Native auxiliary usage snapshots do not replace recorded task usage."])],
        missingTrace: { checkedAt: identities.captured_at, reason: "normalized_file_absent" as const } };
      const plan = { workspaceId: t.workspace_id, subject, runtimeId: t.runtime_id, daemonId: runtimeDaemons[t.runtime_id],
        archivePath: prepared.archivePath, sourceRevision: prepared.sourceRevision, sha256: prepared.sha256, sizeBytes: prepared.sizeBytes, fileCount: prepared.fileCount,
        algorithmVersion: ALGORITHM, tasks: [{ task: taskSnapshot(t), expectedPointer: pointer(row.trace_pointer), evidence: proof }], taskId: id,
        expectedTraceDigest: sha256(eventLines.join("\n") + "\n"), expectedEventCount: events.length };
      plans.push(plan);
      report.prepared.push({ taskId: id, provider: task.provider, proof: match.proof, events: events.length, coverage: converted.coverage,
        redactions: redacted.redactions, archiveSha256: prepared.sha256, sourceSha256: source.sha256, sourcePathSha256: sha256(source.sourcePath) });
      report.redactions += redacted.redactions;
    } catch (error) {
      report.skipped.push({ taskId: id, provider: task.provider, reason: error instanceof Error ? error.message : "unknown", ...(error && typeof error === "object" && "coverage" in error ? { coverage: error.coverage } : {}) });
    }
  }
  if (seen.size % 40 < ids.length) console.log(JSON.stringify({ seen: seen.size, prepared: plans.length, skipped: report.skipped.length }));
  Bun.gc(true);
}
for (const task of allTasks) if (!excludedIds.has(task.id) && (!onlyIds.size || onlyIds.has(task.id)) && !seen.has(task.id)) report.skipped.push({ taskId: task.id, provider: task.provider, reason: "source_unavailable" });
for (const [name, digest] of Object.entries(recoveryCodeHashes)) {
  if (sha256(readFileSync(join(import.meta.dir, "lib", name))) !== digest) throw new Error("recovery code changed while preparing; rebuild the plan");
}
if (sha256(readFileSync(mapperPath)) !== mapperHash) throw new Error("Claude bridge changed while preparing; rebuild the plan");
writeFileSync(join(outputDir, "plans.json"), JSON.stringify({ schema: 1, algorithmVersion: ALGORITHM, plans }), { flag: "wx", mode: 0o600 });
writeFileSync(join(outputDir, "report.json"), JSON.stringify(report), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ outputDir, prepared: plans.length, skipped: report.skipped.length, redactions: report.redactions,
  skippedReasons: report.skipped.reduce((a: Record<string, number>, r: any) => { a[r.reason] = (a[r.reason] ?? 0) + 1; return a; }, {}) }));
