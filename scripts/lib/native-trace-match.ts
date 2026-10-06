import { createHash } from "node:crypto";
import { claudeInformationalText } from "./native-trace-claude-system.js";

/** Native recovery uses task identities and exact content anchors, never time alone. */
export interface RecoveryTask {
  id: string;
  provider: "codex" | "claude";
  workspaceId: string;
  runtimeId: string;
  agentId: string;
  nativeSessionId: string;
  workDir: string;
  prompt: string;
  output: string;
  status: string;
  startedAt: string;
  completedAt: string;
  /** Trusted server dispatch/creation boundary; native work may precede start acknowledgement. */
  notBeforeAt?: string;
}

export interface NativeRecord {
  line: number;
  value: Record<string, any>;
}

/** Caller verifies the immutable snapshot bytes against sourceSha256 first. */
export interface ClaudeNativeChildSource {
  sourceId: string;
  sourceSha256: string;
  agentId: string;
  parentToolUseId: string;
  records: NativeRecord[];
}

export interface ClaudeNativeChildProof {
  sourceId: string;
  sourceSha256: string;
  agentId: string;
  parentToolUseId: string;
  firstLine: number;
  lastLine: number;
  promptSha256: string;
}

export interface NativeMatch {
  records: NativeRecord[];
  proof: {
    method: "session-cwd-prompt-output-turn" | "session-cwd-prompt-output-parent-chain";
    taskId: string;
    nativeSessionId: string;
    turnIds: string[];
    firstLine: number;
    lastLine: number;
    promptSha256: string;
    outputSha256: string;
    outputMatch: "all-assistant-text" | "final-answer";
    nativeStartedAt: string;
    nativeCompletedAt: string;
    notBeforeAt?: string;
    compactionLinks?: { recordUuid: string; parentUuid: string }[];
    additionalSources?: ClaudeNativeChildProof[];
  };
}

export class NativeRecoveryMismatch extends Error {
  constructor(readonly code: string) { super(code); this.name = "NativeRecoveryMismatch"; }
}

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function parseNativeRecords(contents: string): NativeRecord[] {
  const lines = contents.split("\n");
  const records: NativeRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(lines[i]!); } catch { throw new NativeRecoveryMismatch(`invalid_jsonl_line:${i + 1}`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeRecoveryMismatch(`invalid_record:${i + 1}`);
    records.push({ line: i + 1, value: value as Record<string, any> });
  }
  return records;
}

export function taskOutput(result: unknown): string {
  if (typeof result !== "string") return "";
  try {
    const parsed = JSON.parse(result);
    return typeof parsed?.output === "string" ? parsed.output : "";
  } catch { return ""; }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.flatMap((part: any) => typeof part?.text === "string" ? [part.text] : []).join("") : "";
}

