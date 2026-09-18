import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("follow lane Runtime lifecycle", () => {
  it.each(["delete Runtime", "retire daemon"] as const)("rebuilds inherited context after %s resets every affected scope", (operation) => {
    const store = createStore();
    const runtime = store.registerRuntime({
      name: "Departing host",
      provider: "claude",
      ...(operation === "retire daemon" ? { daemonId: "follow-retiring-daemon" } : {}),
    });
    const survivor = store.registerRuntime({ name: "Surviving host", provider: "claude" });
    const agent = store.createAgent({ name: "Following reader", provider: "claude" });
    const issue = store.createIssue({ title: "Follow history survives host loss" });
    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    for (const body of ["Original parent decision", "Already delivered decision"]) {
      store.appendSessionEvent(parent.id, { authorType: "agent", authorId: agent.id, body });
    }
    const side = store.createIssueSession(issue.id, { parentSessionId: parent.id, inherit_mode: "follow" });

    // Both scopes have provider history on the departing host. A third scope
    // has the same parent progress on another host and must remain untouched.
    for (const scope of ["", "delegation:departing", "delegation:surviving"]) {
      store.getOrCreateSessionAgentLane(side.id, agent.id, scope);
      db!.run(
        `UPDATE multiremi_session_agent_lanes
         SET provider_session_id = ?, runtime_id = ?, provider = 'claude',
             execution_fingerprint = 'prior-fingerprint', work_dir = '/prior-work',
             cursor_seq = 1, parent_cursor_seq = 2
         WHERE session_id = ? AND agent_id = ? AND execution_scope = ?`,
        [
          `provider-${scope || "main"}`,
          scope === "delegation:surviving" ? survivor.id : runtime.id,
          side.id, agent.id, scope,
        ],
      );
    }
    const unaffected = store.getSessionAgentLane(side.id, agent.id, "delegation:surviving");
    const before = store.getSessionAgentLane(side.id, agent.id)!;
    store.appendSessionEvent(parent.id, { authorType: "member", body: "New parent decision" });

    if (operation === "delete Runtime") {
      expect(store.deleteRuntime(runtime.id)).toBeTrue();
    } else {
      const plan = store.getDaemonRetirementPlan("local", "follow-retiring-daemon");
      expect(plan.canRetire).toBeTrue();
      expect(store.retireDaemon("local", "follow-retiring-daemon", plan.snapshot, "local")).toMatchObject({
        status: "retired", impact: { sessionLanesReset: 2 },
      });
    }

    expect(store.getRuntime(runtime.id)).toBeNull();
    for (const scope of ["", "delegation:departing"]) {
      expect(store.getSessionAgentLane(side.id, agent.id, scope)).toMatchObject({
        providerSessionId: null,
        runtimeId: null,
        provider: null,
        executionFingerprint: null,
        workDir: null,
        cursorSeq: 0,
        parentCursorSeq: 0,
        generation: before.generation + 1,
      });
    }
    expect(store.getSessionAgentLane(side.id, agent.id, "delegation:surviving")).toEqual(unaffected);

    const task = store.createSessionTask(side.id, { agentId: agent.id, prompt: "Recover the parent context" });
    expect(store.claimTask(survivor.id)?.id).toBe(task.id);
    const projection = store.buildTaskSessionProjection(task.id)!;
    expect(projection.mode).toBe("bootstrap");
    expect(projection.inheritedSessionProjection).toMatchObject({ mode: "bootstrap", fromSeq: 0, toSeq: 3 });
    expect(projection.inheritedSessionProjection!.jsonl).toContain("Original parent decision");
    expect(projection.inheritedSessionProjection!.jsonl).toContain("Already delivered decision");
    expect(projection.inheritedSessionProjection!.jsonl).toContain("New parent decision");
    expect(projection.inheritedSessionProjection!.jsonl).not.toContain("assistant_history");
    expect(store.getIssueSession(side.id)?.inheritCutoffSeq).toBe(2);
  });
});
