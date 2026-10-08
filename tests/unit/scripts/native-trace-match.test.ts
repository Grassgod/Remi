import { describe, expect, test } from "bun:test";
import { matchClaudeTask, matchCodexTask, parseNativeRecords, taskOutput, type RecoveryTask, type ClaudeNativeChildSource } from "../../../scripts/lib/native-trace-match.js";

const task = (id = "tsk_one"): RecoveryTask => ({ id, provider: "codex", workspaceId: "w", runtimeId: "r", agentId: "a", nativeSessionId: "session", workDir: "/work", prompt: "verify the historical source", output: "first replyfinal reply", status: "completed", startedAt: "2026-10-04T01:00:00Z", completedAt: "2026-10-04T01:10:00Z" });
const r = (type: string, payload: unknown, timestamp: string) => ({ type, payload, timestamp });
const codex = () => [
  r("session_meta", { id: "session", cwd: "/work" }, "2026-10-01T00:00:00Z"),
  r("event_msg", { type: "task_started", turn_id: "turn" }, "2026-10-04T01:00:01Z"),
  r("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "prefix verify the historical source suffix" }] }, "2026-10-04T01:00:02Z"),
  r("response_item", { type: "message", role: "assistant", content: [{ text: "first reply" }] }, "2026-10-04T01:05:00Z"),
  r("response_item", { type: "message", role: "assistant", content: [{ text: "final reply" }] }, "2026-10-04T01:09:00Z"),
  r("event_msg", { type: "task_complete", turn_id: "turn", last_agent_message: "final reply" }, "2026-10-04T01:09:01Z"),
];
const records = (rows: unknown[]) => parseNativeRecords(rows.map(value => JSON.stringify(value)).join("\n"));
describe("native task identity and exact anchors", () => {
  test("uses session, workdir, prompt, output and native turn identity together", () => {
    const match = matchCodexTask(records(codex()), task(), [task()]);
    expect(match.proof.turnIds).toEqual(["turn"]);
    expect(match.proof.outputMatch).toBe("all-assistant-text");
    expect(match.records.length).toBe(5);
  });
  test("rejects a neighboring task even when time windows overlap", () => {
    expect(() => matchCodexTask(records(codex()), { ...task(), prompt: "another request" }, [task()])).toThrow("prompt_anchor_mismatch");
    expect(() => matchCodexTask(records(codex()), task(), [task(), task("tsk_duplicate")])).toThrow("native_turn_matches_multiple_tasks");
  });
  test("rejects tampered output, wrong session, wrong workdir and missing completion", () => {
    expect(() => matchCodexTask(records(codex()), { ...task(), output: "wrong" }, [])).toThrow("output_anchor_mismatch");
    expect(() => matchCodexTask(records(codex()), { ...task(), nativeSessionId: "other" }, [])).toThrow("native_session_mismatch");
    expect(() => matchCodexTask(records(codex()), { ...task(), workDir: "/other" }, [])).toThrow("native_workdir_mismatch");
    expect(() => matchCodexTask(records(codex().slice(0, -1)), task(), [])).toThrow("no_complete_native_turn");
  });
  test("accepts final-only server output explicitly without rewriting it", () => {
    expect(matchCodexTask(records(codex()), { ...task(), output: "final reply" }, []).proof.outputMatch).toBe("final-answer");
  });
  test("includes multiple verified turns in one task after steer", () => {
    const rows = codex();
    rows[5] = r("event_msg", { type: "task_complete", turn_id: "turn", last_agent_message: "final reply" }, "2026-10-04T01:09:01Z");
    rows.push(r("event_msg", { type: "task_started", turn_id: "steer" }, "2026-10-04T01:09:02Z"),
      r("response_item", { type: "message", role: "assistant", content: [{ text: "steered reply" }] }, "2026-10-04T01:09:03Z"),
      r("event_msg", { type: "task_complete", turn_id: "steer", last_agent_message: "steered reply" }, "2026-10-04T01:09:04Z"));
    expect(matchCodexTask(records(rows), { ...task(), output: "first replyfinal replysteered reply" }, []).proof.turnIds).toEqual(["turn", "steer"]);
  });
  test("rejects invalid JSONL instead of skipping corrupt lines", () => {
    expect(() => parseNativeRecords('{"type":"message"}\n{bad')).toThrow("invalid_jsonl_line:2");
    expect(taskOutput('{"output":"answer"}')).toBe("answer");
  });
  test("uses a trusted dispatch boundary when the start acknowledgement arrived late", () => {
    const delayed = { ...task(), startedAt: "2026-10-04T01:00:15Z", notBeforeAt: "2026-10-04T01:00:00Z" };
    expect(matchCodexTask(records(codex()), delayed, []).proof.notBeforeAt).toBe(delayed.notBeforeAt);
    expect(() => matchCodexTask(records(codex()), { ...delayed, notBeforeAt: "2026-10-04T01:00:02Z" }, []))
      .toThrow("no_complete_native_turn");
    expect(() => matchCodexTask(records(codex()), { ...delayed, notBeforeAt: "not-a-date" }, []))
      .toThrow("invalid_native_dispatch_boundary");
    expect(() => matchCodexTask(records(codex()), { ...delayed, notBeforeAt: "2026-10-04T01:00:16Z" }, []))
      .toThrow("invalid_native_dispatch_boundary");
    expect(() => matchCodexTask(records(codex()), { ...delayed, output: "final reply" }, []))
      .toThrow("output_anchor_mismatch");
  });
});

function abortedChain() {
  const rows = codex().slice(0, 4);
  rows.push(r("event_msg", { type: "turn_aborted", turn_id: "turn", reason: "interrupted" }, "2026-10-04T01:05:01Z"),
    r("event_msg", { type: "task_started", turn_id: "resume" }, "2026-10-04T01:05:02Z"),
    r("turn_context", { turn_id: "resume", cwd: "/work" }, "2026-10-04T01:05:02Z"),
    r("event_msg", { type: "item_completed", thread_id: "session", turn_id: "turn", item: { id: "late", type: "CommandExecution" } }, "2026-10-04T01:05:03Z"),
    r("response_item", { type: "message", role: "assistant", content: [{ text: "final reply" }] }, "2026-10-04T01:09:00Z"),
    r("event_msg", { type: "task_complete", turn_id: "resume", last_agent_message: "final reply" }, "2026-10-04T01:09:01Z"));
  return rows;
}

describe("Codex interrupted turns within a verified Remi task", () => {
  test("retains the aborted turn prompt, prose and delayed tool completion by explicit turn ID", () => {
    const rows = abortedChain();
    const match = matchCodexTask(records(rows), task(), []);
    expect(match.proof.turnIds).toEqual(["turn", "resume"]);
    expect(match.proof.outputMatch).toBe("all-assistant-text");
    expect(match.records.map(r => r.value.payload?.item?.id).filter(Boolean)).toEqual(["late"]);
    expect(match.records.length).toBe(rows.length - 1);
  });
  test("rejects foreign delayed items and cross-session items even when output matches", () => {
    const rows = abortedChain();
    rows[7] = r("event_msg", { type: "item_completed", thread_id: "session", turn_id: "outside", item: {} }, "2026-10-04T01:05:03Z");
    expect(() => matchCodexTask(records(rows), task(), [])).toThrow("interleaved_native_turns");
    rows[7] = r("event_msg", { type: "item_completed", thread_id: "different-session", turn_id: "turn", item: {} }, "2026-10-04T01:05:03Z");
    expect(() => matchCodexTask(records(rows), task(), [])).toThrow("native_session_mismatch");
  });
  test("requires an explicit abort and final completion instead of inferring a missing boundary", () => {
    const rows = abortedChain();
    expect(() => matchCodexTask(records(rows.filter((_, i) => i !== 4)), task(), [])).toThrow("native_turn_missing_terminal");
    expect(() => matchCodexTask(records(rows.slice(0, 5)), task(), [])).toThrow("no_complete_native_turn");
    rows[4] = r("event_msg", { type: "turn_aborted", turn_id: "other" }, "2026-10-04T01:05:01Z");
    expect(() => matchCodexTask(records(rows), task(), [])).toThrow("native_turn_missing_terminal");
  });
  test("never accepts a final-only match after discarding text from an aborted turn", () => {
    expect(() => matchCodexTask(records(abortedChain()), { ...task(), output: "final reply" }, [])).toThrow("output_anchor_mismatch");
    expect(() => matchCodexTask(records(abortedChain()), task(), [task("tsk_same-chain")])).toThrow("native_turn_matches_multiple_tasks");
  });
  test("requires every resumed turn to keep the expected native work directory", () => {
    const rows = abortedChain();
    rows[6] = r("turn_context", { turn_id: "resume", cwd: "/another-workspace" }, "2026-10-04T01:05:02Z");
    expect(() => matchCodexTask(records(rows), task(), [])).toThrow("native_workdir_mismatch");
  });
  test("unrelated old interleaving does not taint a later independently matched turn", () => {
    const older = abortedChain().slice(1).map(row => ({ ...row, timestamp: row.timestamp.replace("2026-10-04", "2026-10-03") }));
    const later = codex().map(row => ({ ...row, payload: { ...(row.payload as object), ...((row.payload as any)?.turn_id ? { turn_id: "later" } : {}) } }));
    expect(matchCodexTask(records([later[0], ...older, ...later.slice(1)]), task(), []).proof.turnIds).toEqual(["later"]);
  });
});

const cc = (uuid: string, parentUuid: string | null, type: string, content: unknown, timestamp = "2026-10-04T01:05:00Z") => ({ uuid, parentUuid, type, sessionId: "session", cwd: "/work", timestamp, message: { role: type, content } });
describe("Claude native graph", () => {
  test("includes parallel tool branches sharing an anchored ancestor", () => {
    const rows = [cc("prompt", null, "user", [{ type: "text", text: task().prompt }], "2026-10-04T01:00:02Z"),
      cc("calls", "prompt", "assistant", [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }]),
      cc("a", "calls", "user", [{ type: "tool_result", tool_use_id: "a" }]),
      cc("b", "calls", "user", [{ type: "tool_result", tool_use_id: "b" }]),
      cc("done", "b", "assistant", [{ type: "text", text: task().output }], "2026-10-04T01:09:00Z")];
    const match = matchClaudeTask(records(rows), { ...task(), provider: "claude" }, []);
    expect(match.records.map(r => r.value.uuid)).toEqual(["prompt", "calls", "a", "b", "done"]);
    expect(match.proof.outputMatch).toBe("all-assistant-text");
    rows[2]!.cwd = "/work/child-directory";
    expect(matchClaudeTask(records(rows), { ...task(), provider: "claude" }, []).records.length).toBe(5);
  });
  test("rejects a detached assistant branch and duplicate prompt", () => {
    const rows = [cc("prompt", null, "user", [{ type: "text", text: task().prompt }]), cc("done", "other", "assistant", [{ type: "text", text: task().output }])];
    expect(() => matchClaudeTask(records(rows), { ...task(), provider: "claude" }, [])).toThrow("unanchored_assistant_branch");
    rows.push(cc("prompt2", null, "user", [{ type: "text", text: task().prompt }]));
    expect(() => matchClaudeTask(records(rows), { ...task(), provider: "claude" }, [])).toThrow("ambiguous_prompt_anchor");
  });
  test("bridges native compaction through its validated explicit logical parent", () => {
    const rows = compactedClaude();
    const match = matchClaudeTask(records(rows), { ...task(), provider: "claude" }, []);
    expect(match.records.map(r => r.value.uuid)).toEqual(["prompt", "before", "boundary", "summary", "after"]);
    expect(match.proof.compactionLinks).toEqual([{ recordUuid: "boundary", parentUuid: "before" }]);
    expect(match.proof.outputMatch).toBe("all-assistant-text");
    expect(() => matchClaudeTask(records(rows), { ...task(), provider: "claude", output: "final reply" }, []))
      .toThrow("output_anchor_mismatch");
  });
  test("does not trust forged, missing or cross-session compaction ancestry", () => {
    const cases = [
      { subtype: "other_boundary" },
      { compactMetadata: { preservedSegment: { tailUuid: "someone-else" } } },
      { logicalParentUuid: "missing", compactMetadata: { preservedSegment: { tailUuid: "missing" } } },
      { sessionId: "other-session" },
    ];
    for (const fields of cases) {
      const rows = compactedClaude();
      rows[2] = { ...rows[2], ...fields };
      expect(() => matchClaudeTask(records(rows), { ...task(), provider: "claude" }, [])).toThrow();
    }
    const rows = compactedClaude();
    rows[1] = { ...rows[1], sessionId: "other-session" };
    expect(() => matchClaudeTask(records(rows), { ...task(), provider: "claude" }, [])).toThrow("invalid_native_compaction_link");
  });
  test("rejects a cycle reached through logical compaction ancestry", () => {
    const rows = compactedClaude();
    rows[1] = { ...rows[1], parentUuid: "boundary" };
    expect(() => matchClaudeTask(records(rows), { ...task(), provider: "claude" }, [])).toThrow("native_parent_cycle");
  });
  test("honors dispatch before delayed start acknowledgement without including earlier prompts", () => {
    const rows = [cc("prompt", null, "user", [{ type: "text", text: task().prompt }], "2026-10-04T01:00:01Z"),
      cc("done", "prompt", "assistant", [{ type: "text", text: task().output }], "2026-10-04T01:09:00Z")];
    const delayed = { ...task(), provider: "claude" as const, startedAt: "2026-10-04T01:00:15Z", notBeforeAt: "2026-10-04T01:00:00Z" };
    expect(matchClaudeTask(records(rows), delayed, []).proof.nativeStartedAt).toBe("2026-10-04T01:00:01Z");
    expect(() => matchClaudeTask(records(rows), { ...delayed, notBeforeAt: "2026-10-04T01:00:02Z" }, [])).toThrow("prompt_anchor_mismatch");
    expect(() => matchClaudeTask(records(rows), delayed, [{ ...delayed, id: "tsk_duplicate" }])).toThrow("native_turn_matches_multiple_tasks");
  });
  test("includes the exact live informational notice in the complete output anchor", () => {
    const rows = [cc("prompt", null, "user", [{ type: "text", text: task().prompt }], "2026-10-04T01:00:02Z"),
      cc("reply", "prompt", "assistant", [{ type: "text", text: "done" }], "2026-10-04T01:09:00Z"),
      { uuid: "notice", parentUuid: "reply", type: "system", subtype: "informational", sessionId: "session", timestamp: "2026-10-04T01:09:01Z", level: "notice", content: "notice" }];
    expect(matchClaudeTask(records(rows), { ...task(), provider: "claude", output: "done**Notice:** notice" }, []).proof.outputMatch).toBe("all-assistant-text");
    expect(() => matchClaudeTask(records(rows), { ...task(), provider: "claude", output: "doneNotice: notice" }, [])).toThrow("output_anchor_mismatch");
  });
});

