import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createAdapter } from "@acp/index.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import {
  isTraceEventBody,
  isTraceItem,
  type TraceEvent,
  type TraceEventInput,
  type TraceItem,
  type TraceItemOf,
  type TraceSteerResult,
} from "@multiremi/contracts/trace.js";
import { EMPTY_TURN_TRACE, applyTurnTraceEvents, closeOpenItems, finalItem, turnTraceStats, type TurnTraceState } from "@shared/turn-trace.js";
import {
  TRACE_EVENT_MAX_BYTES,
  TRACE_ITEM_COMMAND_MAX_BYTES,
  TRACE_ITEM_OUTPUT_HEAD_BYTES,
  TRACE_ITEM_OUTPUT_MAX_BYTES,
  TRACE_ITEM_OUTPUT_TAIL_BYTES,
  TRACE_ITEM_TEXT_MAX_BYTES,
  TRACE_TRUNCATION_MARKER,
  capTraceEvent,
  utf8ByteLength,
} from "@shared/trace-sanitize.js";
import {
  createTraceTranslator,
  TRACE_DELTA_BUFFER_BYTES,
  TRACE_DELTA_MAX_BYTES,
  type TraceTranslator,
} from "@multiremi/worker/trace-translator.js";

const T0 = Date.parse("2026-10-15T08:00:00.000Z");
const REPROMPTED: TraceSteerResult = { via: "reprompt", native_outcome: null, error: null };
const FIXTURES = new URL("../../fixtures/acp/", import.meta.url);

function frames(name: string): ProviderEvent[] {
  const rows = JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Array<{ params?: { update?: Record<string, unknown> } }>;
  return rows.flatMap((row) => row.params?.update ? [row.params.update as unknown as ProviderEvent] : []);
}

/** A translator wired to a store stand-in: dense seq, a fixed clock, and the shared fold. */
function harness(agentType: "claude" | "codex" | "antigravity", options: { flushIntervalMs?: number } = {}) {
  let tick = 0;
  const now = () => new Date(T0 + tick * 1000).toISOString();
  const batches: TraceEventInput[][] = [];
  const events: TraceEvent[] = [];
  let state: TurnTraceState = EMPTY_TURN_TRACE;
  const translator = createTraceTranslator(createAdapter(agentType), (batch) => {
    batches.push(batch);
    const stored = batch.map((body) => ({ ...body, seq: events.length + 1, ts: now() }) as TraceEvent)
      .map((event, index) => ({ ...event, seq: events.length + index + 1 }) as TraceEvent);
    events.push(...stored);
    state = applyTurnTraceEvents(state, stored);
  }, { now: () => { tick++; return now(); }, nowMs: () => T0 + tick * 1000, flushIntervalMs: options.flushIntervalMs ?? 60_000 });
  const h = {
    translator,
    batches,
    events,
    get state() { return state; },
    start(input: string[] = ["Fix the failing test"]) {
      translator.start({
        attemptId: "tsk_attempt", turnId: "turn_1", agentId: "agt_1", agentName: "Remi", provider: agentType,
        requestedModel: "model-x", input: input.map((body, index) => ({ id: `msg_in_${index}`, body_md: body }) as never),
      });
      return h;
    },
    feed(updates: ProviderEvent[] | Array<Record<string, unknown>>) {
      for (const update of updates) translator.acp(update as ProviderEvent);
      return h;
    },
    item<T extends TraceItem["type"]>(id: string, type?: T): TraceItemOf<T> {
      const item = state.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`no item ${id}; have ${state.items.map((candidate) => candidate.id).join(", ")}`);
      if (type) expect(item.type).toBe(type);
      return item as TraceItemOf<T>;
    },
    ofType<T extends TraceItem["type"]>(type: T): Array<TraceItemOf<T>> {
      return state.items.filter((item): item is TraceItemOf<T> => item.type === type);
    },
  };
  return h;
}

const chunk = (text: string, extra: Record<string, unknown> = {}) =>
  ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...extra });
const thought = (text: string, extra: Record<string, unknown> = {}) =>
  ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text }, ...extra });

describe("trace translator: message phase", () => {
  // Ported from multiremi-task-message-mapper.test.ts, including PR #421's AIR case.
  const cases: Array<[string, Record<string, unknown>, "final" | "commentary" | "unknown"]> = [
    ["codex 1.x commentary", { _meta: { codex: { phase: "commentary" } } }, "commentary"],
    ["codex 1.x final_answer", { _meta: { codex: { phase: "final_answer" } } }, "final"],
    ["codex 2.x AIR commentary", { _meta: { jetbrains: { air: { version: 1, phase: "commentary" } } } }, "commentary"],
    ["codex 2.x AIR final_answer", { _meta: { jetbrains: { air: { version: 1, phase: "final_answer" } } } }, "final"],
    ["top-level phase", { phase: "final_answer" }, "final"],
    ["partial_answer is left to settle()", { _meta: { jetbrains: { air: { version: 1, phase: "partial_answer" } } } }, "unknown"],
    ["no phase", {}, "unknown"],
  ];
  for (const [name, extra, phase] of cases) {
    it(name, () => {
      const h = harness("codex").start().feed([chunk("hello", { messageId: "m1", ...extra })]);
      h.translator.promptEnded();
      expect(h.item("msg:m1", "agent_message").phase).toBe(phase);
    });
  }

  it("prefers the AIR phase over the 1.x location when both are present", () => {
    const h = harness("codex").start().feed([chunk("x", { messageId: "m1", _meta: { jetbrains: { air: { phase: "commentary" } }, codex: { phase: "final_answer" } } })]);
    h.translator.promptEnded();
    expect(h.item("msg:m1", "agent_message").phase).toBe("commentary");
  });

  it("never makes subagent text final", () => {
    const h = harness("claude").start().feed([chunk("child", { messageId: "c1", phase: "final_answer", _meta: { claudeCode: { parentToolUseId: "toolu_agent" } } })]);
    h.translator.promptEnded();
    expect(h.item("msg:c1", "agent_message")).toMatchObject({ parent_id: "toolu_agent", phase: "commentary" });
  });
});

describe("trace translator: text identity and lifecycle", () => {
  it("starts with turn.started and the input user_message", () => {
    const h = harness("claude").start(["first", "second"]);
    expect(h.events.map((event) => event.type)).toEqual(["turn.started", "item.completed"]);
    expect(h.state.turn).toMatchObject({ id: "tsk_attempt", turn_id: "turn_1", agent_name: "Remi", provider: "claude",
      requested_model: "model-x", status: "running" });
    expect(h.item("in:tsk_attempt", "user_message")).toMatchObject({ origin: "input", text: "first\n\nsecond",
      message_ids: ["msg_in_0", "msg_in_1"], steer: null, status: "completed" });
  });

  it("groups chunks by messageId, splits at other items, and suffixes a reused id", () => {
    const h = harness("claude").start().feed([
      thought("plan ", { messageId: "msg_A" }), thought("it", { messageId: "msg_A" }),
      chunk("I'll look", { messageId: "msg_A" }), chunk(" around.", { messageId: "msg_A" }),
      { sessionUpdate: "tool_call", toolCallId: "t1", name: "Read", status: "pending", title: "Read a.ts", kind: "read",
        _meta: { claudeCode: { toolName: "Read" } }, rawInput: { file_path: "/r/a.ts" } },
      chunk("More text", { messageId: "msg_A" }),
      chunk("New message", { messageId: "msg_B" }),
    ]);
    h.translator.promptEnded();
    expect(h.state.items.map((item) => item.id)).toEqual(["in:tsk_attempt", "rsn:msg_A", "msg:msg_A", "t1", "msg:msg_A:2", "msg:msg_B"]);
    expect(h.item("rsn:msg_A", "reasoning")).toMatchObject({ text: "plan it", status: "completed" });
    expect(h.item("msg:msg_A", "agent_message")).toMatchObject({ text: "I'll look around.", status: "completed" });
    expect(h.item("msg:msg_A:2", "agent_message").text).toBe("More text");
    expect(h.item("msg:msg_B", "agent_message").status).toBe("completed");
  });

  it("numbers text without a messageId and completes it at promptEnded()", () => {
    const h = harness("codex").start().feed([chunk("a"), chunk("b")]);
    expect(h.item("msg:1", "agent_message").status).toBe("in_progress");
    h.translator.promptEnded();
    expect(h.item("msg:1", "agent_message")).toMatchObject({ text: "ab", status: "completed" });
  });

  it("reports the last item of the ended prompt round for the legacy failure check", () => {
    const h = harness("claude").start().feed([chunk("API Error: 500 upstream", { messageId: "m1" }),
      { sessionUpdate: "usage_update", used: 10, size: 100 }]);
    h.translator.promptEnded();
    expect(h.translator.lastItem).toMatchObject({ type: "agent_message", text: "API Error: 500 upstream", status: "completed" });
    // A round with no updates has no last item.
    h.translator.promptEnded();
    expect(h.translator.lastItem).toBeNull();
  });

  it("keeps a chunk the daemon marks standalone (a legacy provider failure) its own message", () => {
    const batches: TraceEventInput[][] = [];
    const translator = createTraceTranslator(createAdapter("codex"), (batch) => { batches.push(batch); },
      { standaloneText: (text) => text.startsWith("unexpected status ") });
    translator.start({ attemptId: "a", turnId: null, agentId: "x", agentName: null, provider: "codex", requestedModel: null, input: [] });
    translator.acp(chunk("Earlier progress. ") as ProviderEvent);
    translator.acp(chunk("unexpected status 503 Service Unavailable") as ProviderEvent);
    translator.promptEnded();
    expect(translator.lastItem).toMatchObject({ type: "agent_message", text: "unexpected status 503 Service Unavailable" });
    expect(translator.items.filter((item) => item.type === "agent_message").map((item) => item.id)).toEqual(["msg:1", "msg:2"]);
  });

  it("redacts agent message text through the injected hook", () => {
    const h = harness("claude");
    const translator = createTraceTranslator(createAdapter("claude"), (batch) => { h.batches.push(batch); },
      { redactText: (text) => text.replace("sk-secret", "[REDACTED]") });
    translator.start({ attemptId: "a", turnId: null, agentId: "x", agentName: null, provider: "claude", requestedModel: null, input: [] });
    translator.acp(chunk("key sk-secret leaked", { messageId: "m" }) as ProviderEvent);
    translator.flush();
    const deltas = h.batches.flat().filter((event) => event.type === "item.delta");
    expect(deltas.map((event) => event.type === "item.delta" && event.delta).join("")).toBe("key [REDACTED] leaked");
  });
});

