// The ACP-event → TaskMessage translation layer: a stateful per-run mapper plus
// the provider-response → usage-entry conversion. Pure translation, no daemon
// state — extracted verbatim from worker/daemon.ts (the daemon imports it back
// and re-exports `createEventMapper` for existing importers).
import type { AgentAdapter } from "@acp/index.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import type { TaskMessageInput, TaskUsageEntry } from "@multiremi/contracts/types.js";

interface ToolCallState {
  name: string;
  kind?: string;
  input?: Record<string, unknown>;
  status: string;
  startMs: number;
  terminalEmitted: boolean;
  lastFingerprint?: string;
  /**
   * JSON of the input as last emitted for this call. A later message repeats the
   * input only when the merged one differs, which covers both directions: claude
   * emits nothing on the use and the args later, codex collab emits an input up
   * front and enriches it (agentsStates, receiverThreadIds) on the terminal frame.
   */
  lastEmittedInputJson?: string;
  /** Owning subagent call, decided once at state creation (see resolveParentToolCallId). */
  parentToolCallId?: string;
}

const TERMINAL_TOOL_STATUS = new Set(["completed", "failed"]);

/** Tool names that spawn a subagent — `Task` is the legacy name of `Agent`. */
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

/**
 * The subagent attribution claude-agent-acp >= 0.66 forwards itself, on both
 * prose chunks and tool events. Authoritative wherever it appears — the
 * time-window heuristic below only covers bridges that don't send it.
 */