/** Preserve all executed parallel branches descending from the verified prompt. */
export function matchClaudeTask(records: NativeRecord[], task: RecoveryTask, siblings: RecoveryTask[], childSources: readonly ClaudeNativeChildSource[] = []): NativeMatch {
  assertTask(task);
  if (task.provider !== "claude") throw new NativeRecoveryMismatch("provider_mismatch");
  const byId = new Map<string, NativeRecord>();
  for (const record of records) {
    const id = record.value.uuid;
    if (typeof id !== "string") continue;
    const previous = byId.get(id);
    if (previous && JSON.stringify(previous.value) !== JSON.stringify(record.value)) throw new NativeRecoveryMismatch("conflicting_native_uuid");
    if (!previous) byId.set(id, record);
  }
  const from = nativeNotBefore(task), to = Date.parse(task.completedAt);
  const window = records.filter(({ value: r }) => Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) <= to + 5_000 && !r.isSidechain);
  const starts = window.filter(({ value: r }) => r.type === "user" && !r.isMeta && !r.isCompactSummary
    && textContent(r.message?.content).includes(task.prompt));
  if (starts.length !== 1) throw new NativeRecoveryMismatch(starts.length ? "ambiguous_prompt_anchor" : "prompt_anchor_mismatch");
  const start = starts[0]!;
  if (start.value.sessionId !== task.nativeSessionId) throw new NativeRecoveryMismatch("native_session_mismatch");
  if (start.value.cwd !== task.workDir) throw new NativeRecoveryMismatch("native_workdir_mismatch");
  const memo = new Map<string, boolean>();
  const compactionLinks = new Map<string, string>();
  const parentOf = (record: NativeRecord): NativeRecord | undefined => {
    const r = record.value;
    if (typeof r.parentUuid === "string") return byId.get(r.parentUuid);
    if (r.type !== "system" || r.subtype !== "compact_boundary" || !r.logicalParentUuid) return undefined;
    const parent = byId.get(r.logicalParentUuid);
    if (r.parentUuid !== null || typeof r.logicalParentUuid !== "string"
      || r.compactMetadata?.preservedSegment?.tailUuid !== r.logicalParentUuid
      || !parent || parent.value.sessionId !== task.nativeSessionId || r.sessionId !== task.nativeSessionId) {
      throw new NativeRecoveryMismatch("invalid_native_compaction_link");
    }
    compactionLinks.set(r.uuid, r.logicalParentUuid);
    return parent;
  };
  const descends = (record: NativeRecord): boolean => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let row: NativeRecord | undefined = record;
    let answer = false;
    while (row && typeof row.value.uuid === "string") {
      const id: string = row.value.uuid;
      if (seen.has(id)) throw new NativeRecoveryMismatch("native_parent_cycle");
      seen.add(id); chain.push(id);
      if (id === start.value.uuid) { answer = true; break; }
      if (memo.has(id)) { answer = memo.get(id)!; break; }
      row = parentOf(row);
    }
    for (const id of chain) memo.set(id, answer);
    return answer;
  };
  const selected = window.filter(descends).filter((row, i, rows) => rows.findIndex(r => r.value.uuid === row.value.uuid) === i);
  if (window.some(r => r.value.type === "assistant" && !descends(r) && r.line >= start.line)) throw new NativeRecoveryMismatch("unanchored_assistant_branch");
  if (selected.some(r => r.value.sessionId && r.value.sessionId !== task.nativeSessionId)) throw new NativeRecoveryMismatch("native_session_mismatch");
  // Claude's Bash may change cwd during a turn. The prompt's cwd and UUID
  // ancestry prove task identity; later cwd changes are execution evidence.
  const assistant = selected.filter(r => r.value.type === "assistant");
  if (!assistant.length) throw new NativeRecoveryMismatch("no_native_assistant_output");
  const linkedChildren = matchClaudeChildren(selected, task, childSources);
  const allSelected = [...selected, ...linkedChildren.records].sort((left, right) => Date.parse(left.value.timestamp) - Date.parse(right.value.timestamp) || left.line - right.line);
  const outputRecords = allSelected.filter(r => r.value.type === "assistant" || (r.value.type === "system" && r.value.subtype === "informational"));
  const texts = outputRecords.map(r => r.value.type === "assistant" ? textContent(r.value.message?.content) : claudeInformationalText(r.value)!).filter(Boolean);
  const bridgedCompaction = selected.some(r => compactionLinks.has(r.value.uuid));
  const startsBeforeAcknowledgedWindow = Date.parse(start.value.timestamp) < Date.parse(task.startedAt) - 5_000;
  const mode = texts.join("") === task.output ? "all-assistant-text"
    : !bridgedCompaction && !startsBeforeAcknowledgedWindow && !linkedChildren.proofs.length && texts.at(-1) === task.output ? "final-answer" : null;
  if (!mode) throw new NativeRecoveryMismatch("output_anchor_mismatch");
  const last = outputRecords.at(-1)!;
  for (const other of siblings) {
    if (other.id === task.id || other.nativeSessionId !== task.nativeSessionId) continue;
    if (Date.parse(start.value.timestamp) >= nativeNotBefore(other) && Date.parse(last.value.timestamp) <= Date.parse(other.completedAt) + 5_000
      && textContent(start.value.message?.content).includes(other.prompt) && (texts.join("") === other.output || texts.at(-1) === other.output)) {
      throw new NativeRecoveryMismatch("native_turn_matches_multiple_tasks");
    }
  }
  return { records: allSelected, proof: {
    method: "session-cwd-prompt-output-parent-chain", taskId: task.id, nativeSessionId: task.nativeSessionId,
    turnIds: [start.value.uuid], firstLine: start.line, lastLine: selected.at(-1)!.line,
    promptSha256: sha256(task.prompt), outputSha256: sha256(task.output), outputMatch: mode,
    nativeStartedAt: start.value.timestamp, nativeCompletedAt: last.value.timestamp,
    ...(task.notBeforeAt ? { notBeforeAt: task.notBeforeAt } : {}),
    ...(bridgedCompaction ? { compactionLinks: selected.filter(r => compactionLinks.has(r.value.uuid)).map(r => ({ recordUuid: r.value.uuid, parentUuid: compactionLinks.get(r.value.uuid)! })) } : {}),
    ...(linkedChildren.proofs.length ? { additionalSources: linkedChildren.proofs } : {}),
  } };
}

