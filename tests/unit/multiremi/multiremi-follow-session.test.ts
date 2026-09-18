import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@multiremi/store/migrations.js";
import { resolveProjectionTokenBudget } from "@multiremi/store/session-projection-budget.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

const environment = new Map<string, string | undefined>();

function setEnvironment(key: string, value: string): void {
  if (!environment.has(key)) environment.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  environment.clear();
  resetMultiremiTestEnv();
});

function fixture(parentEvents = 2) {
  const store = createStore();
  const runtime = store.registerRuntime({ name: "Follow runtime", provider: "claude" });
  const agent = store.createAgent({ name: "Follow reader", provider: "claude" });
  const issue = store.createIssue({ title: "Follow parent context" });
  const parent = store.getOrCreateDefaultIssueSession(issue.id);
  for (let index = 0; index < parentEvents; index++) {
    store.appendSessionEvent(parent.id, {
      authorType: "agent", authorId: agent.id, body: `Parent decision ${index}`,
    });
  }
  const side = store.createIssueSession(issue.id, {
    title: "Follow discussion", parent_session_id: parent.id, inherit_mode: "follow", holds_workspace: true,
  });
  return { store, runtime, agent, issue, parent, side };
}

function startTurn(f: ReturnType<typeof fixture>, prompt = "Explain parent decisions", agentId = f.agent.id) {
  const task = f.store.createSessionTask(f.side.id, { agentId, prompt });
  expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
  const projection = f.store.buildTaskSessionProjection(task.id)!;
  f.store.startTask(task.id);
  return { task, projection, inherited: projection.inheritedSessionProjection };
}

function finishTurn(f: ReturnType<typeof fixture>, taskId: string, providerSessionId = "follow_provider") {
  return f.store.completeTask(taskId, { output: "Read the parent context", sessionId: providerSessionId });
}

