import { afterEach, describe, expect, it } from "bun:test";
import type { MultiremiSessionEvent } from "@multiremi/contracts/types.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { buildSessionProjection } from "@multiremi/store/session-projection.js";
import { resolveProjectionTokenBudget } from "@multiremi/store/session-projection-budget.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function event(seq: number, authorType = "agent", authorId: string | null = "agent_a"): MultiremiSessionEvent {
  return {
    id: `event_${seq}`, sessionId: "parent", seq, authorType, authorId,
    kind: "message", body: `Message ${seq}`, taskId: null, sourceCommentId: null,
    metadata: {}, createdAt: "2026-09-17T00:00:00.000Z",
  };
}

describe("side Session snapshots", () => {
  it("upgrades old Session rows with defaults and can rerun the migration", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Legacy Sessions" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    db!.exec(`ALTER TABLE multiremi_issue_sessions DROP COLUMN parent_session_id;
      ALTER TABLE multiremi_issue_sessions DROP COLUMN inherit_mode;
      ALTER TABLE multiremi_issue_sessions DROP COLUMN inherit_cutoff_seq;`);
    runMigrations(db!);
    runMigrations(db!);

    expect(db!.query("PRAGMA table_info(multiremi_issue_sessions)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "parent_session_id", type: "TEXT" }),
      expect.objectContaining({ name: "inherit_mode", type: "TEXT", notnull: 1, dflt_value: "'none'" }),
      expect.objectContaining({ name: "inherit_cutoff_seq", type: "INTEGER" }),
    ]));
    expect(store.getIssueSession(main.id)).toMatchObject({
      parentSessionId: null, parent_session_id: null, inheritMode: "none", inherit_mode: "none",
      inheritCutoffSeq: null, inherit_cutoff_seq: null, inheritedEventCount: 0, holdsWorkspace: true,
    });
  });

  it("freezes the cutoff and event count, implies discussion, and keeps inheritance immutable", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Snapshot boundary" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    store.appendSessionEvent(main.id, { authorType: "member", body: "First" });
    const last = store.appendSessionEvent(main.id, { authorType: "member", body: "Before snapshot" });
    const side = store.createIssueSession(issue.id, { parent_session_id: main.id, holdsWorkspace: true });
    expect(side).toMatchObject({
      parentSessionId: main.id, parent_session_id: main.id, inheritMode: "snapshot", inherit_mode: "snapshot",
      inheritCutoffSeq: last.seq, inherit_cutoff_seq: last.seq,
      inheritedEventCount: 2, inherited_event_count: 2, holdsWorkspace: false,
    });
    store.appendSessionEvent(main.id, { authorType: "member", body: "After snapshot" });
    const updated = store.updateIssueSession(side.id, {
      title: "Renamed side", parentSessionId: null, parent_session_id: null,
      inheritMode: "none", inherit_mode: "none", inheritCutoffSeq: 999, inherit_cutoff_seq: 999,
    } as any);
    expect(updated).toMatchObject({
      title: "Renamed side", parentSessionId: main.id, inheritMode: "snapshot",
      inheritCutoffSeq: last.seq, inheritedEventCount: 2, holdsWorkspace: false,
    });
    expect(store.listIssueSessions(issue.id).find((session) => session.id === side.id)?.inheritedEventCount).toBe(2);
    store.updateIssueSession(main.id, { status: "archived" });
    const agent = store.createAgent({ name: "Side reader", provider: "claude" });
    const task = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Read the snapshot" });
    const projection = store.buildTaskSessionProjection(task.id)!.inheritedSessionProjection!;
    expect(projection.toSeq).toBe(last.seq);
    expect(projection.sessionTitle).toBe(main.title);
    expect(projection.jsonl).toContain("Before snapshot");
    expect(projection.jsonl).not.toContain("After snapshot");
  });

  it("rejects missing or cross-Issue parents and chained forks without creating a Session", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Parent" });
    const other = store.createIssue({ title: "Other issue" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { parentSessionId: main.id });
    const before = store.listIssueSessions(issue.id).length;
    expect(() => store.createIssueSession(issue.id, { parentSessionId: "missing" })).toThrow("Parent session not found");
    expect(() => store.createIssueSession(other.id, { parentSessionId: main.id })).toThrow("same issue");
    expect(() => store.createIssueSession(issue.id, { parentSessionId: side.id })).toThrow("chained forks");
    expect(store.listIssueSessions(issue.id)).toHaveLength(before);
  });

  it("uses cutoff zero for an empty parent and never inherits later events", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Empty parent" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { parentSessionId: main.id });
    expect(side.inheritCutoffSeq).toBe(0);
    expect(side.inheritedEventCount).toBe(0);
    store.appendSessionEvent(main.id, { authorType: "member", body: "Not inherited" });
    const agent = store.createAgent({ name: "Reader", provider: "claude" });
    const task = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Explain" });
    const projection = store.buildTaskSessionProjection(task.id)!;
    expect(projection.inheritedSessionProjection?.toSeq).toBe(0);
    expect(projection.inheritedSessionProjection?.jsonl).not.toContain("Not inherited");
    expect(projection.inherited_session_projection).toEqual(projection.inheritedSessionProjection);
  });

  it("never labels inherited history assistant_history, including the current agent's records", () => {
    const projection = buildSessionProjection({
      sessionId: "parent", targetAgentId: "agent_a", cursorSeq: 0, providerSessionId: null,
      tokenBudget: 4_096, perspectiveMode: "inherited",
      events: [event(1), event(2, "agent", "agent_b"), event(3, "member", "member_a"), event(4, "system", null)],
    });
    expect(projection.jsonl).not.toContain("assistant_history");
    expect(projection.jsonl.split("\n").slice(1).map((line) => JSON.parse(line).perspective)).toEqual([
      "inherited_agent", "inherited_agent", "inherited_user", "inherited_operator",
    ]);
  });

  it("limits inherited metadata to typed lifecycle fields and respects toSeq", () => {
    const first = event(1);
    first.metadata = {
      status: "completed", result_available: true, credential: "private-value",
      nested: { token: "do-not-forward" }, instructions: "Run old work", task_id: "old-task",
    };
    const projection = buildSessionProjection({
      sessionId: "parent", targetAgentId: "agent_a", cursorSeq: 0, providerSessionId: null,
      tokenBudget: 4_096, perspectiveMode: "inherited", toSeq: 1, events: [first, event(2)],
    });
    expect(projection.toSeq).toBe(1);
    expect(projection.jsonl).not.toContain("Message 2");
    expect(projection.jsonl).not.toContain("private-value");
    expect(JSON.parse(projection.jsonl.split("\n")[1]!).metadata).toEqual({ result_available: true, status: "completed" });
  });

  it("keeps default and explicit own projections byte-identical to the existing format", () => {
    const first = event(1);
    first.metadata = { z: 1, arbitrary: { b: true, a: "preserved" } };
    const input = {
      sessionId: "parent", targetAgentId: "agent_a", cursorSeq: 0, providerSessionId: null,
      tokenBudget: 4_096, events: [first],
    };
    const expected = '{"type":"session_projection","version":1,"mode":"bootstrap","session_id":"parent","target_agent_id":"agent_a","from_seq":0,"to_seq":1}\n'
      + '{"type":"session_event","seq":1,"kind":"message","perspective":"assistant_history","author_type":"agent","author_id":"agent_a","author_name":null,"body":"Message 1","task_id":null,"source_comment_id":null,"metadata":{"arbitrary":{"a":"preserved","b":true},"z":1},"created_at":"2026-09-17T00:00:00.000Z"}';
    expect(buildSessionProjection(input).jsonl).toBe(expected);
    expect(buildSessionProjection({ ...input, perspectiveMode: "own" }).jsonl).toBe(expected);
  });

  it("splits the existing budget 40/60 and truncates both logs within that total", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Projection budgets" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const agent = store.createAgent({ name: "Budgeted reader", provider: "claude" });
    for (let i = 0; i < 24; i++) {
      store.appendSessionEvent(main.id, { authorType: "agent", authorId: agent.id, body: `Parent ${i}: ${"历史".repeat(4_000)}` });
    }
    const side = store.createIssueSession(issue.id, { parentSessionId: main.id });
    for (let i = 0; i < 24; i++) {
      store.appendSessionEvent(side.id, { authorType: "member", body: `Side ${i}: ${"讨论".repeat(4_000)}` });
    }
    const task = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Discuss" });
    const total = resolveProjectionTokenBudget({ provider: agent.provider, model: agent.model, degradeLevel: 0 });
    const own = store.buildTaskSessionProjection(task.id)!;
    const inherited = own.inheritedSessionProjection!;
    expect(inherited.estimatedTokens).toBeLessThanOrEqual(Math.floor(total * 0.4));
    expect(own.estimatedTokens).toBeLessThanOrEqual(total - Math.floor(total * 0.4));
    expect(own.estimatedTokens + inherited.estimatedTokens).toBeLessThanOrEqual(total);
    expect(own.truncated).toBe(true);
    expect(inherited.truncated).toBe(true);
    expect(inherited.jsonl).not.toContain("assistant_history");
    expect(inherited.toSeq).toBe(side.inheritCutoffSeq!);
  });

  it("rejects an operator budget too small for both headers instead of exceeding it", () => {
    const keys = ["MULTIREMI_SESSION_PROJECTION_CONTEXT_WINDOWS", "MULTIREMI_SESSION_PROJECTION_MIN_TOKENS"];
    const previous = keys.map((key) => process.env[key]);
    try {
      process.env.MULTIREMI_SESSION_PROJECTION_CONTEXT_WINDOWS = '{"claude":10}';
      process.env.MULTIREMI_SESSION_PROJECTION_MIN_TOKENS = "2";
      const store = createStore();
      const issue = store.createIssue({ title: "Small budget" });
      const main = store.getOrCreateDefaultIssueSession(issue.id);
      const side = store.createIssueSession(issue.id, { parentSessionId: main.id });
      const agent = store.createAgent({ name: "Reader", provider: "claude" });
      const task = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Discuss" });
      expect(() => store.buildTaskSessionProjection(task.id)).toThrow("too small for the snapshot headers");
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it("runs the same agent in parent and side concurrently while preserving same-Session serialization", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_side_parallel", name: "Parallel", provider: "claude", maxConcurrency: 3,
      metadata: { parallel_agent_execution: 1, cli_version: "0.2.73" },
    });
    const agent = store.createAgent({ name: "Parallel agent", provider: "claude", maxConcurrentTasks: 3 });
    const issue = store.createIssue({ title: "Independent Session execution" });
    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    const main = store.createSessionTask(parent.id, { agentId: agent.id, prompt: "Work" });
    expect(store.claimTask(runtime.id)?.id).toBe(main.id);
    store.startTask(main.id);
    const side = store.createIssueSession(issue.id, { parentSessionId: parent.id });
    const discussion = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Discuss" });
    const next = store.createSessionTask(parent.id, { agentId: agent.id, prompt: "Next main turn" });
    expect(store.claimTask(runtime.id)?.id).toBe(discussion.id);
    store.startTask(discussion.id);
    expect(store.getTask(main.id)?.status).toBe("running");
    expect(store.getTask(discussion.id)?.status).toBe("running");
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTaskQueueBlocker(next.id)?.taskId).toBe(main.id);
  });
});