describe("trace translator: final reply (settle)", () => {
  it("rule 2 (Claude): the last top-level message with no tool after it, across steer rounds", () => {
    const h = harness("claude").start().feed([
      chunk("Looking.", { messageId: "m1" }),
      { sessionUpdate: "tool_call", toolCallId: "t1", name: "Bash", status: "pending", title: "ls", kind: "execute",
        _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "ls" } },
      { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } },
      chunk("Answer one.", { messageId: "m2" }),
    ]);
    h.translator.promptEnded();
    expect(h.translator.settle()).toEqual({ itemId: "msg:m2", text: "Answer one." });
    expect(h.item("msg:m2", "agent_message").phase).toBe("final");
    expect(h.item("msg:m1", "agent_message").phase).toBe("unknown");

    // A steer re-prompts the same turn; the next settle picks the new answer and demotes the old.
    h.translator.steer([{ id: "st_1", taskId: "tsk_attempt", kind: "steer", content: "also check b.ts", authorType: "user",
      authorId: "mem_1", createdAt: new Date(T0).toISOString(), consumedAt: null }], REPROMPTED);
    h.feed([chunk("Answer two.", { messageId: "m3" })]);
    h.translator.promptEnded();
    expect(h.translator.settle()).toEqual({ itemId: "msg:m3", text: "Answer two." });
    expect(h.item("msg:m2", "agent_message").phase).toBe("unknown");
    expect(h.item("msg:m3", "agent_message").phase).toBe("final");
    expect(h.item("steer:st_1", "user_message")).toMatchObject({ origin: "steer",
      steer: { steer_id: "st_1", kind: "steer", injected: true, author_type: "user", author_id: "mem_1" } });
    expect(finalItem(h.state.items)?.id).toBe("msg:m3");
  });

  it("D-final: a turn that ended on a tool still takes its last message as the final", () => {
    const h = harness("claude").start().feed([
      chunk("Running it.", { messageId: "m1" }),
      { sessionUpdate: "tool_call", toolCallId: "t1", name: "Bash", status: "pending", title: "ls", kind: "execute",
        _meta: { claudeCode: { toolName: "Bash" } } },
    ]);
    h.translator.promptEnded();
    expect(h.translator.settle()).toEqual({ itemId: "msg:m1", text: "Running it." });
    expect(h.item("msg:m1", "agent_message").phase).toBe("final");

    // A steer round with a new reply moves the fallback pick like a rule-2 pick.
    h.translator.steer([{ id: "st_1", taskId: "tsk_attempt", kind: "steer", content: "go on", authorType: "user",
      authorId: "mem_1", createdAt: new Date(T0).toISOString(), consumedAt: null }], REPROMPTED);
    h.feed([chunk("Done.", { messageId: "m2" })]);
    h.translator.promptEnded();
    expect(h.translator.settle()).toEqual({ itemId: "msg:m2", text: "Done." });
    expect(h.item("msg:m1", "agent_message").phase).toBe("unknown");
  });

  it("rule 1: the last bridge-labelled final wins and earlier finals become commentary", () => {
    const air = (phase: string) => ({ _meta: { jetbrains: { air: { version: 1, phase } } } });
    const h = harness("codex").start().feed([
      chunk("Plan: fix it.", { messageId: "p1", ...air("final_answer") }),
      chunk("Working.", { messageId: "c1", ...air("commentary") }),
      chunk("Done.", { messageId: "f2", ...air("final_answer") }),
    ]);
    h.translator.promptEnded();
    expect(h.translator.settle()).toEqual({ itemId: "msg:f2", text: "Done." });
    expect(h.item("msg:p1", "agent_message").phase).toBe("commentary");
    expect(h.item("msg:c1", "agent_message").phase).toBe("commentary");
  });

  it("is idempotent when nothing changed", () => {
    const h = harness("claude").start().feed([chunk("Only answer.", { messageId: "m1" })]);
    h.translator.promptEnded();
    h.translator.settle();
    const count = h.events.length;
    expect(h.translator.settle()).toEqual({ itemId: "msg:m1", text: "Only answer." });
    expect(h.events.length).toBe(count);
  });
});