describe("follow Session context", () => {
  it("migrates follow checkpoints and costs with defaults and preserves recorded values on rerun", () => {
    const f = fixture();
    const task = f.store.createSessionTask(f.side.id, { agentId: f.agent.id, prompt: "Existing task before migration" });
    db!.exec("ALTER TABLE multiremi_session_agent_lanes DROP COLUMN parent_cursor_seq");
    db!.exec("ALTER TABLE multiremi_issue_sessions DROP COLUMN inherited_tokens_total");
    db!.exec("ALTER TABLE multiremi_issue_sessions DROP COLUMN follow_frozen_seq");
    db!.exec("ALTER TABLE multiremi_tasks DROP COLUMN inherited_projection_from_seq");
    runMigrations(db!);
    expect(db!.query("PRAGMA table_info(multiremi_session_agent_lanes)").all()).toContainEqual(
      expect.objectContaining({ name: "parent_cursor_seq", type: "INTEGER", notnull: 1, dflt_value: "0" }),
    );
    expect(db!.query("PRAGMA table_info(multiremi_issue_sessions)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "inherited_tokens_total", type: "INTEGER", notnull: 1, dflt_value: "0" }),
      expect.objectContaining({ name: "follow_frozen_seq", type: "INTEGER", notnull: 0, dflt_value: null }),
    ]));
    expect(db!.query("PRAGMA table_info(multiremi_tasks)").all()).toContainEqual(
      expect.objectContaining({ name: "inherited_projection_from_seq", type: "INTEGER", notnull: 0, dflt_value: null }),
    );
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)).toMatchObject({ parentCursorSeq: 0, parent_cursor_seq: 0 });
    expect(f.store.getSessionInheritedContext(f.side.id)).toMatchObject({ inherited_tokens_total: 0, follow_frozen_seq: null, follow_frozen: false });
    expect(db!.query("SELECT inherited_projection_from_seq FROM multiremi_tasks WHERE id = ?").get(task.id)).toEqual({ inherited_projection_from_seq: null });

    db!.run("UPDATE multiremi_issue_sessions SET inherited_tokens_total = 23, follow_frozen_seq = 1 WHERE id = ?", [f.side.id]);
    db!.run("UPDATE multiremi_tasks SET inherited_projection_from_seq = 1 WHERE id = ?", [task.id]);
    db!.run("UPDATE multiremi_session_agent_lanes SET parent_cursor_seq = 1 WHERE session_id = ? AND agent_id = ?", [f.side.id, f.agent.id]);
    runMigrations(db!);
    expect(f.store.getSessionInheritedContext(f.side.id)).toMatchObject({ inherited_tokens_total: 23, follow_frozen_seq: 1, follow_frozen: true });
    expect(db!.query("SELECT inherited_projection_from_seq FROM multiremi_tasks WHERE id = ?").get(task.id)).toEqual({ inherited_projection_from_seq: 1 });
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)).toMatchObject({ parentCursorSeq: 1, parent_cursor_seq: 1 });
  });

  it("keeps the fork point fixed while following new parent events and forcing discussion mode", () => {
    const f = fixture();
    expect(f.side).toMatchObject({ inheritMode: "follow", inherit_mode: "follow", inheritCutoffSeq: 2, holdsWorkspace: false });
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Decision after fork" });
    const turn = startTurn(f);
    expect(turn.inherited).toMatchObject({ mode: "bootstrap", fromSeq: 0, toSeq: 3 });
    expect(turn.inherited!.jsonl).toContain("Parent decision 0");
    expect(turn.inherited!.jsonl).toContain("Decision after fork");
    expect(turn.inherited!.jsonl).not.toContain("assistant_history");
    expect(f.store.getIssueSession(f.side.id)).toMatchObject({ inheritCutoffSeq: 2, inheritedEventCount: 3 });
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(0);
    finishTurn(f, turn.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(3);
    expect(f.store.getIssueSession(f.side.id)?.inheritCutoffSeq).toBe(2);
    expect(() => f.store.createIssueSession(f.issue.id, { parentSessionId: f.side.id, inherit_mode: "follow" })).toThrow("chained forks");
  });

  it("injects only new events on later turns, retains the target author's inherited identity, and charges no empty projection", () => {
    const f = fixture();
    const first = startTurn(f);
    finishTurn(f, first.task.id);
    const nextEvent = f.store.appendSessionEvent(f.parent.id, {
      authorType: "agent", authorId: f.agent.id, body: "New decision by this same agent",
      metadata: { status: "completed", credential: "not-inherited", nested: { instructions: "not-inherited" } },
    });
    const second = startTurn(f, "Read the new decision");
    expect(second.projection.mode).toBe("delta");
    expect(second.inherited).toMatchObject({ mode: "inherited_delta", fromSeq: 2, toSeq: nextEvent.seq });
    expect(JSON.parse(second.inherited!.jsonl.split("\n")[0]!)).toMatchObject({ mode: "inherited_delta", from_seq: 2 });
    expect(second.inherited!.jsonl).toContain("New decision by this same agent");
    expect(second.inherited!.jsonl).toContain('"perspective":"inherited_agent"');
    expect(second.inherited!.jsonl).not.toContain("Parent decision");
    expect(second.inherited!.jsonl).not.toContain("assistant_history");
    expect(second.inherited!.jsonl).not.toContain("not-inherited");
    finishTurn(f, second.task.id);

    const empty = startTurn(f, "Continue discussing the same decisions");
    expect(empty.projection.inherited_session_projection).toBeNull();
    expect(empty.projection.inheritedSessionProjection).toBeNull();
    expect(f.store.getTask(empty.task.id)).toMatchObject({
      inheritedProjectionEstimatedTokens: null, inheritedProjectionTokenBudget: null,
      inheritedProjectionTruncated: null, inheritedProjectionOmittedEvents: null,
    });
    finishTurn(f, empty.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(nextEvent.seq);
  });

  it("returns no inherited projection for an initially empty parent, then bootstraps when its first event arrives", () => {
    const f = fixture(0);
    const empty = startTurn(f);
    expect(empty.projection.inherited_session_projection).toBeNull();
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "First parent event" });
    expect(f.store.buildTaskSessionProjection(empty.task.id)!.inherited_session_projection).toBeNull();
    finishTurn(f, empty.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(0);
    const first = startTurn(f);
    expect(first.inherited).toMatchObject({ mode: "bootstrap", fromSeq: 0, toSeq: 1 });
    expect(first.inherited!.jsonl).toContain("First parent event");
  });

  it("tracks each agent's progress independently and reports the live parent max beside lane cursors", () => {
    const f = fixture();
    const secondAgent = f.store.createAgent({ name: "Second follower", provider: "claude" });
    f.store.addSessionParticipant(f.side.id, { participantType: "agent", participantId: secondAgent.id });
    const first = startTurn(f);
    finishTurn(f, first.task.id);
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Third parent event" });
    expect(f.store.getSessionInheritedContext(f.side.id)).toMatchObject({
      inherit_mode: "follow", inherit_cutoff_seq: 2, parent_max_seq: 3, follow_frozen: false, follow_frozen_seq: null,
      lanes: expect.arrayContaining([
        expect.objectContaining({ agent_id: f.agent.id, execution_scope: "", parent_cursor_seq: 2 }),
        expect.objectContaining({ agent_id: secondAgent.id, execution_scope: "", parent_cursor_seq: 0 }),
      ]),
    });
    const second = startTurn(f, "Catch up independently", secondAgent.id);
    expect(second.inherited).toMatchObject({ mode: "bootstrap", fromSeq: 0, toSeq: 3 });
    expect(second.inherited!.jsonl).toContain("Parent decision 0");
    finishTurn(f, second.task.id, "second_follow_provider");
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(2);
    expect(f.store.getSessionAgentLane(f.side.id, secondAgent.id)?.parentCursorSeq).toBe(3);
    expect(startTurn(f).inherited).toMatchObject({ mode: "inherited_delta", fromSeq: 2, toSeq: 3 });
  });

  it("bounds bootstrap and delta costs even after truncation, then advances across every omitted parent event", () => {
    const f = fixture(0);
    const appendLargeBatch = () => {
      for (let index = 0; index < 24; index++) {
        f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: `Long parent decision ${index}: ${"历史".repeat(4_000)}` });
      }
    };
    const total = resolveProjectionTokenBudget({ provider: f.agent.provider, model: f.agent.model, degradeLevel: 0 });
    appendLargeBatch();
    const bootstrap = startTurn(f);
    expect(bootstrap.inherited!.truncated).toBe(true);
    expect(bootstrap.inherited!.omittedEvents).toBeGreaterThan(0);
    expect(bootstrap.inherited!.jsonl).toContain('"type":"session_elision"');
    expect(bootstrap.inherited!.estimatedTokens).toBeLessThanOrEqual(Math.floor(total * 0.4));
    expect(f.store.getTask(bootstrap.task.id)?.inheritedProjectionTokenBudget).toBe(Math.floor(total * 0.4));
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(0);
    finishTurn(f, bootstrap.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(24);

    appendLargeBatch();
    const delta = startTurn(f);
    expect(delta.inherited).toMatchObject({ truncated: true, fromSeq: 24, toSeq: 48, mode: "inherited_delta" });
    expect(delta.inherited!.estimatedTokens).toBeLessThanOrEqual(Math.floor(total * 0.15));
    expect(f.store.getTask(delta.task.id)?.inheritedProjectionTokenBudget).toBe(Math.floor(total * 0.15));
    expect(delta.projection.estimatedTokens + delta.inherited!.estimatedTokens).toBeLessThanOrEqual(total);
    finishTurn(f, delta.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(48);
    expect(startTurn(f).projection.inherited_session_projection).toBeNull();
  });

  it("uses the configurable ratio only for incremental follow rounds", () => {
    setEnvironment("MULTIREMI_SESSION_PROJECTION_FOLLOW_DELTA_RATIO", "0.08");
    const f = fixture();
    const total = resolveProjectionTokenBudget({ provider: f.agent.provider, model: f.agent.model, degradeLevel: 0 });
    const first = startTurn(f);
    expect(f.store.getTask(first.task.id)?.inheritedProjectionTokenBudget).toBe(Math.floor(total * 0.4));
    finishTurn(f, first.task.id);
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Incremental context" });
    const second = startTurn(f);
    expect(f.store.getTask(second.task.id)?.inheritedProjectionTokenBudget).toBe(Math.floor(total * 0.08));
  });

  it("freezes the inherited task window and budget across rebuilds while the parent keeps writing", () => {
    const f = fixture();
    const first = startTurn(f);
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Arrived after the first projection" });
    const rebuilt = f.store.buildTaskSessionProjection(first.task.id)!.inheritedSessionProjection!;
    expect(rebuilt.jsonl).toBe(first.inherited!.jsonl);
    expect(rebuilt.toSeq).toBe(2);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(0);
    finishTurn(f, first.task.id);

    const second = startTurn(f);
    const budget = f.store.getTask(second.task.id)!.inheritedProjectionTokenBudget;
    setEnvironment("MULTIREMI_SESSION_PROJECTION_FOLLOW_DELTA_RATIO", "0.05");
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Another late arrival" });
    expect(f.store.buildTaskSessionProjection(second.task.id)!.inheritedSessionProjection!.jsonl).toBe(second.inherited!.jsonl);
    expect(f.store.getTask(second.task.id)?.inheritedProjectionTokenBudget).toBe(budget);
    finishTurn(f, second.task.id);
    const next = startTurn(f);
    expect(next.inherited).toMatchObject({ fromSeq: 3, toSeq: 4 });
    expect(next.inherited!.jsonl).toContain("Another late arrival");
  });

  it("does not promote a failed resume-safe attempt's parent cursor and retries from the same parent boundary", () => {
    const f = fixture();
    const first = startTurn(f);
    finishTurn(f, first.task.id);
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Must survive failed attempt" });
    const failed = startTurn(f);
    expect(failed.inherited).toMatchObject({ fromSeq: 2, toSeq: 3 });
    f.store.failTask(failed.task.id, { error: "Runtime disconnected", failureReason: "runtime_offline", sessionId: "follow_provider" });
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(2);
    const retry = f.store.listTasksForIssue(f.issue.id).find((task) => task.parentTaskId === failed.task.id)!;
    expect(retry).toBeDefined();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(retry.id);
    const retryProjection = f.store.buildTaskSessionProjection(retry.id)!.inheritedSessionProjection!;
    expect(retryProjection).toMatchObject({ fromSeq: 2, toSeq: 3 });
    expect(retryProjection.jsonl).toBe(failed.inherited!.jsonl);
    f.store.startTask(retry.id);
    finishTurn(f, retry.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(3);
  });

  it("rejects late parent-cursor promotion after the lane generation resets", () => {
    const f = fixture();
    const turn = startTurn(f);
    const reset = f.store.resetSessionAgentLane(f.side.id, f.agent.id)!;
    finishTurn(f, turn.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)).toMatchObject({
      generation: reset.generation, providerSessionId: null, cursorSeq: 0, parentCursorSeq: 0,
    });
  });

  it("preserves a nonzero parent cursor when a successful task has a NULL inherited upper bound", () => {
    const f = fixture();
    const first = startTurn(f);
    finishTurn(f, first.task.id);
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Still pending without a committed inherited upper bound" });
    const missingBound = startTurn(f);
    expect(missingBound.inherited).toMatchObject({ fromSeq: 2, toSeq: 3 });
    db!.run("UPDATE multiremi_tasks SET inherited_projection_to_seq = NULL WHERE id = ?", [missingBound.task.id]);
    expect(f.store.getTask(missingBound.task.id)?.inheritedProjectionToSeq).toBeNull();
    expect(finishTurn(f, missingBound.task.id).status).toBe("completed");
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)).toMatchObject({
      parentCursorSeq: 2, lastTaskId: missingBound.task.id, cursorSeq: missingBound.projection.toSeq,
    });
    expect(startTurn(f).inherited).toMatchObject({ fromSeq: 2, toSeq: 3 });
  });

  it("rejects late parent-cursor promotion when the provider lineage has been replaced", () => {
    const f = fixture();
    const first = startTurn(f);
    finishTurn(f, first.task.id);
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "New context for old provider" });
    const late = startTurn(f);
    db!.run("UPDATE multiremi_session_agent_lanes SET provider_session_id = ? WHERE session_id = ? AND agent_id = ?", [
      "replacement_provider", f.side.id, f.agent.id,
    ]);
    finishTurn(f, late.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)).toMatchObject({
      providerSessionId: "replacement_provider", parentCursorSeq: 2,
    });
  });

  it("promotes only the task execution scope's parent cursor, leaving the same agent's sibling scope untouched", () => {
    const f = fixture();
    // A pre-existing scoped cache must remain isolated even though new side
    // session tasks cannot be created through the agent-delegation API.
    f.store.getOrCreateSessionAgentLane(f.side.id, f.agent.id, "sibling_delegation");
    const turn = startTurn(f);
    finishTurn(f, turn.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(2);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id, "sibling_delegation")?.parentCursorSeq).toBe(0);
  });

  it("charges a task's first inherited projection once, counts failed attempts, and shares the total across agents", () => {
    const f = fixture();
    expect(f.store.getSessionInheritedContext(f.side.id)).toMatchObject({
      inherited_tokens_total: 0, follow_token_limit: 200_000, follow_frozen: false,
    });
    const failed = startTurn(f);
    const firstTokens = failed.inherited!.estimatedTokens;
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(firstTokens);
    expect(f.store.buildTaskSessionProjection(failed.task.id)!.inheritedSessionProjection!.jsonl).toBe(failed.inherited!.jsonl);
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(firstTokens);
    f.store.failTask(failed.task.id, { error: "Lost runtime after prompt was sent", failureReason: "runtime_offline", sessionId: "follow_provider" });
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(firstTokens);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(0);

    const retry = f.store.listTasksForIssue(f.issue.id).find((task) => task.parentTaskId === failed.task.id)!;
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(retry.id);
    const retryProjection = f.store.buildTaskSessionProjection(retry.id)!.inheritedSessionProjection!;
    const bothAttemptsTokens = firstTokens + retryProjection.estimatedTokens;
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(bothAttemptsTokens);
    f.store.startTask(retry.id);
    finishTurn(f, retry.id);
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(bothAttemptsTokens);
    expect(() => finishTurn(f, retry.id)).toThrow("terminal");
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(bothAttemptsTokens);

    const secondAgent = f.store.createAgent({ name: "Additional follower", provider: "claude" });
    const independent = startTurn(f, "Read on another lane", secondAgent.id);
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(
      bothAttemptsTokens + independent.inherited!.estimatedTokens,
    );
  });

  it("freezes at the successful parent cursor once the cumulative limit is reached and keeps caught-up frozen turns free", () => {
    const f = fixture();
    const first = startTurn(f);
    finishTurn(f, first.task.id);
    const initialTokens = first.inherited!.estimatedTokens;
    setEnvironment("MULTIREMI_SESSION_PROJECTION_FOLLOW_TOKEN_LIMIT", String(initialTokens + 1));
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Crosses the follow cost cap" });
    const capped = startTurn(f);
    const cappedTokens = initialTokens + capped.inherited!.estimatedTokens;
    expect(f.store.getSessionInheritedContext(f.side.id)).toMatchObject({
      inherit_mode: "follow", inherit_cutoff_seq: 2, inherited_tokens_total: cappedTokens,
      follow_token_limit: initialTokens + 1, follow_frozen: true, follow_frozen_seq: 2, inherited_event_count: 2,
    });
    const notices = () => f.store.listSessionEvents(f.side.id).filter((event) => event.authorType === "system" && event.body.includes("成本上限"));
    expect(notices()).toHaveLength(1);
    expect(f.store.listSessionEvents(f.parent.id).some((event) => event.body.includes("成本上限"))).toBe(false);
    expect(f.store.buildTaskSessionProjection(capped.task.id)!.inheritedSessionProjection!.jsonl).toBe(capped.inherited!.jsonl);
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(cappedTokens);
    expect(notices()).toHaveLength(1);
    finishTurn(f, capped.task.id);
    const committedCursor = f.store.getSessionAgentLane(f.side.id, f.agent.id)!.parentCursorSeq;
    expect(committedCursor).toBe(3);
    expect(() => finishTurn(f, capped.task.id)).toThrow("terminal");
    expect(notices()).toHaveLength(1);

    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Never included after freezing" });
    const frozen = startTurn(f);
    expect(frozen.projection.inherited_session_projection).toBeNull();
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(cappedTokens);
    finishTurn(f, frozen.task.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(committedCursor);
    expect(notices()).toHaveLength(1);

    f.store.resetSessionAgentLane(f.side.id, f.agent.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(0);
    const cold = startTurn(f);
    expect(cold.inherited).toMatchObject({ mode: "bootstrap", fromSeq: 0, toSeq: 2 });
    expect(cold.inherited!.jsonl).toContain("Parent decision 0");
    expect(cold.inherited!.jsonl).not.toContain("Crosses the follow cost cap");
    expect(cold.inherited!.jsonl).not.toContain("Never included after freezing");
    finishTurn(f, cold.task.id, "cold_frozen_provider");
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)?.parentCursorSeq).toBe(2);
    expect(startTurn(f).projection.inherited_session_projection).toBeNull();
    expect(notices()).toHaveLength(1);
    expect(f.store.getSessionInheritedContext(f.side.id)).toMatchObject({
      inherit_mode: "follow", follow_frozen: true, follow_frozen_seq: 2, parent_max_seq: 4, inherited_event_count: 2,
    });
  });

  it("reboots inherited context after a provider reset without refunding the already spent tokens", () => {
    const f = fixture();
    const first = startTurn(f);
    finishTurn(f, first.task.id);
    const tokens = f.store.getSessionInheritedContext(f.side.id)!.inherited_tokens_total;
    if (tokens === undefined) throw new Error("Follow diagnostics must include inherited token usage");
    f.store.resetSessionAgentLane(f.side.id, f.agent.id);
    expect(f.store.getSessionAgentLane(f.side.id, f.agent.id)).toMatchObject({ parentCursorSeq: 0, providerSessionId: null });
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(tokens);
    const cold = startTurn(f);
    expect(cold.inherited).toMatchObject({ mode: "bootstrap", fromSeq: 0, toSeq: 2 });
    expect(cold.inherited!.jsonl).toContain("Parent decision 0");
    expect(f.store.getSessionInheritedContext(f.side.id)?.inherited_tokens_total).toBe(tokens + cold.inherited!.estimatedTokens);
  });

  it("continues to read an archived parent without changing follow or the fork boundary", () => {
    const f = fixture();
    f.store.appendSessionEvent(f.parent.id, { authorType: "member", body: "Last decision before parent archive" });
    f.store.updateIssueSession(f.parent.id, { status: "archived" });
    const archived = startTurn(f);
    expect(archived.inherited).toMatchObject({ fromSeq: 0, toSeq: 3 });
    expect(archived.inherited!.jsonl).toContain("Last decision before parent archive");
    finishTurn(f, archived.task.id);
    expect(f.store.getIssueSession(f.side.id)).toMatchObject({ inheritMode: "follow", inheritCutoffSeq: 2 });
    expect(startTurn(f).projection.inherited_session_projection).toBeNull();
  });
});
