/**
 * Native subagent items in the trace translator (PR 5 §3), driven by the live
 * captures of the pinned bridges (claude-agent-acp 0.90, codex-acp 2.2.2;
 * tests/fixtures/acp/*-native-subagent-*.json, redacted) and by synthetic frames
 * for what those runs did not show (the 0.89 orphan hook, nesting, failures).
 *
 * The provider stamps every frame of a registered child session with
 * `_meta.remiSessionId` (PR 5 §1.2); `providerFrames` does the same to the
 * recorded frames.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createAdapter } from "@acp/index.js";
import type { PermissionOption } from "@shared/contracts/acp-protocol.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import type { TraceEvent, TraceEventInput, TraceItem, TraceItemOf } from "@multiremi/contracts/trace.js";
import { EMPTY_TURN_TRACE, applyTurnTraceEvents, closeOpenItems, type TurnTraceState } from "@shared/turn-trace.js";
import { isHiddenStep } from "@shared/trace-step-copy.js";
import { createTraceTranslator, type TraceTranslatorOptions } from "@multiremi/worker/trace-translator.js";

const T0 = Date.parse("2026-10-15T08:00:00.000Z");
const FIXTURES = new URL("../../fixtures/acp/", import.meta.url);
const ROOT = "sess_root";

type Row = { t: number; remi?: string; index?: number; method?: string; id?: number; result?: unknown;
  params?: { sessionId?: string; update?: Record<string, unknown>; toolCall?: { toolCallId?: string } } };

/** A live capture as the provider streams it: one list of events per prompt (and the frames after it resolved). */
function providerFrames(name: string): { prompts: ProviderEvent[][]; permissions: Array<{ sessionId: string; toolCallId: string }> } {
  const rows = JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Row[];
  const prompts: ProviderEvent[][] = [];
  const permissions: Array<{ sessionId: string; toolCallId: string }> = [];
  const children = new Set<string>();
  for (const row of rows) {
    if (row.remi === "prompt_sent") { prompts.push([]); continue; }
    if (row.method === "session/request_permission") {
      permissions.push({ sessionId: row.params!.sessionId!, toolCallId: row.params!.toolCall!.toolCallId! });
      continue;
    }
    const update = row.params?.update;
    if (row.method !== "session/update" || !update) continue;
    const sessionId = row.params!.sessionId!;
    if (sessionId !== ROOT && !children.has(sessionId)) continue;
    if (update.sessionUpdate === "subagent_spawned") children.add(update.subagentSessionId as string);
    const event = sessionId === ROOT ? update
      : { ...update, _meta: { ...(update._meta as Record<string, unknown> | undefined), remiSessionId: sessionId } };
    prompts.at(-1)!.push(event as unknown as ProviderEvent);
  }
  return { prompts, permissions };
}

const stamped = (sessionId: string, update: Record<string, unknown>) =>
  ({ ...update, _meta: { ...(update._meta as Record<string, unknown> | undefined), remiSessionId: sessionId } });

function harness(agentType: "claude" | "codex", options: Partial<TraceTranslatorOptions> = {}) {
  let tick = 0;
  const now = () => new Date(T0 + tick * 1000).toISOString();
  const events: TraceEvent[] = [];
  let state: TurnTraceState = EMPTY_TURN_TRACE;
  const translator = createTraceTranslator(createAdapter(agentType), (batch: TraceEventInput[]) => {
    const stored = batch.map((body, index) => ({ ...body, seq: events.length + index + 1, ts: now() }) as TraceEvent);
    events.push(...stored);
    state = applyTurnTraceEvents(state, stored);
  }, { now: () => { tick++; return now(); }, nowMs: () => T0 + tick * 1000, flushIntervalMs: 60_000, ...options });
  translator.start({ attemptId: "tsk_attempt", turnId: "turn_1", agentId: "agt_1", agentName: "Remi", provider: agentType,
    requestedModel: null, input: [{ id: "msg_in", body_md: "Count the files" } as never] });
  const h = {
    translator,
    events,
    get state() { return state; },
    feed(updates: Array<ProviderEvent | Record<string, unknown>>) {
      for (const update of updates) translator.acp(update as ProviderEvent);
      return h;
    },
    round(updates: Array<ProviderEvent | Record<string, unknown>>) {
      h.feed(updates);
      translator.promptEnded();
      return h;
    },
    item<T extends TraceItem["type"]>(id: string, type?: T): TraceItemOf<T> {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`no item ${id}; have ${state.items.map((candidate) => candidate.id).join(", ")}`);
      if (type) expect(item.type).toBe(type);
      return item as TraceItemOf<T>;
    },
    children(parentId: string) {
      return state.items.filter((item) => item.parent_id === parentId);
    },
  };
  return h;
}