function compactedClaude(): any[] {
  return [
    cc("prompt", null, "user", [{ type: "text", text: task().prompt }], "2026-10-04T01:00:02Z"),
    cc("before", "prompt", "assistant", [{ type: "text", text: "first reply" }], "2026-10-04T01:01:00Z"),
    { uuid: "boundary", parentUuid: null, logicalParentUuid: "before", type: "system", subtype: "compact_boundary", sessionId: "session", timestamp: "2026-10-04T01:02:00Z", compactMetadata: { preservedSegment: { tailUuid: "before" } } },
    { ...cc("summary", "boundary", "user", [{ type: "text", text: "compacted context" }], "2026-10-04T01:02:01Z"), isCompactSummary: true },
    cc("after", "summary", "assistant", [{ type: "text", text: "final reply" }], "2026-10-04T01:09:00Z"),
  ];
}

function linkedClaudeChild(): { parent: ReturnType<typeof records>; source: ClaudeNativeChildSource; task: RecoveryTask } {
  const childPrompt = "review these exact bytes";
  const parent = records([
    cc("prompt", null, "user", [{ type: "text", text: task().prompt }], "2026-10-04T01:00:02Z"),
    cc("agent-call", "prompt", "assistant", [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { prompt: childPrompt } }], "2026-10-04T01:01:00Z"),
    { ...cc("agent-result", "agent-call", "user", [{ type: "tool_result", tool_use_id: "agent-tool", content: "started" }], "2026-10-04T01:01:01Z"), toolUseResult: { agentId: "child-agent" }, sourceToolAssistantUUID: "agent-call" },
    cc("parent-done", "agent-result", "assistant", [{ type: "text", text: "parent reply" }], "2026-10-04T01:09:00Z"),
  ]);
  const child = records([
    { ...cc("child-prompt", null, "user", [{ type: "text", text: childPrompt }], "2026-10-04T01:02:00Z"), agentId: "child-agent", isSidechain: true },
    { ...cc("child-done", "child-prompt", "assistant", [{ type: "text", text: "child reply" }], "2026-10-04T01:08:00Z"), agentId: "child-agent", isSidechain: true },
  ]);
  return { parent, source: { sourceId: "source/child.jsonl", sourceSha256: "a".repeat(64), agentId: "child-agent", parentToolUseId: "agent-tool", records: child }, task: { ...task(), provider: "claude", output: "child replyparent reply" } };
}