describe("trace translator: tools (claude-agent-acp 0.89 capture)", () => {
  const turn = () => {
    const h = harness("claude").start().feed(frames("claude-089-turn-notifications.json"));
    h.translator.promptEnded();
    return h;
  };

  it("classifies every tool and keeps one item per call", () => {
    const h = turn();
    const types = Object.fromEntries(h.state.items.filter((item) => item.id.startsWith("toolu_")).map((item) => [item.id, item.type]));
    expect(types).toEqual({
      toolu_bash_1: "command", toolu_read_1: "command", toolu_grep_1: "command", toolu_glob_1: "command",
      toolu_edit_1: "file_change", toolu_write_1: "file_change", toolu_websearch_1: "web_search",
      toolu_webfetch_1: "web_search", toolu_mcp_1: "tool", toolu_bash_2: "command",
    });
    expect(turnTraceStats(h.state.items).tool_call_count).toBe(10);
  });

  it("fills a Bash command that arrives late, parses it once and keeps the AIR exit code", () => {
    const h = turn();
    expect(h.item("toolu_bash_1", "command")).toMatchObject({
      tool: "Bash", source: "shell", command: "bun test tests/unit/math.test.ts", status: "failed", exit_code: 1,
      output: "1 fail\nexpected 4, got 5", actions: [{ type: "unknown", command: "bun test tests/unit/math.test.ts" }],
    });
    const started = h.events.find((event) => event.type === "item.started" && event.item.id === "toolu_bash_1");
    expect(started?.type === "item.started" && started.item.type === "command" && started.item.command).toBeNull();
    expect(h.events.some((event) => event.type === "item.updated" && event.item.id === "toolu_bash_1")).toBe(true);
    expect(h.events.some((event) => event.type === "item.delta" && event.item_id === "toolu_bash_1" && event.field === "output")).toBe(true);
    expect(h.item("toolu_bash_2", "command")).toMatchObject({ status: "completed", exit_code: 0, output: "1 pass" });
  });

  it("maps Read, Grep and Glob to command actions", () => {
    const h = turn();
    expect(h.item("toolu_read_1", "command")).toMatchObject({ source: "tool", command: null, output: null,
      actions: [{ type: "read", command: null, name: "math.ts", path: "/work/repo/src/math.ts" }] });
    expect(h.item("toolu_grep_1", "command").actions).toEqual([{ type: "search", command: null, query: "add\\(", path: "/work/repo/src" }]);
    expect(h.item("toolu_glob_1", "command")).toMatchObject({ actions: [{ type: "search", query: "**/*.test.ts", path: null }],
      output: "tests/unit/math.test.ts" });
  });

  it("builds file changes, and the PostToolUse hook's diff replaces the completed item", () => {
    const h = turn();
    const edit = h.item("toolu_edit_1", "file_change");
    expect(edit.status).toBe("completed");
    expect(edit.changes).toEqual([{ path: "/work/repo/src/math.ts", kind: "update", move_path: null,
      diff: "@@\n-export const add = (a, b) => a + b + 1;\n+export const add = (a, b) => a + b;", added: 1, removed: 1 }]);
    const completions = h.events.filter((event) => event.type === "item.completed" && event.item.id === "toolu_edit_1");
    expect(completions).toHaveLength(2);
    expect(h.item("toolu_write_1", "file_change").changes).toEqual([{ path: "/work/repo/notes/fix.md", kind: "add", move_path: null,
      diff: "@@\n+# Fix\n+\n+Removed the +1.", added: 3, removed: 0 }]);
  });

  it("maps web search, web fetch and MCP calls", () => {
    const h = turn();
    expect(h.item("toolu_websearch_1", "web_search")).toMatchObject({ action: "search", query: "bun test expect toBe", url: null,
      output: "Web search results for query: bun test" });
    expect(h.item("toolu_webfetch_1", "web_search")).toMatchObject({ action: "fetch", url: "https://bun.sh/docs/test" });
    expect(h.item("toolu_mcp_1", "tool")).toMatchObject({ tool: "mcp__github__search_issues", server: "github",
      input: { q: "add off by one" }, output: "[]" });
  });

  it("drops billing-only usage frames and reports context usage once per change", () => {
    const h = turn();
    const patches = h.events.filter((event) => event.type === "turn.updated").map((event) => event.type === "turn.updated" && event.patch);
    expect(patches).toEqual([{ context_usage: { used: 18200, size: 200000 } }, { context_usage: { used: 18950, size: 200000 } }]);
    h.feed([{ sessionUpdate: "usage_update", used: 18950, size: 200000 }]);
    expect(h.events.filter((event) => event.type === "turn.updated")).toHaveLength(2);
    expect(h.state.turn?.context_usage).toEqual({ used: 18950, size: 200000 });
  });

  it("keeps the first completion's duration when the hook re-emits the item", () => {
    const edit = (extra: Record<string, unknown>) => ({ _meta: { claudeCode: { toolName: "Edit" } }, toolCallId: "e1",
      sessionUpdate: "tool_call_update", ...extra });
    const h = harness("claude").start().feed([
      edit({ sessionUpdate: "tool_call", name: "Edit", status: "pending", title: "Edit", kind: "edit", content: [] }),
      edit({ rawInput: { file_path: "/r/a.ts" }, content: [{ type: "diff", path: "/r/a.ts", oldText: "a + 1", newText: "a" }] }),
      edit({ status: "completed", rawOutput: "updated" }),
      // Time passes before the PostToolUse hook re-sends the full diff.
      chunk("one", { messageId: "m1" }), chunk("two", { messageId: "m2" }), chunk("three", { messageId: "m3" }),
      edit({ content: [{ type: "diff", path: "/r/a.ts", oldText: "x = a + 1;", newText: "x = a;" }] }),
    ]);
    const durations = h.events.flatMap((event) =>
      event.type === "item.completed" && event.item.id === "e1" && event.item.type === "file_change" ? [event.item.duration_ms] : []);
    expect(durations).toHaveLength(2);
    expect(durations[0]).not.toBeNull();
    expect(durations[1]).toBe(durations[0]!);
  });

  it("maps Claude PowerShell to a shell command", () => {
    const h = harness("claude").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "ps_1", status: "pending", title: "Get-ChildItem", kind: "execute",
        _meta: { claudeCode: { toolName: "PowerShell" } }, rawInput: { command: "Get-ChildItem -Recurse" } },
      { sessionUpdate: "tool_call_update", toolCallId: "ps_1", _meta: { terminal_output: { data: "a.ts\n", terminal_id: "ps_1" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "ps_1", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } },
    ]);
    expect(h.item("ps_1", "command")).toMatchObject({ tool: "PowerShell", source: "shell", command: "Get-ChildItem -Recurse",
      status: "completed", exit_code: 0, output: "a.ts\n" });
  });

  it("stops the tools still open when a steer aborts the round, and only that round's", () => {
    const bash = (id: string, command: string) => ({ sessionUpdate: "tool_call", toolCallId: id, name: "Bash", status: "pending",
      title: command, kind: "execute", _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command } });
    const h = harness("claude").start().feed([bash("t0", "sleep 100")]);
    h.translator.promptEnded();
    expect(h.item("t0", "command").status).toBe("in_progress");

    h.feed([bash("t1", "sleep 1"), bash("t2", "ls"),
      { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } }]);
    h.translator.promptEnded({ aborted: true });
    expect(h.item("t1", "command")).toMatchObject({ status: "stopped" });
    expect(h.item("t1", "command").completed_at).not.toBeNull();
    expect(h.item("t2", "command").status).toBe("completed");
    // An earlier round's open call is not this round's to stop; the attempt's close handles it.
    expect(h.item("t0", "command").status).toBe("in_progress");

    // A round that ends normally leaves its open calls alone.
    h.feed([bash("t3", "make")]);
    h.translator.promptEnded({ aborted: false });
    expect(h.item("t3", "command").status).toBe("in_progress");
  });

  it("picks the closing message as the final reply", () => {
    const h = turn();
    expect(h.translator.settle()).toEqual({ itemId: "msg:msg_01C", text: "Fixed `add` in `src/math.ts`; the math tests pass now." });
  });
});

describe("trace translator: subagents", () => {
  it("nests a subagent's prose and tools under the Agent item (claude-agent-acp 0.89 capture)", () => {
    const h = harness("claude").start().feed(frames("claude-089-subagent-notifications.json"));
    h.translator.promptEnded();
    expect(h.item("toolu_agent_1", "subagent")).toMatchObject({ parent_id: null, tool: "Agent", title: "Find add callers",
      prompt: "List every caller of add()", status: "completed", output: "One caller: src/index.ts." });
    expect(h.item("toolu_sub_grep", "command").parent_id).toBe("toolu_agent_1");
    expect(h.item("rsn:msg_02S", "reasoning").parent_id).toBe("toolu_agent_1");
    expect(h.item("msg:msg_02S", "agent_message").parent_id).toBe("toolu_agent_1");
    // The subagent's own usage frame never becomes the turn's context usage.
    expect(h.events.some((event) => event.type === "turn.updated")).toBe(false);
    // Subagent text never competes for the answer.
    expect(h.translator.settle().itemId).toBe("msg:msg_02B");
  });

  it("keeps the Claude time-window fallback for unstamped calls inside the only open Agent", () => {
    const h = harness("claude").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "agent_1", name: "Agent", status: "pending", title: "Task", kind: "think",
        _meta: { claudeCode: { toolName: "Agent" } }, rawInput: { description: "look" } },
      { sessionUpdate: "tool_call", toolCallId: "glob_1", name: "Glob", status: "pending", title: "Find", kind: "search",
        _meta: { claudeCode: { toolName: "Glob" } }, rawInput: { pattern: "*.ts" } },
      { sessionUpdate: "tool_call", toolCallId: "agent_2", name: "Agent", status: "pending", title: "Task", kind: "think",
        _meta: { claudeCode: { toolName: "Agent" } } },
      { sessionUpdate: "tool_call", toolCallId: "glob_2", name: "Glob", status: "pending", title: "Find", kind: "search",
        _meta: { claudeCode: { toolName: "Glob" } } },
    ]);
    expect(h.item("glob_1").parent_id).toBe("agent_1");
    // Two Agents open: a guess would be worse than none.
    expect(h.item("glob_2").parent_id).toBeNull();
    // A spawn never nests itself.
    expect(h.item("agent_2").parent_id).toBeNull();
  });

  it("turns the time-window fallback off once the bridge stamped a parent: a parallel top-level tool stays top-level", () => {
    const agent = { sessionUpdate: "tool_call", toolCallId: "agent_1", name: "Agent", status: "pending", title: "Task", kind: "think",
      _meta: { claudeCode: { toolName: "Agent" } }, rawInput: { description: "look" } };
    const h = harness("claude").start().feed([
      agent,
      { sessionUpdate: "tool_call", toolCallId: "grep_1", name: "Grep", status: "pending", title: "grep", kind: "search",
        _meta: { claudeCode: { toolName: "Grep", parentToolUseId: "agent_1" } }, rawInput: { pattern: "add" } },
      // The main agent runs a Bash call in parallel while the Agent is still open.
      { sessionUpdate: "tool_call", toolCallId: "bash_1", name: "Bash", status: "pending", title: "ls", kind: "execute",
        _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "ls" } },
    ]);
    expect(h.item("agent_1", "subagent").status).toBe("in_progress");
    expect(h.item("grep_1").parent_id).toBe("agent_1");
    expect(h.item("bash_1").parent_id).toBeNull();

    // A stamped text chunk is enough too.
    const viaText = harness("claude").start().feed([
      agent,
      chunk("Searching.", { messageId: "s1", _meta: { claudeCode: { parentToolUseId: "agent_1" } } }),
      { sessionUpdate: "tool_call", toolCallId: "bash_2", name: "Bash", status: "pending", title: "ls", kind: "execute",
        _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "ls" } },
    ]);
    expect(viaText.item("msg:s1").parent_id).toBe("agent_1");
    expect(viaText.item("bash_2").parent_id).toBeNull();
  });

  it("completes a subagent's open text when the subagent completes", () => {
    const h = harness("claude").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "agent_1", name: "Agent", status: "pending", title: "Task", kind: "think",
        _meta: { claudeCode: { toolName: "Agent" } }, rawInput: { description: "look", prompt: "find callers" } },
      chunk("Found one caller.", { messageId: "s1", _meta: { claudeCode: { parentToolUseId: "agent_1" } } }),
      thought("checking", { messageId: "s1", _meta: { claudeCode: { parentToolUseId: "agent_1" } } }),
      chunk("Top-level prose.", { messageId: "m1" }),
      { sessionUpdate: "tool_call_update", toolCallId: "agent_1", status: "completed", rawOutput: "One caller." },
    ]);
    expect(h.item("msg:s1", "agent_message")).toMatchObject({ parent_id: "agent_1", status: "completed" });
    expect(h.item("rsn:s1", "reasoning")).toMatchObject({ parent_id: "agent_1", status: "completed" });
    // Its children end before it does; text at other levels is untouched.
    const order = h.events.flatMap((event) => event.type === "item.completed" ? [event.item.id] : []);
    expect(order.indexOf("msg:s1")).toBeLessThan(order.indexOf("agent_1"));
    expect(order.indexOf("rsn:s1")).toBeLessThan(order.indexOf("agent_1"));
    expect(h.item("msg:m1", "agent_message").status).toBe("in_progress");
  });

  it("keeps Codex flat (no subagent sessions advertised)", () => {
    const h = harness("codex").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "spawn", title: "spawnAgent", status: "in_progress", rawInput: { prompt: "x" } },
      { sessionUpdate: "tool_call", toolCallId: "cmd", kind: "execute", title: "ls", status: "in_progress", rawInput: { command: "ls" } },
    ]);
    expect(h.item("spawn", "subagent").parent_id).toBeNull();
    expect(h.item("cmd", "command").parent_id).toBeNull();
  });
});