const chunk = (text: string, extra: Record<string, unknown> = {}) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...extra });
const spawned = (subagentSessionId: string, extra: Record<string, unknown> = {}) =>
  ({ sessionUpdate: "subagent_spawned", subagentSessionId, name: "Count files", task: "List the files", prompt: "List the files",
    capabilities: {}, ...extra });
const state = (subagentSessionId: string, value: string) => ({ sessionUpdate: "subagent_state_update", subagentSessionId, state: value });
const hook = (toolCallId: string, toolResponse: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ sessionUpdate: "tool_call_update", toolCallId, _meta: { claudeCode: { toolResponse, toolName: "Agent", ...extra } } });
const childBash = (session: string, id: string, parent = "toolu_01") => [
  stamped(session, { sessionUpdate: "tool_call", toolCallId: id, name: "Bash", kind: "execute", status: "pending", title: "ls",
    rawInput: { command: "ls" }, _meta: { claudeCode: { toolName: "Bash", parentToolUseId: parent } } }),
  stamped(session, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "a.txt" }),
];
const A = "a0000000000000001";
const B = "a0000000000000002";

describe("native subagents: Claude 0.90 live captures", () => {
  it("a background child is one item: spawned, inferred background, ended by its own state, with its reply", () => {
    const { prompts } = providerFrames("claude-090-native-subagent-bg-fast.json");
    const h = harness("claude").round(prompts[0]!);
    const agent = h.item(`sa:${A}`, "subagent");
    expect(agent).toMatchObject({
      parent_id: null, status: "completed", tool: "Agent", title: "Count files in directory", name: "Count files in directory",
      thread_id: A, background: true,
    });
    expect(agent.prompt).toStartWith("List the files in the current working directory");
    // U2: the AIR announcement names no type or model.
    expect(agent.agent_type).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.output).toStartWith("There are 3 files in /work.");
    expect(agent.duration_ms).toBeGreaterThan(0);
    // The child's Bash and its reply are nested; its reply is never final.
    const nested = h.children(agent.id);
    expect(nested.map((item) => item.type)).toEqual(["command", "agent_message"]);
    expect(nested[1]).toMatchObject({ type: "agent_message", phase: "unknown" });
    // The root: "I've started…", then the follow-up "3" inside the held prompt.
    expect(h.translator.settle().text).toBe("3");
  });

  it("a resumed generation reopens the same item and adds the SendMessage text as its next instructions", () => {
    const { prompts } = providerFrames("claude-090-native-subagent-bg-fast.json");
    const h = harness("claude").round(prompts[0]!);
    h.feed(prompts[1]!.slice(0, prompts[1]!.findIndex((event) => event.sessionUpdate === "subagent_spawned") + 1));
    expect(h.item(`sa:${A}`, "subagent")).toMatchObject({ status: "in_progress", completed_at: null, duration_ms: null, background: true });
    expect(h.item(`sa:${A}`, "subagent").output).toStartWith("There are 3 files in /work.");
    h.round(prompts[1]!.slice(prompts[1]!.findIndex((event) => event.sessionUpdate === "subagent_spawned") + 1));
    const subagents = h.state.items.filter((item) => item.type === "subagent");
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({ id: `sa:${A}`, status: "completed" });
    const resumed = h.children(`sa:${A}`).filter((item) => item.type === "user_message");
    expect(resumed).toEqual([expect.objectContaining({ origin: "input", text: "Please also report the size in bytes of a.txt in /work.",
      message_ids: [], attachments: [], steer: null, status: "completed" })]);
    // 0.90 drops the generation's own frames (live): the item keeps the first generation's result.
    expect(subagents[0]!.type === "subagent" && subagents[0]!.output).toStartWith("There are 3 files in /work.");
    // The SendMessage call stays a root tool (the shared control row reads it).
    expect(h.state.items.find((item) => item.type === "tool" && item.tool === "SendMessage")).toMatchObject({ parent_id: null });
    expect(h.translator.settle().text).toBe("6 bytes");
  });

  it("a held slow background child: inferred background from the root's own reply while it ran", () => {
    const { prompts } = providerFrames("claude-090-native-subagent-bg-slow.json");
    const h = harness("claude").round(prompts[0]!);
    expect(h.item(`sa:${A}`, "subagent")).toMatchObject({ status: "completed", background: true, name: "Sleep then count files" });
    expect(h.children(`sa:${A}`).map((item) => item.type)).toEqual(["command", "agent_message"]);
  });

  it("a foreground child stays without a background verdict; its permission points at the child's tool", () => {
    const { prompts, permissions } = providerFrames("claude-090-native-subagent-permission.json");
    expect(permissions).toEqual([{ sessionId: A, toolCallId: "toolu_02" }]);
    const h = harness("claude");
    const before = prompts[0]!.findIndex((event) => event.sessionUpdate === "tool_call_update");
    h.feed(prompts[0]!.slice(0, before));
    expect(h.translator.subagentOfSession(A)).toEqual({ item_id: `sa:${A}`, name: "Write count.txt file" });
    expect(h.translator.subagentOfSession(ROOT)).toBeNull();
    expect(h.translator.subagentOfSession(null)).toBeNull();
    const options: PermissionOption[] = [{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" }];
    const id = h.translator.permissionRequested({ decisionId: "dec_1", toolCallId: "toolu_02", title: "Write count.txt", options });
    // D4: the permission item stays top-level.
    expect(h.item(id, "permission")).toMatchObject({ parent_id: null, tool_item_id: "toolu_02" });
    h.translator.permissionResolved(id, { option: options[1]!, outcome: "selected", respondedBy: "mem_1", replyMessageId: "rep_1" });
    h.round(prompts[0]!.slice(before));
    expect(h.item("toolu_02", "file_change")).toMatchObject({ parent_id: `sa:${A}`, status: "declined" });
    const agent = h.item(`sa:${A}`, "subagent");
    expect(agent.status).toBe("completed");
    expect(agent.background).toBeUndefined();
    expect(h.translator.settle().text).toBe("done");
  });
});

describe("native subagents: Codex 2.2.2 live capture", () => {
  it("child steps nest under the agent; `wait` is a hidden tool; the child's context never reaches the turn", () => {
    const { prompts } = providerFrames("codex-222-native-subagent-wait.json");
    const h = harness("codex").round(prompts[0]!);
    const agent = h.item("sa:00000000-0000-7000-8000-000000000001", "subagent");
    // Codex's stand-in task is not a prompt (the v2 spawn message is encrypted).
    expect(agent).toMatchObject({ tool: "spawnAgent", name: "Count files", prompt: null, status: "completed", output: "3",
      thread_id: "00000000-0000-7000-8000-000000000001" });
    expect(agent.background).toBeUndefined();
    const nested = h.children(agent.id);
    expect(nested.map((item) => item.type)).toEqual(["command", "agent_message"]);
    expect(nested[1]).toMatchObject({ phase: "commentary", text: "3" });
    const wait = h.item("call_01", "tool");
    expect(wait).toMatchObject({ tool: "wait", parent_id: null, status: "completed" });
    expect(isHiddenStep(wait)).toBe(true);
    // Only the root's occupancy patches the turn (14 k of 475 k), never the child's.
    const contexts = h.events.flatMap((event) => event.type === "turn.updated" && event.patch.context_usage ? [event.patch.context_usage] : []);
    expect(contexts.length).toBeGreaterThan(0);
    const childUsed = new Set(prompts[0]!.filter((event) => event.sessionUpdate === "usage_update"
      && (event as { _meta?: { remiSessionId?: string } })._meta?.remiSessionId).map((event) => (event as { used: number }).used));
    for (const context of contexts) expect(childUsed.has(context.used)).toBe(false);
    expect(h.translator.settle().text).toBe("3");
  });

  it("collaboration calls that act on agents are tool rows named by their title", () => {
    const h = harness("codex").round([
      spawned("thread-1", { task: "Delegated task for Count files", prompt: undefined }),
      { sessionUpdate: "tool_call", toolCallId: "call_send", kind: "other", title: "sendInput", status: "in_progress",
        rawInput: { prompt: "also count dirs", senderThreadId: ROOT, receiverThreadIds: ["thread-1"] } },
      { sessionUpdate: "tool_call_update", toolCallId: "call_send", status: "completed" },
      state("thread-1", "completed"),
    ]);
    expect(h.item("call_send", "tool")).toMatchObject({ tool: "sendInput", parent_id: null,
      input: expect.objectContaining({ receiverThreadIds: ["thread-1"] }) });
    expect(h.item("sa:thread-1", "subagent").prompt).toBeNull();
  });
});

describe("native subagents: lifecycle", () => {
  it("maps every end state and closes the child's open text and tools", () => {
    for (const [value, status] of [["completed", "completed"], ["failed", "failed"], ["cancelled", "stopped"], ["disconnected", "stopped"]] as const) {
      const h = harness("claude").feed([
        spawned(A),
        stamped(A, { sessionUpdate: "tool_call", toolCallId: "toolu_open", name: "Bash", kind: "execute", status: "pending",
          _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "toolu_01" } } }),
        stamped(A, chunk("half a thought")),
        state(A, value),
      ]);
      expect(h.item(`sa:${A}`, "subagent").status).toBe(status);
      expect(h.item("toolu_open", "command").status).toBe("stopped");
      expect(h.children(`sa:${A}`).find((item) => item.type === "agent_message")?.status).toBe("completed");
    }
  });

  it("a resumed generation's own reply replaces the output; without one the last result stays", () => {
    const h = harness("claude").round([
      spawned(A), stamped(A, chunk("first answer")), state(A, "completed"),
      spawned(`${A}:generation:2`, { prompt: "and the size?" }), state(`${A}:generation:2`, "completed"),
    ]);
    expect(h.item(`sa:${A}`, "subagent").output).toBe("first answer");
    h.round([
      spawned(`${A}:generation:3`, { prompt: "and the owner?" }), stamped(`${A}:generation:3`, chunk("second answer")),
      state(`${A}:generation:3`, "completed"),
    ]);
    expect(h.item(`sa:${A}`, "subagent").output).toBe("second answer");
  });

  it("nests a child spawned by a child, and its frames, under that child", () => {
    const h = harness("claude").round([
      spawned(A, { name: "Outer" }),
      stamped(A, spawned(B, { name: "Inner" })),
      ...childBash(B, "toolu_inner", "toolu_outer_call"),
      stamped(B, chunk("inner reply", { _meta: { claudeCode: { parentToolUseId: "toolu_outer_call" } } })),
      stamped(A, state(B, "completed")),
      stamped(A, chunk("outer reply")),
      state(A, "completed"),
    ]);
    expect(h.item(`sa:${B}`, "subagent")).toMatchObject({ parent_id: `sa:${A}`, output: "inner reply", status: "completed" });
    expect(h.item("toolu_inner", "command").parent_id).toBe(`sa:${B}`);
    expect(h.item(`sa:${A}`, "subagent").output).toBe("outer reply");
    expect(h.translator.subagentOfSession(B)).toEqual({ item_id: `sa:${B}`, name: "Inner" });
  });

  it("a child's failure is a notice under it and never a root notice", () => {
    const failure = { id: "f1", revision: 1, category: "unknown", severity: "error", title: "Child crashed", details: "boom" };
    const h = harness("claude").round([
      spawned(A),
      stamped(A, { sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { sessionFailure: failure } } } }),
      stamped(A, { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "idle" } } } }),
      state(A, "failed"),
    ]);
    const notices = h.state.items.filter((item) => item.type === "notice");
    expect(notices).toEqual([expect.objectContaining({ id: "fail:f1", parent_id: `sa:${A}`, severity: "error", title: "Child crashed" })]);
    expect(h.item(`sa:${A}`, "subagent").status).toBe("failed");
  });

  it("ignores a child's model and usage frames", () => {
    const h = harness("claude").round([
      spawned(A),
      stamped(A, { sessionUpdate: "config_option_update", id: "model", value: "child-model" }),
      stamped(A, { sessionUpdate: "usage_update", used: 5_000, size: 100_000 }),
      { sessionUpdate: "usage_update", used: 20_000, size: 1_000_000 },
    ]);
    expect(h.state.turn?.model).toBeNull();
    expect(h.state.turn?.context_usage).toEqual({ used: 20_000, size: 1_000_000 });
  });

  it("a background child's tools survive a steer abort; a foreground child's are stopped", () => {
    const h = harness("claude").feed([
      spawned(A),
      stamped(A, { sessionUpdate: "tool_call", toolCallId: "toolu_bg", name: "Bash", kind: "execute", status: "pending",
        _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "toolu_01" } } }),
      chunk("I'll wait for it."),
      spawned(B),
      stamped(B, { sessionUpdate: "tool_call", toolCallId: "toolu_fg", name: "Bash", kind: "execute", status: "pending",
        _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "toolu_02" } } }),
    ]);
    expect(h.item(`sa:${A}`, "subagent").background).toBe(true);
    h.translator.roundAborted();
    h.translator.promptEnded({ aborted: true });
    expect(h.item("toolu_bg", "command").status).toBe("in_progress");
    expect(h.item("toolu_fg", "command").status).toBe("stopped");
  });

  it("an item still running when the turn closes ends with it (background) or stops", () => {
    const h = harness("claude").round([spawned(A), chunk("Started it."), spawned(B)]);
    const closing = closeOpenItems(h.state.items, "completed", new Date(T0 + 99_000).toISOString());
    const byId = new Map(closing.map((event) => [(event as { item: TraceItem }).item.id, (event as { item: TraceItem }).item]));
    expect(byId.get(`sa:${A}`)?.status).toBe("completed");
    expect(byId.get(`sa:${B}`)?.status).toBe("stopped");
  });
});

