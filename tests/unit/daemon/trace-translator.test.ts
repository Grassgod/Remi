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
} from "@multiremi/contracts/trace.js";
import { EMPTY_TURN_TRACE, applyTurnTraceEvents, finalItem, turnTraceStats, type TurnTraceState } from "@shared/turn-trace.js";
import { TRACE_ITEM_OUTPUT_MAX_BYTES, TRACE_ITEM_TEXT_MAX_BYTES, TRACE_TRUNCATION_MARKER, utf8ByteLength } from "@shared/trace-sanitize.js";
import {
  createTraceTranslator,
  TRACE_DELTA_BUFFER_BYTES,
  TRACE_DELTA_MAX_BYTES,
  type TraceTranslator,
} from "@multiremi/worker/trace-translator.js";

const T0 = Date.parse("2026-10-15T08:00:00.000Z");
const FIXTURES = new URL("../../fixtures/acp/", import.meta.url);

function frames(name: string): ProviderEvent[] {
  const rows = JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Array<{ params?: { update?: Record<string, unknown> } }>;
  return rows.flatMap((row) => row.params?.update ? [row.params.update as unknown as ProviderEvent] : []);
}

/** A translator wired to a store stand-in: dense seq, a fixed clock, and the shared fold. */
function harness(agentType: "claude" | "codex", options: { flushIntervalMs?: number } = {}) {
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
      authorId: "mem_1", createdAt: new Date(T0).toISOString(), consumedAt: null }], true);
    h.feed([chunk("Answer two.", { messageId: "m3" })]);
    h.translator.promptEnded();
    expect(h.translator.settle()).toEqual({ itemId: "msg:m3", text: "Answer two." });
    expect(h.item("msg:m2", "agent_message").phase).toBe("unknown");
    expect(h.item("msg:m3", "agent_message").phase).toBe("final");
    expect(h.item("steer:st_1", "user_message")).toMatchObject({ origin: "steer",
      steer: { steer_id: "st_1", kind: "steer", injected: true, author_type: "user", author_id: "mem_1" } });
    expect(finalItem(h.state.items)?.id).toBe("msg:m3");
  });

  it("rule 2 leaves no final when the turn ended on a tool", () => {
    const h = harness("claude").start().feed([
      chunk("Running it.", { messageId: "m1" }),
      { sessionUpdate: "tool_call", toolCallId: "t1", name: "Bash", status: "pending", title: "ls", kind: "execute",
        _meta: { claudeCode: { toolName: "Bash" } } },
    ]);
    h.translator.promptEnded();
    expect(h.translator.settle()).toEqual({ itemId: null, text: null });
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
});

describe("trace translator: every recorded fixture", () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".json")).sort();

  it("finds the recorded fixtures", () => {
    expect(names.length).toBeGreaterThanOrEqual(25);
  });

  for (const name of names) {
    it(`emits only valid events for ${name}`, () => {
      const agentType = name.startsWith("codex") ? "codex" : "claude";
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

/** Keep the public surface typed for callers that hold the interface. */
export type { TraceTranslator };