describe("trace translator: codex-acp 2.2.2 frames", () => {
  const turn = () => {
    const h = harness("codex").start().feed(frames("codex-222-turn-notifications.json"));
    h.translator.promptEnded();
    return h;
  };

  it("streams shell output, keeps cwd, exit code and parsed actions", () => {
    const h = turn();
    expect(h.item("call_cmd1", "command")).toMatchObject({ tool: "exec_command", source: "shell", cwd: "/work/repo",
      command: "/bin/zsh -lc 'bun test tests/unit/math.test.ts'", output: "1 fail\nexpected 4, got 5\n", exit_code: 1, status: "failed",
      actions: [{ type: "unknown", command: "bun test tests/unit/math.test.ts" }] });
    expect(h.events.filter((event) => event.type === "item.delta" && event.item_id === "call_cmd1")).toHaveLength(1);
  });

  it("reads single-action reads, searches and lists from their titles", () => {
    const h = turn();
    expect(h.item("call_read1", "command")).toMatchObject({ command: null, output: null,
      actions: [{ type: "read", command: null, name: "math.ts", path: "/work/repo/src/math.ts" }] });
    expect(h.item("call_search1", "command")).toMatchObject({ actions: [{ type: "search", query: "add(", path: "src" }],
      output: "src/math.ts:1:export const add\n" });
    expect(h.item("call_list1", "command").actions).toEqual([{ type: "list_files", command: null, path: "src" }]);
  });

  it("merges per-hunk diffs of one file and keeps the add", () => {
    const h = turn();
    const patch = h.item("call_patch1", "file_change");
    expect(patch.changes.map((change) => [change.path, change.kind, change.added, change.removed])).toEqual([
      ["/work/repo/src/math.ts", "update", 2, 2], ["/work/repo/notes/fix.md", "add", 3, 0],
    ]);
  });

  it("maps web search, open page, MCP and a collab spawn", () => {
    const h = turn();
    expect(h.item("ws_1", "web_search")).toMatchObject({ action: "search", query: "bun test toBe", tool: "WebSearch" });
    expect(h.item("ws_2", "web_search")).toMatchObject({ action: "fetch", url: "https://bun.sh/docs/test", tool: "WebFetch" });
    expect(h.item("mcp_1", "tool")).toMatchObject({ server: "github", tool: "mcp.github.search_issues" });
    expect(h.item("call_spawn1", "subagent")).toMatchObject({ prompt: "Review the fix", status: "completed" });
  });

  it("keeps one plan item updated in place", () => {
    const h = turn();
    expect(h.ofType("plan")).toHaveLength(1);
    expect(h.item("plan", "plan")).toMatchObject({ status: "in_progress", entries: [
      { content: "Find the off-by-one", status: "completed", priority: "medium" },
      { content: "Fix add and sub", status: "completed", priority: "medium" },
    ] });
    expect(h.events.filter((event) => event.type === "item.updated" && event.item.id === "plan")).toHaveLength(1);
  });

  it("records notices and re-emits a session failure only for a higher revision", () => {
    const h = turn();
    expect(h.item("ntc:1", "notice")).toMatchObject({ severity: "warning", title: "Configuration warning",
      description: "model_reasoning_effort is ignored for this model", status: "completed" });
    expect(h.item("fail:turn_1:retry", "notice")).toMatchObject({ severity: "warning", title: "Reconnecting",
      description: "stream disconnected; retrying 2/5", category: "provider" });
    const before = h.events.length;
    h.feed([frames("codex-222-turn-notifications.json").find((frame) => (frame as { sessionUpdate: string }).sessionUpdate === "session_info_update")!]);
    expect(h.events.length).toBe(before);
  });

  it("settles on the bridge-labelled final answer", () => {
    const h = turn();
    expect(h.item("msg:msg_c1", "agent_message").phase).toBe("commentary");
    expect(h.translator.settle()).toEqual({ itemId: "msg:msg_c2", text: "Fixed `add` and `sub` in `src/math.ts`; both tests pass." });
  });
});

describe("trace translator: compaction (decision R11)", () => {
  it("rests on the committed capability evidence: both pinned bridges send compaction and notices only to clients that ask", () => {
    const evidence = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<string, unknown>;
    expect(evidence("claude-089-capability-evidence.json")).toEqual({ clientSupportsCompactionUpdates: true, clientSupportsNotices: true,
      withoutCapability: { compaction: false, notices: false } });
    expect(evidence("codex-222-capability-evidence.json")).toEqual({ supportsCompaction: true, supportsNotices: true,
      withoutCapability: { compaction: false, notices: false } });
  });

  it("follows the claude-agent-acp 0.89 compaction lifecycle", () => {
    const h = harness("claude").start().feed(frames("claude-089-compaction-notifications.json"));
    h.translator.promptEnded();
    expect(h.translator.sawCompaction).toBe(true);
    expect(h.item("cmp:cmp_uuid_1", "compaction")).toMatchObject({ status: "completed", trigger: "automatic",
      pre_tokens: 190000, post_tokens: 12000, error: null,
      // The summary streamed as compaction_summary_chunk is emitted only at completion.
      summary: "The user is fixing add(). Tests were failing by one." });
    expect(h.events.some((event) => event.type === "item.delta" && event.item_id === "cmp:cmp_uuid_1")).toBe(false);
    expect(h.item("cmp:cmp_uuid_2", "compaction")).toMatchObject({ status: "failed", error: "Conversation too long to compact" });
    expect(h.item("cmp:cmp_uuid_3", "compaction").status).toBe("stopped");
    expect(h.item("ntc:1", "notice")).toMatchObject({ severity: "warning", title: "Hook blocked the tool" });
    // Compaction never reaches message text.
    expect(h.ofType("agent_message").map((item) => item.text)).toEqual(["Working on it.", "Done after compaction."]);
  });

  it("follows the codex-acp 2.2.2 compaction lifecycle", () => {
    const h = harness("codex").start().feed(frames("codex-222-turn-notifications.json"));
    expect(h.translator.sawCompaction).toBe(true);
    expect(h.item("cmp:cmp_item_1", "compaction").status).toBe("completed");
    expect(h.item("cmp:compaction:turn_2", "compaction").status).toBe("completed");
    expect(h.item("cmp:cmp_item_3", "compaction")).toMatchObject({ status: "failed", error: "Codex ended the turn before compaction completed." });
  });

  it("reports no compaction for a turn without one", () => {
    const h = harness("claude").start().feed([chunk("plain", { messageId: "m" })]);
    expect(h.translator.sawCompaction).toBe(false);
  });
});