function matchClaudeChildren(parent: NativeRecord[], task: RecoveryTask, sources: readonly ClaudeNativeChildSource[]): { records: NativeRecord[]; proofs: ClaudeNativeChildProof[] } {
  const records: NativeRecord[] = [], proofs: ClaudeNativeChildProof[] = [];
  const parentIds = new Set(parent.map(r => r.value.uuid));
  const agentIds = new Set<string>(), sourceIds = new Set<string>();
  for (const source of sources) {
    if (!source.sourceId || !/^[a-f0-9]{64}$/.test(source.sourceSha256) || !source.agentId || !source.parentToolUseId
      || agentIds.has(source.agentId) || sourceIds.has(source.sourceId)) throw new NativeRecoveryMismatch("invalid_native_child_source");
    agentIds.add(source.agentId); sourceIds.add(source.sourceId);
    const calls = parent.flatMap(record => record.value.type === "assistant" && Array.isArray(record.value.message?.content)
      ? record.value.message.content.filter((block: any) => block.type === "tool_use" && block.id === source.parentToolUseId && ["Agent", "Task"].includes(block.name)).map((block: any) => ({ record, block })) : []);
    if (calls.length !== 1 || typeof calls[0]!.block.input?.prompt !== "string") throw new NativeRecoveryMismatch("native_child_parent_call_mismatch");
    const call = calls[0]!;
    const results = parent.filter(r => r.value.type === "user" && r.value.toolUseResult?.agentId === source.agentId
      && Array.isArray(r.value.message?.content) && r.value.message.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === source.parentToolUseId));
    if (results.length !== 1 || (results[0]!.value.sourceToolAssistantUUID && results[0]!.value.sourceToolAssistantUUID !== call.record.value.uuid)) {
      throw new NativeRecoveryMismatch("native_child_agent_link_mismatch");
    }
    const byId = new Map<string, NativeRecord>();
    for (const r of source.records) {
      if (typeof r.value.uuid !== "string") continue;
      if (parentIds.has(r.value.uuid)) throw new NativeRecoveryMismatch("native_child_uuid_collision");
      const prior = byId.get(r.value.uuid);
      if (prior && JSON.stringify(prior.value) !== JSON.stringify(r.value)) throw new NativeRecoveryMismatch("conflicting_native_uuid");
      if (!prior) byId.set(r.value.uuid, r);
      if (r.value.sessionId && r.value.sessionId !== task.nativeSessionId) throw new NativeRecoveryMismatch("native_child_session_mismatch");
      if (r.value.agentId && r.value.agentId !== source.agentId) throw new NativeRecoveryMismatch("native_child_agent_mismatch");
    }
    const first = source.records.find(r => r.value.type === "user" && !r.value.isMeta && !r.value.isCompactSummary);
    if (!first || first.value.sessionId !== task.nativeSessionId || first.value.agentId !== source.agentId || !first.value.isSidechain
      || textContent(first.value.message?.content) !== call.block.input.prompt) throw new NativeRecoveryMismatch("native_child_prompt_mismatch");
    if (first.value.cwd !== call.record.value.cwd) throw new NativeRecoveryMismatch("native_child_workdir_mismatch");
    const firstAt = Date.parse(first.value.timestamp), callAt = Date.parse(call.record.value.timestamp), end = Date.parse(task.completedAt);
    if (!Number.isFinite(firstAt) || firstAt < callAt || firstAt < nativeNotBefore(task) || firstAt > end) throw new NativeRecoveryMismatch("native_child_interval_mismatch");
    const descends = (r: NativeRecord): boolean => {
      let current: NativeRecord | undefined = r;
      const seen = new Set<string>();
      while (current && typeof current.value.uuid === "string") {
        if (seen.has(current.value.uuid)) throw new NativeRecoveryMismatch("native_parent_cycle");
        seen.add(current.value.uuid);
        if (current.value.uuid === first.value.uuid) return true;
        let parentId: unknown = current.value.parentUuid;
        if (parentId === null && current.value.type === "system" && current.value.subtype === "compact_boundary") {
          parentId = current.value.logicalParentUuid;
          const previous = typeof parentId === "string" ? byId.get(parentId) : undefined;
          if (!previous || previous.value.sessionId !== task.nativeSessionId || current.value.compactMetadata?.preservedSegment?.tailUuid !== parentId) {
            throw new NativeRecoveryMismatch("invalid_native_compaction_link");
          }
        }
        current = typeof parentId === "string" ? byId.get(parentId) : undefined;
      }
      return false;
    };
    const window = source.records.filter(r => Date.parse(r.value.timestamp) >= firstAt && Date.parse(r.value.timestamp) <= end + 5_000);
    if (window.some(r => r.value.type === "assistant" && !descends(r))) throw new NativeRecoveryMismatch("unanchored_child_assistant_branch");
    const selected = window.filter(descends).filter((r, i, rs) => rs.findIndex(o => o.value.uuid === r.value.uuid) === i);
    if (!selected.some(r => r.value.type === "assistant")) throw new NativeRecoveryMismatch("no_native_child_output");
    for (const r of selected) {
      if ((r.value.type === "assistant" || r.value.type === "user")
        && (r.value.sessionId !== task.nativeSessionId || r.value.agentId !== source.agentId || !r.value.isSidechain)) throw new NativeRecoveryMismatch("native_child_identity_mismatch");
      if (r.value.parent_tool_use_id && r.value.parent_tool_use_id !== source.parentToolUseId) throw new NativeRecoveryMismatch("native_child_parent_attribution_mismatch");
      parentIds.add(r.value.uuid);
      records.push({ ...r, value: { ...r.value, parent_tool_use_id: source.parentToolUseId,
        _remiNativeTraceSource: { sha256: source.sourceSha256, sourceId: source.sourceId, line: r.line, agentId: source.agentId } } });
    }
    proofs.push({ sourceId: source.sourceId, sourceSha256: source.sourceSha256, agentId: source.agentId, parentToolUseId: source.parentToolUseId,
      firstLine: selected[0]!.line, lastLine: selected.at(-1)!.line, promptSha256: sha256(call.block.input.prompt) });
  }
  return { records, proofs };
}

