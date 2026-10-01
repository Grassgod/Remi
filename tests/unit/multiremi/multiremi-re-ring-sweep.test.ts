import { expect, it } from "bun:test";
import type { Envelope } from "@multiremi/contracts/inbox.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { RE_RING_SWEEP_CANDIDATES_SQL, RE_RING_SWEEP_PAGE_SQL } from "@multiremi/store/re-ring-sweep.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-492 periodic re-ring", (fixture, backend) => {
  function setup(role: "agent" | "issue_owner" | "parent_owner" | "delegator" = "agent") {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Sweep owner", provider: "codex" });
    const issue = f.store.createIssue({ title: "Sweep inbox", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const source: Envelope["source"] = {};
    let to: Envelope["to"] = { role: "agent", agentId: agent.id, issueSessionId: session.id };
    if (role === "issue_owner") to = { role, issueId: issue.id };
    if (role === "parent_owner") {
      const child = f.store.createIssue({ title: "Child", parentIssueId: issue.id });
      to = { role, childIssueId: child.id };
    }
    if (role === "delegator") {
      const worker = f.store.createAgent({ name: "Worker", provider: "codex" });
      const task = f.store.createTask({ agentId: worker.id, issueId: issue.id, issueSessionId: session.id,
        delegationId: "dlg_sweep_source", delegatedByAgentId: agent.id, prompt: "Delegated work" });
      source.taskId = task.id;
      to = { role, delegationId: "dlg_sweep_source" };
    }
    const delivery = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to, source, kind: "report", wake: "now",
      body: "Committed report with lost wake" }, [], createCommitEventQueue()))[0]!;
    // Crash state: preserve the committed entry without executing terminal hooks.
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
    return { ...f, agent, issue, session, delivery, now: Date.now() + 61_000 };
  }
  const queued = (f: ReturnType<typeof setup>) => f.store.listTasksForIssue(f.issue.id)
    .filter(t => t.agentId === f.agent.id && t.status === "queued");
  const watermark = (f: ReturnType<typeof setup>) => Number(f.db.query(`SELECT swept_to_seq FROM multiremi_session_agent_lanes
    WHERE session_id = ? AND agent_id = ?`).get(f.session.id, f.agent.id)!.swept_to_seq);

  for (const role of ["agent", "issue_owner", "parent_owner", "delegator"] as const) {
    it(`08: recovers ${role} exactly once and records its periodic origin`, () => {
      const f = setup(role);
      const scannedHead = f.store.getConversationLogHead(f.session.id)!.headSeq;
      expect(f.store.getSessionAgentLane(f.session.id, f.agent.id)).not.toBeNull();
      expect(f.store.sweepIdleIssueLanes(f.now).rang).toBe(1);
      expect(queued(f)).toHaveLength(1);
      expect(queued(f)[0]).toMatchObject({ wakeSource: "re_ring", chatSessionId: null, triggerCommentId: null });
      expect(f.store.listIssueActivity(f.issue.id).filter(a => a.type === "re_ring").map(a => a.data))
        .toEqual([expect.objectContaining({ origin: "periodic_sweep", action: "created", seq: f.delivery.entry.seq })]);
      expect(watermark(f)).toBe(scannedHead);
      f.store.sweepIdleIssueLanes(f.now + 60_000);
      expect(queued(f)).toHaveLength(1);
      expect(f.store.listIssueActivity(f.issue.id).filter(a => a.type === "re_ring")).toHaveLength(1);
    });
  }

  for (const status of ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"] as const) {
    it(`10: leaves ${status} lanes and their watermarks untouched`, () => {
      const f = setup();
      f.db.run("UPDATE multiremi_tasks SET status = ? WHERE id = ?", [status, f.delivery.task!.id]);
      expect(f.store.sweepIdleIssueLanes(f.now).rang).toBe(0);
      expect(watermark(f)).toBe(0);
      expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    });
  }
  for (const skip of ["cursor", "archived_agent", "archived_session", "relay", "young", "disabled", "next_turn", "inbox_only"] as const) {
    it(`10: excludes ${skip}`, () => {
      const f = setup();
      if (skip === "cursor") f.db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq = ? WHERE session_id = ?", [f.delivery.entry.seq, f.session.id]);
      if (skip === "archived_agent") f.db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), f.agent.id]);
      if (skip === "archived_session") f.db.run("UPDATE multiremi_issue_sessions SET status = 'archived' WHERE id = ?", [f.session.id]);
      if (skip === "relay") f.db.run("UPDATE multiremi_session_agent_lanes SET execution_scope = 'relay:chat' WHERE session_id = ?", [f.session.id]);
      if (skip === "next_turn" || skip === "inbox_only") {
        f.db.run("UPDATE multiremi_conversation_log SET metadata = ? WHERE id = ?", [JSON.stringify({ envelope: {
          ...f.delivery.entry.metadata.envelope, wake: skip } }), f.delivery.entry.id]);
      }
      const previous = process.env.MULTIREMI_RE_RING_SWEEP;
      if (skip === "disabled") process.env.MULTIREMI_RE_RING_SWEEP = "off";
      try { expect(f.store.sweepIdleIssueLanes(skip === "young" ? Date.now() : f.now).rang).toBe(0); }
      finally {
        if (previous === undefined) delete process.env.MULTIREMI_RE_RING_SWEEP;
        else process.env.MULTIREMI_RE_RING_SWEEP = previous;
      }
      expect(queued(f)).toHaveLength(0);
      if (["young", "disabled", "archived_agent", "archived_session", "relay"].includes(skip)) expect(watermark(f)).toBe(0);
    });
  }

  it("11: rotates lanes fairly and consumes large tails in bounded windows", () => {
    const lanes = [setup(), setup(), setup()];
    const now = Date.now() + 61_000;
    expect(fixture().store.sweepIdleIssueLanes(now, { lanes: 2 }).rang).toBe(2);
    expect(fixture().store.sweepIdleIssueLanes(now + 60_000, { lanes: 2 }).rang).toBe(1);
    expect(lanes.map(f => queued(f).length)).toEqual([1, 1, 1]);
    const f = lanes[0]!;
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE issue_id = ?", [f.issue.id]);
    f.db.run("UPDATE multiremi_session_agent_lanes SET swept_to_seq = 0 WHERE session_id = ?", [f.session.id]);
    for (let i = 0; i < 5; i++) f.store.createIssueComment(f.issue.id, { authorType: "system", body: `Tail ${i}` });
    const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
    f.store.sweepIdleIssueLanes(Date.now() + 61_000, { entries: 2 });
    const first = watermark(f);
    expect(first).toBeLessThan(head);
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE issue_id = ?", [f.issue.id]);
    f.store.sweepIdleIssueLanes(Date.now() + 121_000, { entries: 2 });
    expect(watermark(f)).toBeGreaterThan(first);
  });

  it("12: rolls back a failed lane, audits the failure, and continues the others", () => {
    const broken = setup();
    const healthy = setup();
    const run = fixture().db.run.bind(fixture().db);
    fixture().db.run = (sql, params) => {
      if (/INSERT\s+INTO\s+multiremi_tasks/i.test(sql) && Array.isArray(params) && params.includes(broken.agent.id)) throw new Error("injected sweep fault");
      return run(sql, params);
    };
    try { expect(fixture().store.sweepIdleIssueLanes(Date.now() + 61_000)).toMatchObject({ rang: 1, errors: 1 }); }
    finally { fixture().db.run = run; }
    expect(watermark(broken)).toBe(0);
    expect(queued(healthy)).toHaveLength(1);
    expect(broken.store.listIssueActivity(broken.issue.id).filter(a => a.type === "pending_turn_skipped")[0]!.data)
      .toMatchObject({ reason: "sweep_error", origin: "periodic_sweep" });
  });

  it("09: resets a resume-unsafe lane once, suppresses a poison loop, and wakes on a new entry", () => {
    const f = setup();
    const runtime = f.store.registerRuntime({ name: "Sweep runtime", provider: "codex" });
    f.db.run("UPDATE multiremi_tasks SET status = 'queued', max_attempts = 1 WHERE id = ?", [f.delivery.task!.id]);
    expect(f.store.claimTask(runtime.id)?.id).toBe(f.delivery.task!.id);
    f.store.startTask(f.delivery.task!.id);
    f.store.failTask(f.delivery.task!.id, { error: "overflow", failureReason: "agent_error.context_overflow" });
    expect(f.store.getSessionAgentLane(f.session.id, f.agent.id)!.cursorSeq).toBe(0);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000).rang).toBe(1);
    const retry = queued(f)[0]!;
    f.db.run("UPDATE multiremi_tasks SET max_attempts = 1 WHERE id = ?", [retry.id]);
    expect(f.store.claimTask(runtime.id)?.id).toBe(retry.id);
    f.store.startTask(retry.id);
    f.store.failTask(retry.id, { error: "overflow", failureReason: "agent_error.context_overflow" });
    expect(f.store.sweepIdleIssueLanes(Date.now() + 121_000).rang).toBe(0);
    const next = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to: { role: "agent", agentId: f.agent.id,
      issueSessionId: f.session.id }, kind: "report", wake: "now", body: "New work", source: {} }, [], createCommitEventQueue()))[0]!;
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [next.task!.id]);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 181_000).rang).toBe(1);
  });

  if (backend === "PostgreSQL") it("candidate plan uses the active-task index and never scans the log", () => {
    setup();
    const f = fixture();
    // Represent a long-lived deployment: many terminal rows and few active
    // rows. ANALYZE leaves the optimizer free to choose the selective index.
    f.db.exec(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, issue_session_id,
      status, prompt, created_at, updated_at)
      SELECT 'plan_' || n, t.workspace_id, t.agent_id, t.issue_id, t.issue_session_id,
        'cancelled', '', t.created_at, t.updated_at
      FROM generate_series(1, 5000) n CROSS JOIN (SELECT * FROM multiremi_tasks LIMIT 1) t;
      ANALYZE multiremi_tasks; ANALYZE multiremi_session_agent_lanes;`);
    const plan = JSON.stringify(fixture().db.query(`EXPLAIN ${RE_RING_SWEEP_CANDIDATES_SQL}
      ORDER BY COALESCE(l.swept_at, '') LIMIT 50`).all());
    expect(plan).toContain("idx_multiremi_tasks_lane_active");
    expect(plan).toContain("multiremi_conversation_heads");
    expect(plan).not.toContain("multiremi_conversation_log");
    const pagePlan = JSON.stringify(f.db.query(`EXPLAIN ${RE_RING_SWEEP_PAGE_SQL}`).all(50));
    expect(pagePlan).not.toContain("multiremi_conversation_log");
  });
});