describe("native subagents: the orphan Agent hook (claude-agent-acp 0.89 shape)", () => {
  it("absorbs an async launch's hook: no item, and the agent runs in the background", () => {
    const h = harness("claude").round([
      spawned(A),
      hook("toolu_01", { status: "async_launched", isAsync: true }),
      ...childBash(A, "toolu_c"),
      state(A, "completed"),
    ]);
    expect(h.state.items.some((item) => item.id === "toolu_01")).toBe(false);
    expect(h.item(`sa:${A}`, "subagent").background).toBe(true);
  });

  it("a foreground hook after the end marks it foreground (the agent was linked through its child's frames)", () => {
    const h = harness("claude").round([
      spawned(A),
      ...childBash(A, "toolu_c"),
      state(A, "completed"),
      hook("toolu_01", { status: "completed" }),
    ]);
    expect(h.state.items.some((item) => item.id === "toolu_01")).toBe(false);
    expect(h.item(`sa:${A}`, "subagent")).toMatchObject({ status: "completed", background: false });
  });

  it("links two parallel spawns: by alias first, else the latest unlinked agent", () => {
    const h = harness("claude").round([
      spawned(A, { name: "First" }),
      hook("toolu_A", { status: "async_launched", isAsync: true }),
      spawned(B, { name: "Second" }),
      hook("toolu_B", { status: "async_launched", isAsync: true }),
      ...childBash(A, "toolu_ca", "toolu_A"),
      ...childBash(B, "toolu_cb", "toolu_B"),
    ]);
    expect(h.item(`sa:${A}`, "subagent").background).toBe(true);
    expect(h.item(`sa:${B}`, "subagent").background).toBe(true);
    expect(h.state.items.filter((item) => item.type === "subagent")).toHaveLength(2);
  });

  it("waits for the alias when no unlinked agent is on the calling session", () => {
    const h = harness("claude").feed([
      spawned(A),
      hook("toolu_A", { status: "completed" }),
      // A second hook whose agent is announced but already linked: it waits for a child frame.
      hook("toolu_X", { status: "async_launched", isAsync: true }),
    ]);
    expect(h.item(`sa:${A}`, "subagent").background).toBe(false);
    h.feed([spawned(B), ...childBash(B, "toolu_cb", "toolu_X")]);
    expect(h.item(`sa:${B}`, "subagent").background).toBe(true);
  });

  it("without native sessions the Agent call is today's subagent item (kill switch)", () => {
    const h = harness("claude").round([
      { sessionUpdate: "tool_call", toolCallId: "toolu_01", title: "Task", kind: "think", status: "pending",
        _meta: { claudeCode: { toolName: "Agent" } } },
      hook("toolu_01", { status: "async_launched", isAsync: true }),
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_01", status: "completed" },
    ]);
    expect(h.item("toolu_01", "subagent")).toMatchObject({ background: true, status: "in_progress" });
  });
});

