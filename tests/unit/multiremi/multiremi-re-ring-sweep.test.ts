import { expect, it } from "bun:test";
import type { Envelope } from "@multiremi/contracts/inbox.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { RE_RING_SWEEP_CANDIDATES_SQL, RE_RING_SWEEP_PAGE_SQL } from "@multiremi/store/re-ring-sweep.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { runMigrations } from "@multiremi/store/migrations.js";

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
  const pending = (f: ReturnType<typeof setup>) => f.db.query(RE_RING_SWEEP_PAGE_SQL).all(50)
    .filter(l => l.session_id === f.session.id && l.agent_id === f.agent.id);

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
      expect(f.store.sweepIdleIssueLanes(f.now)).toMatchObject({ visited: 1, eligible: 0, rang: 0 });
      expect(watermark(f)).toBe(0);
      expect(pending(f)).toHaveLength(1);
      expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
      f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [f.delivery.task!.id]);
      expect(f.store.sweepIdleIssueLanes(f.now + 60_000).rang).toBe(1);
      expect(pending(f)).toHaveLength(0);
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
      if (["young", "disabled"].includes(skip)) expect(watermark(f)).toBe(0);
      if (["cursor", "archived_agent", "archived_session", "relay"].includes(skip)) {
        expect(watermark(f)).toBe(f.delivery.entry.seq);
        expect(pending(f)).toHaveLength(0);
        const sweptAt = f.db.query("SELECT swept_at FROM multiremi_session_agent_lanes WHERE session_id = ?").get(f.session.id)!.swept_at;
        f.store.sweepIdleIssueLanes(f.now + 60_000);
        expect(f.db.query("SELECT swept_at FROM multiremi_session_agent_lanes WHERE session_id = ?").get(f.session.id)!.swept_at).toBe(sweptAt);
      }
    });
  }

  it("11: ignores 200 history lanes and takes no locks or writes once hints are drained", () => {
    const f = setup();
    f.transaction(() => {
      for (let i = 0; i < 200; i++) f.db.run(`INSERT INTO multiremi_session_agent_lanes
        (session_id, agent_id, execution_scope, cursor_seq, generation, status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 1, 'active', ?, ?)`,
        [f.session.id, f.agent.id, `history_${i}`, new Date().toISOString(), new Date().toISOString()]);
    });
    // Even a busy session's head does not hint its other recipients/scopes.
    f.store.createIssueComment(f.issue.id, { authorType: "system", body: "Unaddressed history" });
    expect(f.db.query(RE_RING_SWEEP_PAGE_SQL).all(2)).toHaveLength(1);
    const original = f.db.run;
    let locks = 0;
    let laneWrites = 0;
    f.db.run = function(sql, params) {
      if (sql.includes("UPDATE multiremi_workspaces SET updated_at = updated_at")) locks++;
      if (sql.includes("UPDATE multiremi_session_agent_lanes")) laneWrites++;
      return original.call(this, sql, params);
    };
    try {
      expect(f.store.sweepIdleIssueLanes(f.now, { lanes: 2 }))
        .toMatchObject({ visited: 1, eligible: 1, pageFull: false, rang: 1 });
      expect(queued(f)).toHaveLength(1);
      expect(locks).toBeGreaterThan(0);
      expect(Number(f.db.query(`SELECT COUNT(*) AS n FROM multiremi_session_agent_lanes
        WHERE execution_scope LIKE 'history_%' AND (swept_at IS NOT NULL OR wake_hint_seq <> 0 OR swept_to_seq <> 0)`)
        .get()!.n)).toBe(0);
      locks = 0;
      laneWrites = 0;
      expect(f.store.sweepIdleIssueLanes(f.now + 60_000, { lanes: 2 }))
        .toMatchObject({ visited: 0, eligible: 0, pageFull: false });
      expect(locks).toBe(0);
      expect(laneWrites).toBe(0);
    } finally { f.db.run = original; }
  });

  it("11: only now delivery hints its recipient and deduplication never rewinds a hint", () => {
    const f = setup();
    f.store.sweepIdleIssueLanes(f.now);
    const send = (wake: Envelope["wake"], dedupeKey: string) => f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "agent", agentId: f.agent.id, issueSessionId: f.session.id }, kind: "report", wake,
      body: "New work", source: {}, dedupeKey,
    }, [], createCommitEventQueue()))[0]!;
    send("next_turn", "later");
    send("inbox_only", "quiet");
    expect(pending(f)).toHaveLength(0);
    const first = send("now", "first");
    const second = send("now", "second");
    send("now", "first");
    const hint = f.db.query("SELECT wake_hint_seq FROM multiremi_session_agent_lanes WHERE session_id = ?").get(f.session.id)!.wake_hint_seq;
    expect(hint).toBe(second.entry.seq);
    expect(second.entry.seq).toBeGreaterThan(first.entry.seq);
    expect(pending(f)).toHaveLength(1);
  });

  it("07: upgrades the previous sweep schema once and only backfills unexamined heads", () => {
    const unread = setup();
    const covered = setup();
    const swept = setup();
    const f = fixture();
    f.db.run("UPDATE multiremi_session_agent_lanes SET cursor_seq = ? WHERE session_id = ?",
      [f.store.getConversationLogHead(covered.session.id)!.headSeq, covered.session.id]);
    f.db.run("UPDATE multiremi_session_agent_lanes SET swept_to_seq = ? WHERE session_id = ?",
      [f.store.getConversationLogHead(swept.session.id)!.headSeq, swept.session.id]);
    f.db.exec(`DROP INDEX idx_multiremi_lanes_sweep_pending;
      ALTER TABLE multiremi_session_agent_lanes DROP COLUMN wake_hint_seq;
      CREATE INDEX idx_multiremi_lanes_sweep_order
        ON multiremi_session_agent_lanes(COALESCE(swept_at, ''), session_id, agent_id, execution_scope)
        WHERE status = 'active' AND substr(execution_scope, 1, 6) <> 'relay:';
      DELETE FROM multiremi_schema_migrations WHERE id = '20261001_lane_rering_wake_hint';`);
    runMigrations(f.db);
    const oldIndex = backend === "PostgreSQL"
      ? f.db.query("SELECT indexname FROM pg_indexes WHERE indexname = 'idx_multiremi_lanes_sweep_order'").all()
      : f.db.query("SELECT name FROM sqlite_master WHERE name = 'idx_multiremi_lanes_sweep_order'").all();
    expect(oldIndex).toHaveLength(0);
    expect(pending(unread)).toHaveLength(1);
    expect(pending(covered)).toHaveLength(0);
    expect(pending(swept)).toHaveLength(0);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000).rang).toBe(1);
    runMigrations(f.db);
    expect(pending(unread)).toHaveLength(0);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 121_000).rang).toBe(0);
  });

  it("07: does not backfill permanently unavailable history into the pending index", () => {
    const archivedAgent = setup();
    const archivedSession = setup();
    const relay = setup();
    const inactive = setup();
    const foreignWorkspace = setup();
    const f = fixture();
    f.db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), archivedAgent.agent.id]);
    f.db.run("UPDATE multiremi_issue_sessions SET status = 'archived' WHERE id = ?", [archivedSession.session.id]);
    f.db.run("UPDATE multiremi_session_agent_lanes SET execution_scope = 'relay:history' WHERE session_id = ?", [relay.session.id]);
    f.db.run("UPDATE multiremi_session_agent_lanes SET status = 'archived' WHERE session_id = ?", [inactive.session.id]);
    const elsewhere = f.store.createWorkspace({ name: "Elsewhere" });
    f.db.run("UPDATE multiremi_agents SET workspace_id = ? WHERE id = ?", [elsewhere.id, foreignWorkspace.agent.id]);
    f.db.exec(`DROP INDEX idx_multiremi_lanes_sweep_pending;
      ALTER TABLE multiremi_session_agent_lanes DROP COLUMN wake_hint_seq;
      DELETE FROM multiremi_schema_migrations WHERE id = '20261001_lane_rering_wake_hint';`);
    runMigrations(f.db);
    expect(f.db.query("SELECT wake_hint_seq FROM multiremi_session_agent_lanes").all())
      .toEqual(Array.from({ length: 5 }, () => ({ wake_hint_seq: 0 })));
    expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000))
      .toMatchObject({ visited: 0, eligible: 0, pageFull: false, rang: 0 });
  });

  it("11: rotates lanes fairly and consumes large tails in bounded windows", () => {
    const lanes = [setup(), setup(), setup()];
    const now = Date.now() + 61_000;
    expect(fixture().store.sweepIdleIssueLanes(now, { lanes: 2 }))
      .toMatchObject({ visited: 2, eligible: 2, pageFull: true, rang: 2 });
    expect(fixture().store.sweepIdleIssueLanes(now + 60_000, { lanes: 2 }))
      .toMatchObject({ visited: 1, eligible: 1, pageFull: false, rang: 1 });
    expect(lanes.map(f => queued(f).length)).toEqual([1, 1, 1]);
    const f = lanes[0]!;
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE issue_id = ?", [f.issue.id]);
    f.db.run("UPDATE multiremi_session_agent_lanes SET swept_to_seq = 0 WHERE session_id = ?", [f.session.id]);
    for (let i = 0; i < 5; i++) f.store.createIssueComment(f.issue.id, { authorType: "system", body: `Tail ${i}` });
    // Keep a real unexamined now hint beyond the first bounded log page.
    const tail = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to: { role: "agent", agentId: f.agent.id,
      issueSessionId: f.session.id }, kind: "report", wake: "now", body: "Tail wake", source: {} }, [], createCommitEventQueue()))[0]!;
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [tail.task!.id]);
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
    if (backend === "PostgreSQL") {
      fixture().db.run("CREATE FUNCTION mul492_sweep_reject() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected sweep fault'; END; $$ LANGUAGE plpgsql");
      fixture().db.run(`CREATE TRIGGER mul492_sweep_reject BEFORE INSERT ON multiremi_tasks
        FOR EACH ROW WHEN (NEW.agent_id = '${broken.agent.id}') EXECUTE FUNCTION mul492_sweep_reject()`);
    } else fixture().db.exec(`CREATE TRIGGER mul492_sweep_reject BEFORE INSERT ON multiremi_tasks
      WHEN NEW.agent_id = '${broken.agent.id}' BEGIN SELECT RAISE(ABORT, 'injected sweep fault'); END`);
    try { expect(fixture().store.sweepIdleIssueLanes(Date.now() + 61_000)).toMatchObject({ rang: 1, errors: 1 }); }
    finally {
      if (backend === "PostgreSQL") fixture().db.exec("DROP TRIGGER mul492_sweep_reject ON multiremi_tasks; DROP FUNCTION mul492_sweep_reject()");
      else fixture().db.exec("DROP TRIGGER mul492_sweep_reject");
    }
    expect(watermark(broken)).toBe(0);
    expect(queued(healthy)).toHaveLength(1);
    expect(broken.store.listIssueActivity(broken.issue.id).filter(a => a.type === "pending_turn_skipped")[0]!.data)
      .toMatchObject({ reason: "sweep_error", origin: "periodic_sweep" });
    expect(fixture().store.sweepIdleIssueLanes(Date.now() + 121_000).rang).toBe(1);
    expect(queued(broken)).toHaveLength(1);
    expect(queued(healthy)).toHaveLength(1);
    expect(fixture().store.sweepIdleIssueLanes(Date.now() + 181_000).rang).toBe(0);
  });

  it("11: reads a 1200-entry tail in bounded windows without re-reading old entries", () => {
    const f = setup();
    const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
    f.transaction(() => {
      for (let i = 1; i <= 1200; i++) f.db.run(`INSERT INTO multiremi_conversation_log
        (session_id, seq, id, kind, visibility, body_md, created_at, updated_at)
        VALUES (?, ?, ?, 'system', 'shown', '', ?, ?)`,
        [f.session.id, head + i, `tail_${i}`, new Date().toISOString(), new Date().toISOString()]);
      f.db.run("UPDATE multiremi_conversation_heads SET head_seq = ? WHERE session_id = ?", [head + 1200, f.session.id]);
    });
    const tail = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to: { role: "agent", agentId: f.agent.id,
      issueSessionId: f.session.id }, kind: "report", wake: "now", body: "Tail wake", source: {} }, [], createCommitEventQueue()))[0]!;
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [tail.task!.id]);
    f.store.sweepIdleIssueLanes(Date.now() + 61_000);
    expect(watermark(f)).toBe(500);
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE issue_id = ?", [f.issue.id]);
    f.store.sweepIdleIssueLanes(Date.now() + 121_000);
    expect(watermark(f)).toBe(1000);
    const finalSnapshot = f.store.getConversationLogHead(f.session.id)!.headSeq;
    f.store.sweepIdleIssueLanes(Date.now() + 181_000);
    // Recovering the tail wake itself appends a turn row after the head snapshot.
    expect(watermark(f)).toBe(finalSnapshot);
    expect(queued(f)).toHaveLength(1);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 241_000).examined).toBe(0);
  });

  for (const status of ["done", "cancelled", "backlog"] as const) it(`10: preserves ${status} issue status when recovering`, () => {
    const f = setup();
    f.db.run("UPDATE multiremi_issues SET status = ? WHERE id = ?", [status, f.issue.id]);
    if (status === "backlog") {
      const prerequisite = f.store.createIssue({ title: "Unmet prerequisite" });
      f.store.createIssueDependency(f.issue.id, { dependsOnIssueId: prerequisite.id });
    }
    expect(f.store.sweepIdleIssueLanes(f.now).rang).toBe(1);
    expect(f.store.getIssue(f.issue.id)!.status).toBe(status);
  });

  it("08/10: preserves device affinity and keeps Chat tasks outside the Issue lane", () => {
    const f = setup();
    const dedicated = f.store.registerRuntime({ name: "Dedicated", provider: "codex" });
    const wrong = f.store.registerRuntime({ name: "Other", provider: "codex" });
    f.store.updateAgent(f.agent.id, { runtimeId: dedicated.id });
    const chat = f.store.createChatSession({ agentId: f.agent.id });
    const chatTask = f.store.sendChatMessage(chat.id, { content: "Independent chat" }).task;
    expect(f.store.sweepIdleIssueLanes(f.now).rang).toBe(1);
    const recovered = queued(f)[0]!;
    expect(recovered.chatSessionId).toBeNull();
    expect(f.store.claimTask(wrong.id)).toBeNull();
    expect(f.store.getTask(chatTask.id)!.status).toBe("queued");
    expect(f.store.getTask(recovered.id)!.runtimeId).toBe(dedicated.id);
  });

  for (const lastId of ["present", "missing"] as const) it(`08: inherits scoped delegator lineage with last_task_id ${lastId}`, () => {
    const f = setup();
    const grand = f.store.createAgent({ name: "Grand delegator", provider: "codex" });
    const worker = f.store.createAgent({ name: "Nested worker", provider: "codex" });
    const scope = "dlg_scoped_parent";
    const parent = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, issueSessionId: f.session.id,
      prompt: "Scoped parent", delegationId: scope, delegatedByAgentId: grand.id, delegatedFromIssueSessionId: f.session.id,
      priority: 42 });
    const child = f.store.createTask({ agentId: worker.id, issueId: f.issue.id, issueSessionId: f.session.id,
      prompt: "Nested work", parentTaskId: parent.id, delegationId: "dlg_nested", delegatedByAgentId: f.agent.id });
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE issue_id = ?", [f.issue.id]);
    const delivery = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to: { role: "delegator", delegationId: "dlg_nested" },
      kind: "report", wake: "now", body: "For the scoped parent", source: { taskId: child.id } }, [], createCommitEventQueue()))[0]!;
    f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
    // The normal return already carries the recipient as delegatedByAgentId;
    // the parent lane's own lineage must come from its previous scoped turn.
    f.db.run("UPDATE multiremi_session_agent_lanes SET last_task_id = ? WHERE session_id = ? AND agent_id = ? AND execution_scope = ?",
      [lastId === "present" ? parent.id : null, f.session.id, f.agent.id, scope]);
    if (lastId === "missing") f.db.run("UPDATE multiremi_tasks SET created_at = '2000-01-01' WHERE id = ?", [delivery.task!.id]);
    f.store.sweepIdleIssueLanes(Date.now() + 61_000);
    const scoped = f.store.listTasksForIssue(f.issue.id).filter(t => t.status === "queued" && t.execution_scope === scope);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({ delegationId: scope, delegatedByAgentId: grand.id,
      delegatedFromIssueSessionId: f.session.id, priority: 42, chatSessionId: null });
    expect(f.store.listTasksForIssue(f.issue.id).filter(t => t.status === "queued" && t.execution_scope === "")).toHaveLength(1);
  });

  it("08: keeps explicit Runtime workspace routing while side sessions retain no directory", () => {
    const f = fixture();
    const runtime = f.store.registerRuntime({ name: "Directory host", provider: "codex", daemonId: "mul492-directory", metadata: { runtime_workspaces: 1 } });
    const directory = f.store.runtimeWorkspaces.create(runtime.id, { name: "Work", root_path: "/tmp/mul492-fixture-directory" });
    const agent = f.store.createAgent({ name: "Directory owner", provider: "codex" });
    const issue = f.store.createIssue({ title: "Directory recovery", runtimeWorkspaceId: directory.id });
    const main = f.store.getOrCreateDefaultIssueSession(issue.id);
    const side = f.store.createIssueSession(issue.id, { title: "Discussion", parentSessionId: main.id });
    const deliveries = [main, side].map(session => f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "agent", agentId: agent.id, issueSessionId: session.id }, kind: "report", wake: "now", body: "Wake", source: {},
    }, [], createCommitEventQueue()))[0]!);
    for (const delivery of deliveries) f.db.run("UPDATE multiremi_tasks SET status = 'cancelled' WHERE id = ?", [delivery.task!.id]);
    expect(f.store.sweepIdleIssueLanes(Date.now() + 61_000).rang).toBe(2);
    const tasks = f.store.listTasksForIssue(issue.id).filter(t => t.status === "queued");
    expect(tasks.find(t => t.issueSessionId === main.id)).toMatchObject({ runtimeWorkspaceId: directory.id, holdsWorkspace: true, chatSessionId: null });
    expect(tasks.find(t => t.issueSessionId === side.id)).toMatchObject({ runtimeWorkspaceId: null, holdsWorkspace: false, chatSessionId: null });
  });

  it("07: upgrades old lanes additively and repeated migration preserves data and constraints", () => {
    const f = setup();
    f.db.exec(`DROP INDEX idx_multiremi_lanes_sweep_pending;
      ALTER TABLE multiremi_session_agent_lanes DROP COLUMN wake_hint_seq;
      ALTER TABLE multiremi_session_agent_lanes DROP COLUMN swept_to_seq;
      ALTER TABLE multiremi_session_agent_lanes DROP COLUMN swept_at;
      DELETE FROM multiremi_schema_migrations WHERE id IN ('20261001_lane_rering_sweep', '20261001_lane_rering_wake_hint');`);
    runMigrations(f.db);
    const row = f.db.query("SELECT swept_to_seq, swept_at, wake_hint_seq FROM multiremi_session_agent_lanes WHERE session_id = ?").get(f.session.id)!;
    expect(row).toMatchObject({ swept_to_seq: 0, swept_at: null, wake_hint_seq: f.store.getConversationLogHead(f.session.id)!.headSeq });
    runMigrations(f.db);
    expect(f.store.getConversationLogEntryById(f.delivery.entry.id)!.body_md).toBe(f.delivery.entry.body_md);
    const names = backend === "PostgreSQL"
      ? f.db.query("SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'").all().map(x => x.name)
      : f.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(x => x.name);
    expect(names).toContain("idx_multiremi_tasks_one_pending_turn_session");
    expect(names).toContain("idx_multiremi_tasks_lane_active");
    expect(names).toContain("idx_multiremi_lanes_sweep_pending");
    expect(names).not.toContain("idx_multiremi_lanes_sweep_order");
    expect(f.store.sweepIdleIssueLanes(f.now).rang).toBe(1);
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
    const target = setup();
    const f = fixture();
    const history = f.store.createIssueSession(target.issue.id, { title: "History", parentSessionId: target.session.id });
    // Represent a long-lived deployment: many terminal rows and few active
    // rows. ANALYZE leaves the optimizer free to choose the selective index.
    f.db.exec(`INSERT INTO multiremi_tasks (id, workspace_id, agent_id, issue_id, issue_session_id,
      status, prompt, created_at, updated_at)
      SELECT 'plan_' || n, t.workspace_id, t.agent_id, t.issue_id, t.issue_session_id,
        'cancelled', '', t.created_at, t.updated_at
      FROM generate_series(1, 5000) n CROSS JOIN (SELECT * FROM multiremi_tasks LIMIT 1) t;
      INSERT INTO multiremi_session_agent_lanes
        (session_id, agent_id, execution_scope, cursor_seq, generation, status, created_at, updated_at)
      SELECT l.session_id, l.agent_id, 'plan_' || n, 0, 1, 'active', l.created_at, l.updated_at
      FROM generate_series(1, 5000) n CROSS JOIN (SELECT * FROM multiremi_session_agent_lanes LIMIT 1) l;
      ANALYZE multiremi_tasks; ANALYZE multiremi_session_agent_lanes;`);
    f.db.run(`INSERT INTO multiremi_conversation_log
      (session_id, seq, id, kind, visibility, body_md, created_at, updated_at)
      SELECT ?, n + ?, 'plan_log_' || n, 'system', 'shown', '', '2026-01-01', '2026-01-01'
      FROM generate_series(1, 5000) n`, [history.id, f.store.getConversationLogHead(history.id)!.headSeq]);
    f.db.run("UPDATE multiremi_conversation_heads SET head_seq = head_seq + 5000 WHERE session_id = ?", [history.id]);
    f.db.exec("ANALYZE multiremi_conversation_log");
    const plan = JSON.stringify(fixture().db.query(`EXPLAIN ${RE_RING_SWEEP_CANDIDATES_SQL}
      ORDER BY COALESCE(l.swept_at, '') LIMIT 50`).all());
    expect(plan).toContain("idx_multiremi_tasks_lane_active");
    expect(plan).toContain("multiremi_conversation_heads");
    expect(plan).not.toContain("multiremi_conversation_log");
    const pageResult = f.db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${RE_RING_SWEEP_PAGE_SQL}`).all(50);
    const pagePlan = JSON.stringify(pageResult);
    expect(pagePlan).toContain("idx_multiremi_lanes_sweep_pending");
    expect(pagePlan).not.toContain("multiremi_conversation_log");
    const root = (Object.values(pageResult[0]!)[0] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan;
    expect(root["Actual Rows"]).toBe(1);
    const logPlan = JSON.stringify(f.db.query(`EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM multiremi_conversation_log
      WHERE session_id = ? AND seq > ? AND seq <= ? AND visibility = 'shown' ORDER BY seq LIMIT 500`).all(
        target.session.id, 0, f.store.getConversationLogHead(target.session.id)!.headSeq));
    expect(logPlan).toContain("Index");
    expect(logPlan).not.toContain("Seq Scan on multiremi_conversation_log");
    console.info("MUL-492 pending-hint page EXPLAIN", pagePlan);
    console.info("MUL-492 bounded log EXPLAIN", logPlan);
  });
});