describe("Claude native child-source correspondence", () => {
  test("proves tool-result agent identity and exact child prompt before merging timestamped events", () => {
    const f = linkedClaudeChild();
    const match = matchClaudeTask(f.parent, f.task, [], [f.source]);
    expect(match.proof.outputMatch).toBe("all-assistant-text");
    expect(match.proof.additionalSources).toMatchObject([{ sourceSha256: "a".repeat(64), agentId: "child-agent", parentToolUseId: "agent-tool", firstLine: 1, lastLine: 2 }]);
    expect(match.records.filter(r => r.value.type === "assistant").map(r => r.value.uuid)).toEqual(["agent-call", "child-done", "parent-done"]);
    expect(match.records.find(r => r.value.uuid === "child-done")!.value).toMatchObject({ parent_tool_use_id: "agent-tool", _remiNativeTraceSource: { sha256: "a".repeat(64), line: 2, agentId: "child-agent" } });
    expect(f.source.records[1]!.value).not.toHaveProperty("parent_tool_use_id");
  });
  test("does not recover a child from matching output alone or accept a different prompt/identity", () => {
    for (const change of ["prompt", "session", "agent", "parent", "cwd", "source"] as const) {
      const f = linkedClaudeChild();
      if (change === "prompt") f.source.records[0]!.value.message.content[0].text = "different request";
      if (change === "session") f.source.records[1]!.value.sessionId = "another-session";
      if (change === "agent") f.source.records[1]!.value.agentId = "another-agent";
      if (change === "parent") f.source.parentToolUseId = "another-call";
      if (change === "cwd") f.source.records[0]!.value.cwd = "/other";
      if (change === "source") f.source.sourceSha256 = "not-a-sha";
      expect(() => matchClaudeTask(f.parent, f.task, [], [f.source])).toThrow();
    }
  });
  test("rejects child substitution, attribution conflicts and final-only output", () => {
    const f = linkedClaudeChild();
    f.parent[2]!.value.toolUseResult.agentId = "different-agent";
    expect(() => matchClaudeTask(f.parent, f.task, [], [f.source])).toThrow("native_child_agent_link_mismatch");
    const g = linkedClaudeChild();
    g.source.records[1]!.value.parent_tool_use_id = "different-call";
    expect(() => matchClaudeTask(g.parent, g.task, [], [g.source])).toThrow("native_child_parent_attribution_mismatch");
    const h = linkedClaudeChild();
    expect(() => matchClaudeTask(h.parent, { ...h.task, output: "parent reply" }, [], [h.source])).toThrow("output_anchor_mismatch");
    expect(() => matchClaudeTask(h.parent, h.task, [], [h.source, h.source])).toThrow("invalid_native_child_source");
  });
  test("rejects orphan child branches and child work predating its parent call", () => {
    const f = linkedClaudeChild();
    f.source.records[1]!.value.parentUuid = "detached";
    expect(() => matchClaudeTask(f.parent, f.task, [], [f.source])).toThrow("unanchored_child_assistant_branch");
    const g = linkedClaudeChild();
    g.source.records[0]!.value.timestamp = "2026-10-04T01:00:00Z";
    expect(() => matchClaudeTask(g.parent, g.task, [], [g.source])).toThrow("native_child_interval_mismatch");
  });
});