describe("trace translator: permissions and questions", () => {
  const bash = { sessionUpdate: "tool_call", toolCallId: "toolu_rm", name: "Bash", status: "pending", title: "rm -rf build", kind: "execute",
    _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "rm -rf build" } };
  const options = [
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "reject", name: "Reject", kind: "reject_once" as const },
  ];

  it("a declined permission declines the linked tool item", () => {
    const h = harness("claude").start().feed([chunk("Cleaning.", { messageId: "m1" }), bash]);
    const id = h.translator.permissionRequested({ decisionId: "dec_1", toolCallId: "toolu_rm", title: "rm -rf build", options });
    expect(id).toBe("perm:dec_1");
    expect(h.item(id, "permission")).toMatchObject({ status: "in_progress", tool_item_id: "toolu_rm", message_id: "dec_1",
      options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }, { option_id: "reject", name: "Reject", kind: "reject_once" }] });
    h.translator.permissionResolved(id, { option: options[1]!, outcome: "selected", respondedBy: "mem_1", replyMessageId: "rep_1" });
    expect(h.item(id, "permission")).toMatchObject({ status: "declined", outcome: "selected",
      decision: { option_id: "reject", name: "Reject", kind: "reject_once" }, responded_by: "mem_1", reply_message_id: "rep_1" });
    h.feed([{ sessionUpdate: "tool_call_update", toolCallId: "toolu_rm", status: "failed" }]);
    expect(h.item("toolu_rm", "command").status).toBe("declined");
  });

  it("a decline after the tool ended re-emits it with its first duration", () => {
    const h = harness("claude").start().feed([bash,
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_rm", status: "failed" }]);
    const first = h.item("toolu_rm", "command").duration_ms;
    expect(first).not.toBeNull();
    const id = h.translator.permissionRequested({ decisionId: "dec_5", toolCallId: "toolu_rm", title: "rm", options });
    h.feed([chunk("waiting", { messageId: "m9" })]);
    h.translator.permissionResolved(id, { option: options[1]!, outcome: "selected", respondedBy: null, replyMessageId: null });
    expect(h.item("toolu_rm", "command")).toMatchObject({ status: "declined", duration_ms: first });
  });

  it("an allowed permission completes and leaves the tool alone", () => {
    const h = harness("claude").start().feed([bash]);
    const id = h.translator.permissionRequested({ decisionId: "dec_2", toolCallId: "toolu_rm", title: "rm", options });
    h.translator.permissionResolved(id, { option: options[0]!, outcome: "selected", respondedBy: null, replyMessageId: null });
    h.feed([{ sessionUpdate: "tool_call_update", toolCallId: "toolu_rm", status: "completed" }]);
    expect(h.item(id, "permission").status).toBe("completed");
    expect(h.item("toolu_rm", "command").status).toBe("completed");
  });

  it("a timed-out permission stops", () => {
    const h = harness("claude").start().feed([bash]);
    const id = h.translator.permissionRequested({ decisionId: "dec_3", toolCallId: "toolu_rm", title: "rm", options });
    h.translator.permissionResolved(id, { option: null, outcome: "timeout", respondedBy: null, replyMessageId: null });
    expect(h.item(id, "permission")).toMatchObject({ status: "stopped", outcome: "timeout", decision: null });
  });

  it("suppresses Claude's AskUserQuestion tool call; the question item stands for it", () => {
    const h = harness("claude").start();
    const id = h.translator.questionRequested({ decisionId: "dec_q", toolCallId: "toolu_ask_1", message: "Which file?",
      questions: [{ question: "Which file?" }] });
    h.feed(frames("claude-089-interaction-notifications.json"));
    h.translator.questionResolved(id, { answers: { "Which file?": "a.ts" }, respondedBy: "mem_1", replyMessageId: "rep_q" });
    expect(h.state.items.some((item) => item.id === "toolu_ask_1")).toBe(false);
    expect(h.item(id, "question")).toMatchObject({ tool_item_id: "toolu_ask_1", status: "completed",
      answers: { "Which file?": "a.ts" }, responded_by: "mem_1" });
    // The interrupted command in the same capture.
    expect(h.item("toolu_bash_3", "command")).toMatchObject({ status: "failed", exit_code: 1,
      output: "[Command was aborted before completion]" });
  });

  it("orders a permission after the text streamed before it", () => {
    const h = harness("claude").start().feed([chunk("About to delete.", { messageId: "m1" })]);
    h.translator.permissionRequested({ decisionId: "dec_4", toolCallId: null, title: "rm", options });
    const types = h.events.map((event) => event.type === "item.delta" ? "delta" : `${event.type}:${"item" in event ? event.item.id : ""}`);
    expect(types.slice(2)).toEqual(["item.started:msg:m1", "delta", "item.completed:msg:m1", "item.started:perm:dec_4"]);
  });
});

describe("trace translator: coalescing", () => {
  it("buffers deltas of one item and flushes them before any other event", () => {
    const h = harness("claude").start();
    h.feed([chunk("a", { messageId: "m1" }), chunk("b", { messageId: "m1" }), chunk("c", { messageId: "m1" })]);
    const deltasSoFar = h.events.filter((event) => event.type === "item.delta");
    expect(deltasSoFar).toHaveLength(0);
    h.feed([{ sessionUpdate: "tool_call", toolCallId: "t1", name: "Bash", status: "pending", title: "Terminal", kind: "execute",
      _meta: { claudeCode: { toolName: "Bash" } } }]);
    const tail = h.events.slice(-4).map((event) => event.type);
    expect(tail).toEqual(["item.started", "item.delta", "item.completed", "item.started"]);
    const delta = h.events.find((event) => event.type === "item.delta");
    expect(delta).toMatchObject({ item_id: "msg:m1", field: "text", delta: "abc" });
  });

  it("flushes on the interval", async () => {
    const h = harness("claude", { flushIntervalMs: 5 }).start();
    h.feed([chunk("tick", { messageId: "m1" })]);
    expect(h.events.some((event) => event.type === "item.delta")).toBe(false);
    await Bun.sleep(30);
    expect(h.events.find((event) => event.type === "item.delta")).toMatchObject({ delta: "tick" });
  });

  it("flushes at 16 KiB and splits a delta over 64 KiB", () => {
    const h = harness("claude").start();
    h.feed([chunk("x".repeat(TRACE_DELTA_BUFFER_BYTES), { messageId: "m1" })]);
    expect(h.events.filter((event) => event.type === "item.delta")).toHaveLength(1);
    h.feed([chunk("é".repeat(TRACE_DELTA_MAX_BYTES), { messageId: "m1" })]);
    const deltas = h.events.filter((event) => event.type === "item.delta");
    expect(deltas.length).toBe(3);
    for (const delta of deltas) {
      expect(delta.type === "item.delta" && utf8ByteLength(delta.delta)).toBeLessThanOrEqual(TRACE_DELTA_MAX_BYTES);
    }
  });

  it("a delta for another item flushes the pending one first", () => {
    const h = harness("claude").start();
    h.feed([chunk("one", { messageId: "m1", _meta: { claudeCode: { parentToolUseId: "a" } } }),
      chunk("two", { messageId: "m2", _meta: { claudeCode: { parentToolUseId: "b" } } })]);
    h.translator.flush();
    const deltas = h.events.filter((event) => event.type === "item.delta").map((event) => event.type === "item.delta" && [event.item_id, event.delta]);
    expect(deltas).toEqual([["msg:m1", "one"], ["msg:m2", "two"]]);
  });
});

describe("trace translator: caps", () => {
  it("stops text deltas at the cap and completes with the marker", () => {
    const h = harness("codex").start();
    const big = "y".repeat(100 * 1024);
    h.feed([chunk(big, { messageId: "m1" }), chunk(big, { messageId: "m1" }), chunk(big, { messageId: "m1" })]);
    h.translator.promptEnded();
    const item = h.item("msg:m1", "agent_message");
    expect(item.truncated).toBe(true);
    expect(item.text).toBe("y".repeat(TRACE_ITEM_TEXT_MAX_BYTES) + TRACE_TRUNCATION_MARKER);
    const streamed = h.events.filter((event) => event.type === "item.delta").reduce((sum, event) => sum + (event.type === "item.delta" ? utf8ByteLength(event.delta) : 0), 0);
    expect(streamed).toBe(TRACE_ITEM_TEXT_MAX_BYTES);
  });

  it("keeps the head and tail of a long command output", () => {
    const h = harness("codex").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: "yes", status: "in_progress", rawInput: { command: "yes" },
        _meta: { terminal_info: { cwd: "/r", terminal_id: "c1" } } },
    ]);
    for (let i = 0; i < 20; i++) {
      h.feed([{ sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output: { data: `${String(i).padStart(2, "0")}${"z".repeat(8 * 1024)}\n`, terminal_id: "c1" } } }]);
    }
    h.feed([{ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } }]);
    const item = h.item("c1", "command");
    expect(item.output_truncated).toBe(true);
    expect(item.output!.startsWith("00z")).toBe(true);
    expect(item.output!.endsWith("z\n")).toBe(true);
    expect(item.output).toContain(TRACE_TRUNCATION_MARKER);
    expect(item.output).toContain("19");
    expect(utf8ByteLength(item.output!)).toBeLessThanOrEqual(TRACE_ITEM_OUTPUT_MAX_BYTES + 64);
    const streamed = h.events.filter((event) => event.type === "item.delta").reduce((sum, event) => sum + (event.type === "item.delta" ? utf8ByteLength(event.delta) : 0), 0);
    expect(streamed).toBeLessThanOrEqual(TRACE_ITEM_OUTPUT_MAX_BYTES);
  });

  it("keeps the head of an output that overflows in a single chunk", () => {
    const h = harness("codex").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: "cat", status: "in_progress", rawInput: { command: "cat big" },
        _meta: { terminal_info: { cwd: "/r", terminal_id: "c1" } } },
    ]);
    const data = `HEAD${"h".repeat(20 * 1024)}${"m".repeat(200 * 1024)}${"t".repeat(50 * 1024)}TAIL`;
    expect(utf8ByteLength(data)).toBeGreaterThanOrEqual(200 * 1024);
    h.feed([
      { sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output: { data, terminal_id: "c1" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } },
    ]);
    const item = h.item("c1", "command");
    expect(item.output_truncated).toBe(true);
    const [head, tail] = item.output!.split(`\n${TRACE_TRUNCATION_MARKER}\n`);
    expect(head).toBe(data.slice(0, TRACE_ITEM_OUTPUT_HEAD_BYTES));
    expect(tail).toBe(data.slice(-TRACE_ITEM_OUTPUT_TAIL_BYTES));
    // Nothing of the overflowing chunk streams; the completion carries it.
    expect(h.events.some((event) => event.type === "item.delta" && event.item_id === "c1")).toBe(false);
  });

  it("caps a 600 KiB heredoc command so no event is dropped", () => {
    const heredoc = `cat <<'EOF' > big.txt\n${"x".repeat(600 * 1024)}\nEOF`;
    const h = harness("claude").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "toolu_big", name: "Bash", status: "pending", title: "Terminal", kind: "execute",
        _meta: { claudeCode: { toolName: "Bash" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_big", title: heredoc, rawInput: { command: heredoc } },
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_big", status: "completed", _meta: { terminal_exit: { exit_code: 0 } } },
    ]);
    const item = h.item("toolu_big", "command");
    expect(item).toMatchObject({ status: "completed", exit_code: 0, command_truncated: true });
    expect(item.command!.startsWith("cat <<'EOF' > big.txt\n")).toBe(true);
    expect(utf8ByteLength(item.command!)).toBe(TRACE_ITEM_COMMAND_MAX_BYTES + utf8ByteLength(TRACE_TRUNCATION_MARKER));
    expect(item.actions.every((action) => action.command === null || utf8ByteLength(action.command) <= TRACE_ITEM_COMMAND_MAX_BYTES + 32)).toBe(true);
    const events = h.events.filter((event) => "item" in event && event.item.id === "toolu_big");
    expect(events.map((event) => event.type)).toEqual(["item.started", "item.updated", "item.completed"]);
    for (const event of events) {
      expect(utf8ByteLength(JSON.stringify(event))).toBeLessThan(TRACE_EVENT_MAX_BYTES);
      // The store's re-check keeps the event as it is.
      expect(capTraceEvent(event)).toEqual(event);
    }
  });
});