function metaParentToolUseId(raw: Record<string, any>): string | undefined {
  const value = raw?._meta?.claudeCode?.parentToolUseId;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * claude-agent-acp forwards a subagent's inner tool calls flat, dropping the
 * SDK's `parent_tool_use_id`, so ownership can only be inferred from the time
 * window: while an Agent call is open, the calls that start belong to it. With
 * two or more Agents open (parallel / background subagents) the assignment
 * would be a guess — wrong nesting is worse than none, so those stay flat.
 */
function resolveParentToolCallId(
  id: string,
  name: string,
  tools: Map<string, ToolCallState>,
): string | undefined {
  // A subagent spawned by a subagent stays top-level.
  if (SUBAGENT_TOOL_NAMES.has(name)) return undefined;
  let parent: string | undefined;
  for (const [candidateId, candidate] of tools) {
    if (candidateId === id) continue;
    if (!SUBAGENT_TOOL_NAMES.has(candidate.name)) continue;
    if (TERMINAL_TOOL_STATUS.has(candidate.status)) continue;
    if (parent !== undefined) return undefined;
    parent = candidateId;
  }
  return parent;
}

/**
 * The only key the claude bridge's initial `tool_call` yields for a shell call:
 * the terminal content block resolves to `{ terminal_id }` while the real args
 * (command/description) arrive in the following `tool_call_update`.
 */
const TERMINAL_PLACEHOLDER_KEY = "terminal_id";

/** Whether an input carries real tool args, not just the terminal placeholder. */
function hasMeaningfulInput(input: Record<string, unknown> | undefined): boolean {
  if (!input) return false;
  return Object.keys(input).some((key) => key !== TERMINAL_PLACEHOLDER_KEY);
}

/**
 * A stateful ACP-event → task-message mapper. Unlike the old one-in-one-out
 * function it can emit 0..N messages per event (an initial tool_call that
 * already carries output produces both a tool_use and its paired tool_result),
 * and it preserves the ACP semantics the flat schema used to drop:
 * toolCallId (for pairing), status, kind, locations, plan snapshots. The caller
 * assigns a distinct seq to every emitted message — reusing one seq for two
 * messages would collide on UNIQUE(task_id, seq).
 */
export function createEventMapper(adapter: AgentAdapter): (event: ProviderEvent) => TaskMessageInput[] {
  const tools = new Map<string, ToolCallState>();
  let synCounter = 0;

  return (event: ProviderEvent): TaskMessageInput[] => {
    const raw = event as Record<string, any>;
    const su = raw.sessionUpdate;

    if (su === "agent_message_chunk" || su === "agent_thought_chunk") {
      const content = extractText(raw.content);
      if (!content) return [];
      // A subagent's prose (claude-agent-acp >= 0.66, gated on the
      // `subagent-transcript` client capability) says which Agent call it came
      // from; the frontend nests it under that step.
      const parent = metaParentToolUseId(raw);
      return [{
        type: su === "agent_thought_chunk" ? "thinking" : "text",
        content,
        meta: parent ? { parent_tool_call_id: parent } : undefined,
      }];
    }

    if (su === "usage_update") {
      // Snapshot (not a delta) — keep the whole event's usage numbers in meta;
      // the frontend takes the last snapshot, never a sum.
      const meta = raw.usage && typeof raw.usage === "object" ? { ...raw.usage } : { ...raw };
      delete (meta as Record<string, unknown>).sessionUpdate;
      return [{ type: "usage", meta }];
    }

    if (su === "plan") {
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      const done = entries.filter((e: any) => e?.status === "completed").length;
      // New seq every time — the frontend dedups by seq, so a same-seq upsert
      // would drop later plan snapshots; it renders the last one.
      return [{ type: "plan", content: `${done}/${entries.length} completed`, meta: { entries } }];
    }

    if (su === "tool_call" || su === "tool_call_update") {
      return mapToolEvent(raw, su === "tool_call", tools, adapter, () => `syn_${synCounter++}`);
    }

    return [];
  };
}

function mapToolEvent(
  raw: Record<string, any>,
  isInitial: boolean,
  tools: Map<string, ToolCallState>,
  adapter: AgentAdapter,
  synthId: () => string,
): TaskMessageInput[] {
  const id: string = typeof raw.toolCallId === "string" && raw.toolCallId ? raw.toolCallId : synthId();
  // The adapter resolves the real tool name and reconstructs input from
  // title/content/locations — claude-agent-acp leaves rawInput empty and encodes
  // the args there instead (the command in title, file path in locations, etc.).
  const name = adapter.resolveToolName(raw as never) || tools.get(id)?.name || "tool";
  const input = adapter.extractToolInput(raw as never);
  const status: string | undefined = typeof raw.status === "string" ? raw.status : undefined;
  const output = raw.rawOutput != null ? JSON.stringify(raw.rawOutput) : extractText(raw.content) || undefined;
  const meta: Record<string, unknown> = {};
  if (raw.title) meta.title = raw.title;
  if (raw.kind) meta.kind = raw.kind;
  if (Array.isArray(raw.locations) && raw.locations.length) meta.locations = raw.locations;

  const messages: TaskMessageInput[] = [];
  const existing = tools.get(id);
  const state: ToolCallState = existing ?? {
    name,
    kind: raw.kind,
    input,
    status: status ?? "pending",
    startMs: Date.now(),
    terminalEmitted: false,
    // Real attribution from the bridge wins for any agent type. The time-window
    // heuristic is the claude-only fallback for bridges that don't send it:
    // its precondition — an open Agent call blocks the foreground until its
    // subagent finishes — holds for claude alone. Codex collab spawns normalize
    // to `Agent` as well, but the caller keeps working alongside them.
    parentToolCallId:
      metaParentToolUseId(raw)
      ?? (adapter.agentType === "claude" ? resolveParentToolCallId(id, name, tools) : undefined),
  };
  // Merge late-arriving fields; a refining event's keys win over the earlier
  // ones (claude's initial tool_call only yields a terminal placeholder, the
  // real command lands in the following update) while bridges that send the
  // full input up front keep every key they already reported.
  state.name = name;
  if (raw.kind) state.kind = raw.kind;
  if (input) state.input = { ...state.input, ...input };
  if (status) state.status = status;
  tools.set(id, state);
  // Carried by every emission of this call (tool_use and tool_result) so the
  // frontend can nest it whichever message it sees first.
  if (state.parentToolCallId) meta.parent_tool_call_id = state.parentToolCallId;

  if (isInitial) {
    // A placeholder-only input isn't the tool's args — emitting it would pin the
    // frontend's step card to `{terminal_id}` and the real command (which only
    // arrives in the refining update) would never render. Park the id in meta
    // and leave the input to the paired tool_result.
    const meaningful = hasMeaningfulInput(state.input);
    if (meaningful) state.lastEmittedInputJson = JSON.stringify(state.input);
    if (!meaningful && state.input?.[TERMINAL_PLACEHOLDER_KEY] != null) {
      meta[TERMINAL_PLACEHOLDER_KEY] = state.input[TERMINAL_PLACEHOLDER_KEY];
    }
    messages.push({
      type: "tool_use",
      toolCallId: id,
      status: status ?? "pending",
      tool: state.name,
      input: meaningful ? state.input : undefined,
      meta: Object.keys(meta).length ? meta : undefined,
    });
  }

  // Emit a tool_result whenever this event carries output or reached a terminal
  // status — including an initial tool_call that's already complete. Idempotent
  // by fingerprint so a repeat of the same terminal frame doesn't double-post,
  // but a real statusless→terminal transition still lands once.
  const isTerminal = status != null && TERMINAL_TOOL_STATUS.has(status);
  if (output != null || isTerminal) {
    const fingerprint = `${status ?? ""}:${output ?? ""}`;
    if (!(state.terminalEmitted && state.lastFingerprint === fingerprint)) {
      state.lastFingerprint = fingerprint;
      if (isTerminal) state.terminalEmitted = true;
      const resultMeta: Record<string, unknown> = { ...meta };
      if (isTerminal) resultMeta.duration_ms = Date.now() - state.startMs;
      // Repeat the input only when it changed since the last emission: claude
      // sends the args after the use, codex collab enriches an already-emitted
      // input with the subagent's states and answer on the terminal frame. An
      // unchanged input stays off the result, as before.
      const mergedInputJson = state.input ? JSON.stringify(state.input) : undefined;
      const inputChanged = mergedInputJson != null && mergedInputJson !== state.lastEmittedInputJson;
      messages.push({
        type: "tool_result",
        toolCallId: id,
        status: status ?? state.status,
        tool: state.name,
        input: inputChanged ? state.input : undefined,
        output,
        meta: Object.keys(resultMeta).length ? resultMeta : undefined,
      });
      if (inputChanged) state.lastEmittedInputJson = mergedInputJson;
    }
  }

  return messages;
}

function extractText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : content ? [content] : [];
  let text = "";
  for (const block of blocks) {
    if (typeof block === "string") text += block;
    else if (block && typeof block === "object" && "text" in block) {
      text += String((block as { text?: unknown }).text ?? "");
    }
  }
  return text;
}

function parseMaybeJson(value: unknown): Record<string, unknown> | undefined {
  // ACP rawInput may already be a parsed object (the common case) or a JSON
  // string. Pass objects through untouched — coercing them via JSON.parse
  // buries the real args under a spurious `{ value: … }` wrapper.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return value == null ? undefined : { value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { value };
  }
}

export function responseToUsage(provider: string, response: any, fallbackModel?: string | null): TaskUsageEntry[] {
  if (!response) return [];
  const inputTokens = Number(response.inputTokens ?? 0);
  const outputTokens = Number(response.outputTokens ?? 0);
  const cacheReadTokens = Number(response.cacheReadInputTokens ?? 0);
  const cacheWriteTokens = Number(response.cacheCreateInputTokens ?? 0);
  const totalTokens = Number(response.totalTokens ?? 0);
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens && !totalTokens) return [];
  return [{
    provider,
    model: String(response.model ?? fallbackModel ?? ""),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  }];
}