export function assertTask(task: RecoveryTask): void {
  if (task.status !== "completed") throw new NativeRecoveryMismatch("task_not_completed");
  if (!task.nativeSessionId || !task.workDir || !task.prompt.trim() || !task.output.trim()) throw new NativeRecoveryMismatch("missing_identity_or_content_anchor");
  if (!Number.isFinite(Date.parse(task.startedAt)) || !Number.isFinite(Date.parse(task.completedAt)) || Date.parse(task.startedAt) >= Date.parse(task.completedAt)) throw new NativeRecoveryMismatch("invalid_task_interval");
  if (task.notBeforeAt !== undefined && (!Number.isFinite(Date.parse(task.notBeforeAt)) || Date.parse(task.notBeforeAt) > Date.parse(task.startedAt))) {
    throw new NativeRecoveryMismatch("invalid_native_dispatch_boundary");
  }
}

function nativeNotBefore(task: RecoveryTask): number {
  // The legacy five-second acknowledgement allowance remains only when the
  // caller has no earlier trusted server timestamp. An explicit dispatch is a
  // strict lower bound, never a new or enlarged clock-skew tolerance.
  return task.notBeforeAt === undefined ? Date.parse(task.startedAt) - 5_000 : Date.parse(task.notBeforeAt);
}

interface CodexTurn {
  id: string;
  from: number;
  to: number;
  started: string;
  completed: string;
  users: string[];
  texts: string[];
  final: string;
  contextCwd?: string;
  endKind?: "completed" | "aborted";
  invalid?: string;
}