// Frames as recorded from claude-agent-acp 0.89.0 with Remi's capabilities
// (SUBAGENT-LIVE-PROBE runs A and A-bg; 0.90.0 sends the same frames on these
// paths) and from codex-acp 2.2.2 (run A). Long texts are shortened.
const AGENT = "toolu_01KHEhzBZQ61AHmRGz2TjPyb";
const CHILD_BASH = "toolu_01AUA4wk4GUdeSRFz5uSudDj";
const agentFrames = (background: boolean) => [
  { sessionUpdate: "tool_call", toolCallId: AGENT, name: "Agent", status: "pending", title: "Task", kind: "think", content: [],
    _meta: { claudeCode: { toolName: "Agent" }, jetbrains: { air: { version: 1, subagent: true } } } },
  { sessionUpdate: "tool_call_update", toolCallId: AGENT, title: "Count files in directory" },
  { sessionUpdate: "tool_call_update", toolCallId: AGENT,
    rawInput: { description: "Count files in directory", prompt: "List the files in the current working directory and report how many there are.",
      subagent_type: "general-purpose", run_in_background: background },
    content: [{ type: "content", content: { type: "text", text: "List the files in the current working directory and report how many there are." } }] },
];
const childFrames = [
  { sessionUpdate: "tool_call", toolCallId: CHILD_BASH, name: "Bash", status: "pending", title: "ls -A /work", kind: "execute",
    rawInput: { command: "ls -A /work", description: "List all files including hidden" },
    content: [{ type: "terminal", terminalId: CHILD_BASH }],
    _meta: { claudeCode: { toolName: "Bash", parentToolUseId: AGENT }, jetbrains: { air: { version: 1, commandTitle: "List all files including hidden" } },
      terminal_info: { terminal_id: CHILD_BASH } } },
  { sessionUpdate: "tool_call_update", toolCallId: CHILD_BASH, _meta: { terminal_output: { terminal_id: CHILD_BASH, data: "a.txt\nb.txt\nnotes.md" } } },
  { sessionUpdate: "tool_call_update", toolCallId: CHILD_BASH, status: "completed",
    _meta: { terminal_exit: { terminal_id: CHILD_BASH, exit_code: 0, signal: null } } },
  chunk("The directory contains 3 files.", { messageId: "msg_011Cg3L52RFzACKf3wKTGpnu", _meta: { claudeCode: { parentToolUseId: AGENT } } }),
];
const LAUNCH_ACK = "Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a6d91312b45bfd273\n"
  + "The agent is working in the background. You will be notified automatically when it completes.";