const marker = (kind: string) => ({ sessionUpdate: "usage_update", used: 0, size: 0, _meta: { "_claude/origin": { kind } } });
const rootTool = (id: string) => [
  { sessionUpdate: "tool_call", toolCallId: id, name: "Bash", kind: "execute", status: "pending", title: "ls", _meta: { claudeCode: { toolName: "Bash" } } },
  { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" },
];

describe("owesAutonomousRound (PR 5 §2.4)", () => {
  it("native: a background child that ended before the human result is owed its notification", () => {
    // The 0.89 race: the child ends before the root's result, so the bridge does not hold the prompt.
    const h = harness("claude").round([spawned(A), chunk("I started it."), state(A, "completed"), marker("human")]);
    expect(h.item(`sa:${A}`, "subagent").background).toBe(true);
    expect(h.translator.owesAutonomousRound).toBe(true);
    // The follow-up's own result settles it.
    h.round([chunk("3"), marker("task-notification")]);
    expect(h.translator.owesAutonomousRound).toBe(false);
  });

  it("a later prompt's result (a steer's re-prompt) carried the pending notification", () => {
    const h = harness("claude").round([spawned(A), chunk("I started it."), state(A, "completed"), marker("human")]);
    expect(h.translator.owesAutonomousRound).toBe(true);
    // The wait was stopped by a steer: an empty listen round, then the re-prompt.
    h.round([]);
    expect(h.translator.owesAutonomousRound).toBe(true);
    h.round([chunk("中文结论"), marker("human")]);
    expect(h.translator.owesAutonomousRound).toBe(false);

    const legacy = harness("claude").round([
      { sessionUpdate: "tool_call", toolCallId: "toolu_1", title: "Task", kind: "think", status: "pending", _meta: { claudeCode: { toolName: "Agent" } } },
      hook("toolu_1", { status: "async_launched", isAsync: true }),
      marker("human"),
    ]);
    expect(legacy.translator.owesAutonomousRound).toBe(true);
    legacy.round([chunk("re-prompted"), marker("human")]);
    expect(legacy.translator.owesAutonomousRound).toBe(false);
  });

  it("native: a background child still running is owed", () => {
    const h = harness("claude").round([spawned(A), chunk("Started."), marker("human")]);
    expect(h.translator.owesAutonomousRound).toBe(true);
  });

  it("native: a root tool result after the child's end carried the notification inside the prompt", () => {
    const h = harness("claude").round([spawned(A), chunk("Started."), state(A, "completed"), ...rootTool("toolu_ls"), marker("human")]);
    expect(h.translator.owesAutonomousRound).toBe(false);
  });

  it("native: a held prompt already ran the follow-up (live bg-fast and bg-slow captures)", () => {
    for (const name of ["claude-090-native-subagent-bg-fast.json", "claude-090-native-subagent-bg-slow.json"]) {
      const { prompts } = providerFrames(name);
      const h = harness("claude");
      for (const prompt of prompts) {
        h.round(prompt);
        expect(h.translator.owesAutonomousRound).toBe(false);
      }
    }
  });

  it("native: a foreground child (no background verdict) owes nothing", () => {
    const { prompts } = providerFrames("claude-090-native-subagent-permission.json");
    expect(harness("claude").round(prompts[0]!).translator.owesAutonomousRound).toBe(false);
  });

  it("native: a nested background child never owes the root a round", () => {
    const h = harness("claude").round([spawned(A), stamped(A, spawned(B)), stamped(A, chunk("child keeps going")),
      stamped(A, state(B, "completed")), state(A, "completed"), marker("human")]);
    expect(h.item(`sa:${B}`, "subagent").background).toBe(true);
    expect(h.translator.owesAutonomousRound).toBe(false);
  });

  it("without native sessions: background launches outnumber the autonomous results since the first", () => {
    const launch = (id: string) => [
      { sessionUpdate: "tool_call", toolCallId: id, title: "Task", kind: "think", status: "pending", _meta: { claudeCode: { toolName: "Agent" } } },
      hook(id, { status: "async_launched", isAsync: true }),
    ];
    const h = harness("claude").round([marker("task-notification"), ...launch("toolu_1"), chunk("Started."), marker("human")]);
    // An earlier marker does not count: it came before the launch.
    expect(h.translator.owesAutonomousRound).toBe(true);
    h.round([chunk("3"), marker("task-notification")]);
    expect(h.translator.owesAutonomousRound).toBe(false);
    h.round([...launch("toolu_2"), ...launch("toolu_3"), marker("human"), chunk("one back"), marker("task-notification")]);
    expect(h.translator.owesAutonomousRound).toBe(true);
  });

  it("Codex declares no autonomous rounds and never owes one", () => {
    const { prompts } = providerFrames("codex-222-native-subagent-wait.json");
    const h = harness("codex").round(prompts[0]!);
    h.round([spawned("t2"), chunk("Started.")]);
    expect(h.translator.owesAutonomousRound).toBe(false);
  });
});

describe("onSubagentCounts (PR 5 §3.8)", () => {
  it("reports each change of the running top-level and nested counts", () => {
    const counts: Array<{ top: number; nested: number }> = [];
    const h = harness("claude", { onSubagentCounts: (value) => counts.push(value) });
    h.round([
      spawned(A), stamped(A, spawned(B)), chunk("Started."),
      stamped(A, state(B, "completed")), state(A, "completed"),
    ]);
    expect(counts).toEqual([{ top: 1, nested: 0 }, { top: 1, nested: 1 }, { top: 1, nested: 0 }, { top: 0, nested: 0 }]);
    // A resumed generation runs again.
    h.round([spawned(`${A}:generation:2`, { prompt: "again" }), state(`${A}:generation:2`, "completed")]);
    expect(counts.slice(4)).toEqual([{ top: 1, nested: 0 }, { top: 0, nested: 0 }]);
  });

  it("counts Claude's A-mode background launches too, and never throws for a failing listener", () => {
    const h = harness("claude", { onSubagentCounts: () => { throw new Error("listener broke"); } });
    h.round([
      { sessionUpdate: "tool_call", toolCallId: "toolu_1", title: "Task", kind: "think", status: "pending", _meta: { claudeCode: { toolName: "Agent" } } },
      hook("toolu_1", { status: "async_launched", isAsync: true }),
    ]);
    expect(h.item("toolu_1", "subagent").status).toBe("in_progress");
  });
});