/** Inclusive native turns, matched to the server's task interval and two exact text anchors. */
export function matchCodexTask(records: NativeRecord[], task: RecoveryTask, siblings: RecoveryTask[]): NativeMatch {
  assertTask(task);
  if (task.provider !== "codex") throw new NativeRecoveryMismatch("provider_mismatch");
  const metas = records.filter(r => r.value.type === "session_meta");
  if (metas.length !== 1 || metas[0]!.value.payload?.id !== task.nativeSessionId) throw new NativeRecoveryMismatch("native_session_mismatch");
  const turns: CodexTurn[] = [];
  const byId = new Map<string, CodexTurn>();
  let current: CodexTurn | undefined;
  for (const row of records) {
    const { type, payload: p, timestamp } = row.value;
    if (type === "event_msg" && p?.type === "task_started") {
      if (current) current.invalid = "native_turn_missing_terminal";
      if (typeof p.turn_id !== "string") throw new NativeRecoveryMismatch("native_turn_id_missing");
      current = { id: p.turn_id, from: row.line, to: 0, started: timestamp, completed: "", users: [], texts: [], final: "" };
      if (byId.has(p.turn_id)) current.invalid = "duplicate_native_turn_id";
      byId.set(p.turn_id, current);
      turns.push(current);
    }
    if (!current) continue;
    if (type === "turn_context" && p?.turn_id === current.id && !current.contextCwd && typeof p.cwd === "string") current.contextCwd = p.cwd;
    if (type === "response_item" && p?.type === "message") {
      const text = textContent(p.content);
      if (p.role === "user") current.users.push(text);
      if (p.role === "assistant") current.texts.push(text);
    }
    if (type === "event_msg" && (p?.type === "task_complete" || p?.type === "turn_aborted")) {
      if (p.turn_id !== current.id) { current.invalid = "native_end_turn_mismatch"; continue; }
      current.to = row.line;
      current.completed = timestamp;
      current.final = typeof p.last_agent_message === "string" ? p.last_agent_message : "";
      current.endKind = p.type === "task_complete" ? "completed" : "aborted";
      current = undefined;
    }
  }
  const start = nativeNotBefore(task), end = Date.parse(task.completedAt);
  const relevant = turns.filter(t => Date.parse(t.started) >= start && Date.parse(t.started) <= end);
  const selected = relevant.filter(t => t.endKind && Date.parse(t.completed) <= end + 5_000 && Date.parse(t.completed) >= Date.parse(t.started));
  if (!selected.length || selected.at(-1)!.endKind !== "completed") throw new NativeRecoveryMismatch("no_complete_native_turn");
  if (relevant.some(t => !selected.includes(t))) throw new NativeRecoveryMismatch("native_turn_missing_terminal");
  for (const turn of selected) if (turn.invalid) throw new NativeRecoveryMismatch(turn.invalid);
  if (selected.some(t => (t.contextCwd ?? metas[0]!.value.payload?.cwd) !== task.workDir)) throw new NativeRecoveryMismatch("native_workdir_mismatch");
  if (!selected[0]!.users.some(text => text.includes(task.prompt))) throw new NativeRecoveryMismatch("prompt_anchor_mismatch");
  // A completed tool from an aborted turn can be written after the next turn
  // has started. Preserve the whole verified chain and use its explicit IDs,
  // not whichever turn happened to be the most recent task_started record.
  const chosen = records.filter(row => row.line >= selected[0]!.from && row.line <= selected.at(-1)!.to);
  const allowedTurns = new Set(selected.map(t => t.id));
  for (const record of chosen) {
    const p = record.value.payload;
    if (typeof p?.turn_id === "string" && !allowedTurns.has(p.turn_id)) throw new NativeRecoveryMismatch("interleaved_native_turns");
    if (typeof p?.thread_id === "string" && p.thread_id !== task.nativeSessionId) throw new NativeRecoveryMismatch("native_session_mismatch");
    if (record.value.type === "event_msg" && p?.type === "item_completed" && (!allowedTurns.has(p.turn_id) || p.thread_id !== task.nativeSessionId)) {
      throw new NativeRecoveryMismatch("native_item_identity_missing");
    }
  }
  const allText = chosen.filter(r => r.value.type === "response_item" && r.value.payload?.type === "message" && r.value.payload?.role === "assistant")
    .map(r => textContent(r.value.payload.content)).join("");
  const final = selected.at(-1)!.final;
  const hasAbortedTurn = selected.some(t => t.endKind === "aborted");
  const startsBeforeAcknowledgedWindow = Date.parse(selected[0]!.started) < Date.parse(task.startedAt) - 5_000;
  const mode = allText === task.output ? "all-assistant-text"
    : !hasAbortedTurn && !startsBeforeAcknowledgedWindow && final === task.output && final.trim() ? "final-answer" : null;
  if (!mode) throw new NativeRecoveryMismatch("output_anchor_mismatch");
  for (const other of siblings) {
    if (other.id === task.id || other.nativeSessionId !== task.nativeSessionId) continue;
    for (const turn of selected) {
      if (Date.parse(turn.started) >= nativeNotBefore(other) && Date.parse(turn.completed) <= Date.parse(other.completedAt) + 5_000
        && turn.users.some(text => text.includes(other.prompt)) && (turn.texts.join("") === other.output || turn.final === other.output)) {
        throw new NativeRecoveryMismatch("native_turn_matches_multiple_tasks");
      }
    }
    if (Date.parse(selected[0]!.started) >= nativeNotBefore(other) && Date.parse(selected.at(-1)!.completed) <= Date.parse(other.completedAt) + 5_000
      && selected[0]!.users.some(text => text.includes(other.prompt)) && (allText === other.output || final === other.output)) {
      throw new NativeRecoveryMismatch("native_turn_matches_multiple_tasks");
    }
  }
  return { records: chosen, proof: {
    method: "session-cwd-prompt-output-turn", taskId: task.id, nativeSessionId: task.nativeSessionId,
    turnIds: selected.map(t => t.id), firstLine: selected[0]!.from, lastLine: selected.at(-1)!.to,
    promptSha256: sha256(task.prompt), outputSha256: sha256(task.output), outputMatch: mode,
    nativeStartedAt: selected[0]!.started, nativeCompletedAt: selected.at(-1)!.completed,
    ...(task.notBeforeAt ? { notBeforeAt: task.notBeforeAt } : {}),
  } };
}