describe("trace translator: subagents and labels (spec §13)", () => {
  it("keeps a background subagent running past its launch acknowledgement (A-bg)", () => {
    const h = harness("claude").start().feed([
      ...agentFrames(true),
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, _meta: { claudeCode: { toolResponse: { status: "async_launched", isAsync: true } } } },
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, status: "completed", content: [{ type: "content", content: { type: "text", text: LAUNCH_ACK } }] },
      ...childFrames,
      chunk("I've started a background agent to count the files.", { messageId: "msg_011Cg3L5C3wp9earxs13XHeR" }),
      chunk("3", { messageId: "msg_011Cg3L5HXbFror2r1ZdReTx" }),
    ]);
    h.translator.promptEnded();
    const agent = h.item(AGENT, "subagent");
    expect(agent).toMatchObject({ status: "in_progress", completed_at: null, output: null, background: true,
      agent_type: "general-purpose", name: "Count files in directory", title: "Count files in directory" });
    expect(h.events.some((event) => event.type === "item.completed" && event.item.id === AGENT)).toBe(false);
    // Its children stream under it; the child command is labelled by the model.
    expect(h.item(CHILD_BASH, "command")).toMatchObject({ parent_id: AGENT, status: "completed", title: "List all files including hidden",
      command: "ls -A /work", exit_code: 0 });
    // An aborted later round does not cut it short: its call already returned.
    h.translator.roundAborted();
    h.translator.promptEnded({ aborted: true });
    expect(h.item(AGENT, "subagent").status).toBe("in_progress");
    // The turn's end is its end: completed (with its duration) when the turn
    // completed; a failed or cancelled turn may have cut it short.
    const [closed] = closeOpenItems(h.state.items, "completed", new Date(T0 + 60_000).toISOString());
    expect(closed).toMatchObject({ type: "item.completed", item: { id: AGENT, status: "completed", output: null, background: true } });
    expect((closed as { item: { duration_ms: number } }).item.duration_ms).toBeGreaterThan(0);
    for (const status of ["failed", "cancelled"] as const) {
      expect(closeOpenItems(h.state.items, status, new Date(T0 + 60_000).toISOString())[0], status)
        .toMatchObject({ item: { id: AGENT, status: "stopped" } });
    }
  });

  it("lets a background subagent's step outlive a steer and complete on its own frames", () => {
    const SLEEP = "toolu_child_sleep";
    const h = harness("claude").start().feed([
      ...agentFrames(true),
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, _meta: { claudeCode: { toolResponse: { status: "async_launched", isAsync: true } } } },
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, status: "completed", content: [{ type: "content", content: { type: "text", text: LAUNCH_ACK } }] },
      { sessionUpdate: "tool_call", toolCallId: SLEEP, name: "Bash", status: "pending", title: "sleep 25; ls -A /work", kind: "execute",
        rawInput: { command: "sleep 25; ls -A /work", description: "Sleep 25s then list directory" },
        content: [{ type: "terminal", terminalId: SLEEP }],
        _meta: { claudeCode: { toolName: "Bash", parentToolUseId: AGENT }, jetbrains: { air: { version: 1, commandTitle: "Sleep 25s then list directory" } },
          terminal_info: { terminal_id: SLEEP } } },
    ]);
    // The user steers the root while the background child sleeps.
    h.translator.roundAborted();
    h.translator.promptEnded({ aborted: true });
    expect(h.item(SLEEP, "command").status).toBe("in_progress");
    expect(h.item(AGENT, "subagent").status).toBe("in_progress");
    // The child finishes during the next round: its output and status apply.
    h.feed([
      { sessionUpdate: "tool_call_update", toolCallId: SLEEP, _meta: { terminal_output: { terminal_id: SLEEP, data: "a.txt\nb.txt\nnotes.md" } } },
      { sessionUpdate: "tool_call_update", toolCallId: SLEEP, status: "completed", _meta: { terminal_exit: { terminal_id: SLEEP, exit_code: 0, signal: null } } },
    ]);
    expect(h.item(SLEEP, "command")).toMatchObject({ status: "completed", exit_code: 0, output: "a.txt\nb.txt\nnotes.md", parent_id: AGENT });
  });

  it("a native steer into a turn held for a background subagent stops nothing (ADR 0020)", () => {
    const SLEEP = "toolu_child_sleep";
    const h = harness("claude").start().feed([
      ...agentFrames(true),
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, _meta: { claudeCode: { toolResponse: { status: "async_launched", isAsync: true } } } },
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, status: "completed", content: [{ type: "content", content: { type: "text", text: LAUNCH_ACK } }] },
      { sessionUpdate: "tool_call", toolCallId: SLEEP, name: "Bash", status: "pending", title: "sleep 25; ls -A /work", kind: "execute",
        rawInput: { command: "sleep 25; ls -A /work" }, content: [{ type: "terminal", terminalId: SLEEP }],
        _meta: { claudeCode: { toolName: "Bash", parentToolUseId: AGENT }, terminal_info: { terminal_id: SLEEP } } },
      chunk("I've started a background agent to count the files.", { messageId: "m_root_1" }),
    ]);
    // Injected into the held prompt: no roundAborted, the prompt keeps running.
    h.translator.steer([{ id: "st_held", taskId: "tsk_attempt", kind: "steer", content: "also report the sizes", authorType: "user",
      authorId: "mem_1", createdAt: new Date(T0).toISOString(), consumedAt: null }], { via: "native", native_outcome: "injected", error: null });
    h.feed([
      { sessionUpdate: "tool_call_update", toolCallId: SLEEP, status: "completed", _meta: { terminal_exit: { terminal_id: SLEEP, exit_code: 0, signal: null } } },
      chunk("3 files, 12 bytes in total.", { messageId: "m_root_2" }),
    ]);
    h.translator.promptEnded();
    expect(h.item(SLEEP, "command")).toMatchObject({ status: "completed", exit_code: 0 });
    expect(h.item(AGENT, "subagent").status).toBe("in_progress");
    expect(h.state.items.filter((item) => item.parent_id === null).map((item) => item.id))
      .toEqual(["in:tsk_attempt", AGENT, "msg:m_root_1", "steer:st_held", "msg:m_root_2"]);
    expect(h.translator.settle()).toEqual({ itemId: "msg:m_root_2", text: "3 files, 12 bytes in total." });
    expect(h.state.items.some((item) => item.status === "stopped")).toBe(false);
  });

  it("never guesses a background subagent as the parent of an unstamped root tool", () => {
    const h = harness("claude").start().feed([
      ...agentFrames(true),
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, _meta: { claudeCode: { toolResponse: { status: "async_launched", isAsync: true } } } },
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, status: "completed", content: [{ type: "content", content: { type: "text", text: LAUNCH_ACK } }] },
      // The root keeps working before any stamped child frame arrives.
      { sessionUpdate: "tool_call", toolCallId: "toolu_root", name: "Read", status: "pending", title: "Read a.ts", kind: "read",
        rawInput: { file_path: "/w/a.ts" }, _meta: { claudeCode: { toolName: "Read" } } },
    ]);
    expect(h.item("toolu_root", "command").parent_id).toBeNull();
  });

  it("completes a foreground subagent with its result (A)", () => {
    const h = harness("claude").start().feed([
      ...agentFrames(false), ...childFrames,
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, _meta: { claudeCode: { toolResponse: { status: "completed" } } } },
      { sessionUpdate: "tool_call_update", toolCallId: AGENT, status: "completed",
        content: [{ type: "content", content: { type: "text", text: "There are 3 entries. **Total: 3.**" } }] },
    ]);
    expect(h.item(AGENT, "subagent")).toMatchObject({ status: "completed", output: "There are 3 entries. **Total: 3.**", background: false,
      agent_type: "general-purpose" });
  });

  it("records the Codex subagent thread and name (codex-acp 2.2.2 run A)", () => {
    const h = harness("codex").start().feed([
      { sessionUpdate: "tool_call", toolCallId: "call_ad5f", kind: "other", title: "Start subagent count_files", status: "in_progress",
        rawInput: { agentThreadId: "01a13da2-2fd7-72f2-a0a9-4ff3bbdb03f8", agentPath: "/root/count_files", activityKind: "started" },
        _meta: { jetbrains: { air: { version: 1, subagent: true } } } },
      { sessionUpdate: "tool_call_update", toolCallId: "call_ad5f", status: "completed" },
      { sessionUpdate: "tool_call", toolCallId: "call_ae5b", kind: "other", title: "wait", status: "in_progress",
        rawInput: { prompt: null, senderThreadId: "01a13da1-fb97", receiverThreadIds: [], agentsStates: {}, model: null, reasoningEffort: null } },
      { sessionUpdate: "tool_call_update", toolCallId: "call_ae5b", status: "completed" },
    ]);
    expect(h.item("call_ad5f", "subagent")).toMatchObject({ status: "completed", name: "count_files",
      thread_id: "01a13da2-2fd7-72f2-a0a9-4ff3bbdb03f8" });
    // PR 5 §3.6: `wait` acts on agents; it is a (hidden) tool row, not a subagent.
    expect(h.item("call_ae5b", "tool")).toMatchObject({ tool: "wait", status: "completed" });
  });

  describe("a call the abort cut short (claude-agent-acp 0.90 closes it failed)", () => {
    const bash = (id: string) => ({ sessionUpdate: "tool_call", toolCallId: id, name: "Bash", status: "pending", title: "sleep 30", kind: "execute",
      rawInput: { command: "sleep 30", description: "Wait for the build" }, content: [{ type: "terminal", terminalId: id }],
      _meta: { claudeCode: { toolName: "Bash" }, terminal_info: { terminal_id: id } } });
    const unfinished = (id: string, text: string) =>
      ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", content: [{ type: "content", content: { type: "text", text } }] });

    it("ends stopped after a steer interrupt", () => {
      const h = harness("claude").start().feed([bash("toolu_steer")]);
      h.translator.roundAborted();
      h.feed([unfinished("toolu_steer", "Claude stopped this tool call before it ran.")]);
      h.translator.promptEnded({ aborted: true });
      expect(h.item("toolu_steer", "command")).toMatchObject({ status: "stopped", exit_code: null, title: "Wait for the build" });
    });

    it("ends stopped when the turn is cancelled", () => {
      const h = harness("claude").start().feed([bash("toolu_cancel")]);
      h.translator.roundAborted();
      h.feed([unfinished("toolu_cancel", "The turn was cancelled before this tool call returned a result.")]);
      h.translator.promptEnded({ aborted: true });
      expect(h.item("toolu_cancel", "command").status).toBe("stopped");
    });

    // claude-agent-acp 0.90 with AIR: the interrupt result of a running command
    // (CA/tool-calls/renderer.js terminal_exit, reporters/bash.js abort marker).
    const interrupted = (id: string) => [
      { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", _meta: {
        terminal_info: { terminal_id: id },
        terminal_output: { terminal_id: id, data: "building…\n[Command was aborted before completion]" },
        terminal_exit: { terminal_id: id, exit_code: 1, signal: null } } },
    ];

    it("ends a running command the abort interrupted stopped, without AIR's exit code 1", () => {
      const h = harness("claude").start().feed([bash("toolu_running")]);
      h.translator.roundAborted();
      h.feed(interrupted("toolu_running"));
      h.translator.promptEnded({ aborted: true });
      expect(h.item("toolu_running", "command")).toMatchObject({ status: "stopped", exit_code: null,
        output: "building…\n[Command was aborted before completion]" });
    });

    it("keeps genuine failures failed", () => {
      const h = harness("claude").start().feed([
        bash("toolu_plain"), unfinished("toolu_plain", "Claude ended the turn without returning a result for this tool."),
        bash("toolu_marker"), ...interrupted("toolu_marker"),
        bash("toolu_exit"),
      ]);
      // The abort marker outside an abort is Claude Code's own interrupt: a failure.
      expect(h.item("toolu_marker", "command")).toMatchObject({ status: "failed", exit_code: 1 });
      // No abort: a failure is a failure.
      expect(h.item("toolu_plain", "command").status).toBe("failed");
      // During an abort, a call with its own exit code or output still failed.
      h.translator.roundAborted();
      h.feed([
        { sessionUpdate: "tool_call_update", toolCallId: "toolu_exit", _meta: { terminal_output: { terminal_id: "toolu_exit", data: "boom" } } },
        { sessionUpdate: "tool_call_update", toolCallId: "toolu_exit", status: "failed", _meta: { terminal_exit: { terminal_id: "toolu_exit", exit_code: 1, signal: null } } },
      ]);
      h.translator.promptEnded({ aborted: true });
      expect(h.item("toolu_exit", "command")).toMatchObject({ status: "failed", exit_code: 1 });
      // The next round is not aborted any more.
      h.feed([bash("toolu_next"), unfinished("toolu_next", "Claude ended the turn without returning a result for this tool.")]);
      expect(h.item("toolu_next", "command").status).toBe("failed");
    });
  });
});

describe("trace translator: Antigravity (antigravity-acp 1.4.0, PR 4 §5)", () => {
  // The provider drops the server's own usage_update (its `used` double-counts
  // the cache) and replaces it with shim observations, so the translator never
  // sees one.
  const live = () => frames("antigravity-140-turn-notifications.json")
    .filter((frame) => (frame as { sessionUpdate: string }).sessionUpdate !== "usage_update");

  it("maps one recorded turn to command, file change, search, tool and message items", () => {
    const h = harness("antigravity").start().feed(live());
    h.translator.promptEnded();
    expect(h.item("0446f287f8f345bebe093a06340941f3", "command")).toMatchObject({
      status: "completed", tool: "run_command", source: "shell", command: "ls -la", cwd: "/tmp/agy-live/work",
      // Server 1.4.0 publishes it as rawOutput.exit_code.
      exit_code: 0, output: expect.stringContaining("README.md"),
      actions: [{ type: "list_files", command: "ls -la", path: null }],
    });
    expect(h.item("a1f0c2d4e5b64a7f8c9d0e1f2a3b4c5d", "command")).toMatchObject({ tool: "view_file", source: "tool",
      actions: [{ type: "read", path: "/tmp/agy-live/work/README.md", name: "README.md" }] });
    expect(h.item("b2e1d3c5f6a74b8e9d0f1a2b3c4d5e6f", "command")).toMatchObject({ tool: "grep_search",
      actions: [{ type: "search", query: "alpha", path: "/tmp/agy-live/work" }] });
    expect(h.item("c3f2e4d6a7b85c9f0e1a2b3c4d5e6f70", "command")).toMatchObject({ tool: "list_dir",
      actions: [{ type: "list_files", path: "/tmp/agy-live/work" }] });
    expect(h.item("d4a3f5e7b8c96d0a1f2b3c4d5e6f7081", "file_change")).toMatchObject({ tool: "write_to_file",
      changes: [{ path: "/tmp/agy-live/work/summary.md", kind: "add", added: 3, removed: 0 }] });
    expect(h.item("e5b4a6f8c9d07e1b2a3c4d5e6f708192", "file_change")).toMatchObject({ tool: "replace_file_content",
      changes: [{ path: "/tmp/agy-live/work/notes.txt", kind: "update", diff: "@@\n-beta\n+BETA" }] });
    expect(h.item("f6c5b7a9d0e18f2c3b4d5e6f70819203", "web_search")).toMatchObject({ tool: "search_web", action: "search", query: "agent client protocol" });
    expect(h.item("07d6c8b0e1f2903d4c5e6f7081920314", "web_search")).toMatchObject({ tool: "read_url_content", action: "fetch", url: "https://agentclientprotocol.com/" });
    expect(h.item("18e7d9c1f2a3014e5d6f708192031425", "tool")).toMatchObject({ tool: "search_issues", server: "github", output: "2 issues" });
    expect(h.item("29f8e0d2a3b4125f6e708192031425a6", "tool")).toMatchObject({ tool: "browser_subagent", server: null });
    // The ask_user stand-in is shown as the question item (provider elicitation), not as a tool.
    expect(h.state.items.some((item) => item.id === "interaction_ab12cd34")).toBe(false);
    // Chunks without message ids form one message after the last tool.
    const messages = h.ofType("agent_message");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("### Files\n- README.md\n- notes.txt\n\nThe workspace exists only to test an ACP client.");
    // No phase: the shared final-reply rule picks the last message.
    expect(h.translator.settle()).toMatchObject({ itemId: messages[0]!.id });
  });

  it("parses replayed JSON-string input and its model-written summary", () => {
    // The provider drops replayed updates (outside an active prompt); the input shape still has to parse.
    const h = harness("antigravity").start().feed(frames("antigravity-140-replay-notifications.json"));
    h.translator.promptEnded();
    expect(h.item("call_1707387", "command")).toMatchObject({ command: "ls -la", cwd: "/tmp/agy-live/work", title: "List files" });
    expect(h.item("call_1707388", "command")).toMatchObject({ tool: "view_file", actions: [{ type: "read", path: "/tmp/agy-live/work/README.md" }] });
  });

  it("records the provider's typed failure for a service message, not the raw text", () => {
    // What AcpProvider forwards for antigravity-140-service-notifications.json: the
    // chunk is dropped and a session failure takes its place.
    const failure = { id: "antigravity:service:1", revision: 1, severity: "error", category: "authentication", errorKind: "authentication_failed",
      title: "Antigravity gateway rejected the credentials", details: "401 Unauthorized: API key not valid. Please pass a valid API key." };
    const h = harness("antigravity").start().feed([{ sessionUpdate: "session_info_update", _meta: { jetbrains: { air: { sessionFailure: failure } } } }]);
    h.translator.promptEnded();
    expect(h.item("fail:antigravity:service:1", "notice")).toMatchObject({ severity: "error", category: "authentication",
      error_kind: "authentication_failed", description: failure.details });
    expect(h.ofType("agent_message")).toEqual([]);
  });

  it("takes context from the provider's shim usage, cached tokens included", () => {
    const h = harness("antigravity").start().feed([
      { sessionUpdate: "usage_update", used: 139_978, size: 1_048_576, _meta: { remiUsageMode: "request" } },
      // A billing-only observation (another model's call) leaves context alone.
      { sessionUpdate: "usage_update", used: 0, size: 0, _meta: { remiUsageMode: "request" } },
    ]);
    expect(h.state.turn?.context_usage).toEqual({ used: 139_978, size: 1_048_576 });
  });
});

describe("trace translator: every recorded fixture", () => {
  // Capability evidence files sit beside the frames they vouch for; they hold no frames.
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".json") && !name.endsWith("-capability-evidence.json")).sort();

  it("finds the recorded fixtures", () => {
    expect(names.length).toBeGreaterThanOrEqual(25);
  });

  for (const name of names) {
    it(`emits only valid events for ${name}`, () => {
      const agentType = name.startsWith("codex") ? "codex" : name.startsWith("antigravity") ? "antigravity" : "claude";
      const h = harness(agentType).start().feed(frames(name));
      h.translator.promptEnded();
      h.translator.settle();
      for (const batch of h.batches) {
        for (const body of batch) expect(isTraceEventBody(body), JSON.stringify(body).slice(0, 300)).toBe(true);
      }
      for (const item of h.state.items) {
        expect(isTraceItem(item), JSON.stringify(item).slice(0, 300)).toBe(true);
        if (item.type === "agent_message" || item.type === "reasoning") expect(item.status).not.toBe("in_progress");
      }
      // Each tool call is one item.
      const ids = h.state.items.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }
});

describe("trace translator: steer results (ADR 0020)", () => {
  const steerMessage = (id: string, kind: "steer" | "force_answer" = "steer") => ({ id, taskId: "tsk_attempt", kind,
    content: kind === "steer" ? `steer ${id}` : "", authorType: "user", authorId: "mem_1",
    createdAt: new Date(T0).toISOString(), consumedAt: null });

  it("records how each steer was delivered, and the record round-trips", () => {
    const h = harness("claude").start().feed([chunk("Working on it.", { messageId: "m1" })]);
    // Native: injected mid-stream, between the reply it cut short and the one answering it.
    h.translator.steer([steerMessage("st_native")], { via: "native", native_outcome: "injected", error: null });
    h.feed([chunk("Steered answer.", { messageId: "m2" })]);
    h.translator.promptEnded();
    h.translator.steer([steerMessage("st_re")], { via: "reprompt", native_outcome: "failed", error: "x".repeat(2_000) });
    h.translator.steer([steerMessage("wrap_up:1", "force_answer")], { via: "none", native_outcome: null, error: null });
    h.translator.settle();

    expect(h.state.items.map((item) => item.id)).toEqual(["in:tsk_attempt", "msg:m1", "steer:st_native", "msg:m2",
      "steer:st_re", "steer:wrap_up:1"]);
    expect(h.item("steer:st_native", "user_message")).toMatchObject({ origin: "steer", status: "completed", text: "steer st_native",
      steer: { steer_id: "st_native", kind: "steer", injected: true, author_type: "user", author_id: "mem_1",
        result: { via: "native", native_outcome: "injected", error: null } } });
    const reprompted = h.item("steer:st_re", "user_message").steer!;
    expect(reprompted).toMatchObject({ injected: true, result: { via: "reprompt", native_outcome: "failed" } });
    // A diagnostic, label-sized.
    expect(reprompted.result!.error!.length).toBeLessThan(600);
    expect(h.item("steer:wrap_up:1", "user_message").steer).toMatchObject({ kind: "force_answer", injected: false,
      result: { via: "none", native_outcome: null, error: null } });
    expect(finalItem(h.state.items)?.id).toBe("msg:m2");

    // Each steer is one item.completed, and the stored form validates after JSON.
    const steerEvents = h.events.filter((event) => event.type === "item.completed" && event.item.type === "user_message"
      && event.item.origin === "steer");
    expect(steerEvents).toHaveLength(3);
    for (const event of h.events) expect(isTraceEventBody(JSON.parse(JSON.stringify(event)))).toBe(true);
    const folded = applyTurnTraceEvents(EMPTY_TURN_TRACE, JSON.parse(JSON.stringify(h.events)) as TraceEvent[]);
    expect(folded.items.find((item) => item.id === "steer:st_re")).toEqual(h.item("steer:st_re"));
  });

  it("reads steers recorded before the result field, and rejects a malformed result", () => {
    const h = harness("claude").start();
    h.translator.steer([steerMessage("st_1")], { via: "reprompt", native_outcome: null, error: null });
    const item = h.item("steer:st_1", "user_message");
    const { result: _result, ...legacySteer } = item.steer!;
    expect(isTraceItem({ ...item, steer: legacySteer })).toBe(true);
    expect(isTraceItem(item)).toBe(true);
    expect(isTraceItem({ ...item, steer: { ...item.steer, result: { via: "later", native_outcome: null, error: null } } })).toBe(false);
    expect(isTraceItem({ ...item, steer: { ...item.steer, result: { via: "native", native_outcome: "queued", error: null } } })).toBe(false);
    expect(isTraceItem({ ...item, steer: { ...item.steer, result: { via: "native", native_outcome: "injected" } } })).toBe(false);
  });
});

/** Keep the public surface typed for callers that hold the interface. */
export type { TraceTranslator };
