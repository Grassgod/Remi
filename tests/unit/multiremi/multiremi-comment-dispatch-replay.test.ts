import { expect, it } from "bun:test";
import { createCommitEventQueue, type StoreContext, type CreatedIssueComment, type CommitEventQueue } from "@multiremi/store/context.js";
import type { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import type { UpdateIssueCommentInput } from "@multiremi/contracts/types.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-492 comment intent replay", (fixture, backend) => {
  function setup(squad = false) {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Replay owner", provider: "codex" });
    const team = squad ? f.store.createSquad({ name: "Replay squad", leaderId: agent.id, memberIds: [] }) : null;
    const issue = f.store.createIssue({ title: "Replay comments", status: "in_progress", assigneeType: team ? "squad" : "agent", assigneeId: team?.id ?? agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    const member = f.store.findWorkspaceMemberForUser("local", "local")!;
    const ctx = (f.store as unknown as { ctx: StoreContext }).ctx;
    const repo = (f.store as unknown as { issues: IssuesRepo }).issues;
    return { ...f, agent, team, issue, session, member, ctx, repo };
  }
  function deferred(f: ReturnType<typeof setup>, body = "Please continue"): CreatedIssueComment {
    return f.transaction(() => f.repo.createIssueCommentWithinTransaction(f.issue.id, {
      authorType: "member", authorId: f.member.id, issueSessionId: f.session.id, body,
    }, { withinTransaction: true, splitAssigneeDispatch: true, deferDispatch: true, deferredEvents: createCommitEventQueue() }));
  }
  const intent = (f: ReturnType<typeof setup>, id: string) => f.store.getSystemEvent(id)!;
  const replayActivities = (f: ReturnType<typeof setup>) => f.store.listIssueActivity(f.issue.id).filter(a => a.type === "comment_dispatch_replayed");
  function reject(f: ReturnType<typeof setup>, table: "multiremi_tasks" | "multiremi_issue_activity", condition = "TRUE"): () => void {
    if (backend === "PostgreSQL") {
      f.db.run("CREATE FUNCTION mul492_reject() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected replay write failure'; END; $$ LANGUAGE plpgsql");
      f.db.run(`CREATE TRIGGER mul492_reject BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION mul492_reject()`);
      return () => f.db.exec(`DROP TRIGGER mul492_reject ON ${table}; DROP FUNCTION mul492_reject()`);
    }
    f.db.exec(`CREATE TRIGGER mul492_reject BEFORE INSERT ON ${table} FOR EACH ROW WHEN ${condition}
      BEGIN SELECT RAISE(ABORT, 'injected replay write failure'); END`);
    return () => f.db.exec("DROP TRIGGER mul492_reject");
  }

  for (const squad of [false, true]) it(`${squad ? "03" : "02"}: replays a committed no-mention ${squad ? "squad" : "agent"} comment once`, () => {
    const f = setup(squad);
    const created = deferred(f);
    const event = intent(f, created.dispatchIntentId!);
    expect(event.status).toBe("pending");
    expect(f.store.getIssueComment(created.comment.id)).not.toBeNull();
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
    const now = Date.parse(event.availableAt);
    f.store.dispatchPendingSystemEvents(new Date(now));
    const tasks = f.store.listTasksForIssue(f.issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ agentId: f.agent.id, issueSessionId: f.session.id, execution_scope: "",
      wakeSource: null, triggerCommentId: created.comment.id, chatSessionId: null });
    expect(f.store.listIssueActivity(f.issue.id).filter(a => a.type === "comment_assignee_triggered")).toHaveLength(1);
    expect(replayActivities(f).map(a => a.data)).toEqual([{ commentId: created.comment.id, eventId: event.id, attempt: 1, taskIds: [tasks[0]!.id] }]);
    expect(intent(f, event.id).status).toBe("processed");
    f.store.dispatchPendingSystemEvents(new Date(now + 60_000));
    expect(f.store.listTasksForIssue(f.issue.id).map(t => t.id)).toEqual(tasks.map(t => t.id));
    expect(replayActivities(f)).toHaveLength(1);
  });

  it("01: keeps the automatic reply/final_entry_id after dispatch SQL failure, then replays once", () => {
    const f = setup();
    const worker = f.store.createAgent({ name: "Reply worker", provider: "codex" });
    const team = f.store.createSquad({ name: "Reply team", leaderId: f.agent.id, memberIds: [worker.id] });
    f.store.updateIssue(f.issue.id, { assigneeType: "squad", assigneeId: team.id });
    const runtime = f.store.registerRuntime({ name: "Reply runtime", provider: "codex" });
    const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Lead" });
    expect(f.store.claimTask(runtime.id)?.id).toBe(task.id);
    f.store.startTask(task.id);
    const undo = reject(f, "multiremi_tasks", `NEW.agent_id = '${worker.id}'`);
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try { f.store.completeTask(task.id, { output: `[@Reply worker](mention://agent/${worker.id}) Verify` }); }
    finally { console.warn = warn; undo(); }
    expect(f.store.getTask(task.id)!.status).toBe("completed");
    expect(warnings).toHaveLength(1);
    const reply = f.store.listIssueComments(f.issue.id).find(c => c.taskId === task.id)!;
    expect(f.store.findTurnEntry(task.id)!.metadata).toMatchObject({ final_entry_id: reply.id });
    const row = f.db.query("SELECT id FROM multiremi_system_events WHERE resource = 'issue_comment' AND resource_id = ?").get(reply.id)!;
    const event = f.store.getSystemEvent(String(row.id))!;
    expect(event.status).toBe("pending");
    expect(f.store.listTasksForIssue(f.issue.id).filter(t => t.agentId === worker.id)).toHaveLength(0);
    expect(f.store.getSessionAgentLane(f.session.id, worker.id)).toBeNull();
    f.store.dispatchPendingSystemEvents(new Date(Date.parse(event.availableAt)));
    const target = f.store.listTasksForIssue(f.issue.id).filter(t => t.agentId === worker.id);
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({ wakeSource: "mention", triggerCommentId: reply.id });
    f.store.dispatchPendingSystemEvents(new Date(Date.parse(event.availableAt) + 60_000));
    expect(f.store.listTasksForIssue(f.issue.id).filter(t => t.agentId === worker.id).map(t => t.id)).toEqual([target[0]!.id]);
    expect(replayActivities(f)).toHaveLength(1);
  });

  for (const { kind, legacy } of [{ kind: "edit", legacy: false }, { kind: "delete", legacy: false },
    { kind: "delete", legacy: true }] as const) it(`04: ${kind}${legacy ? " pre-upgrade intent" : ""} recovery uses persisted ids, cancels once and preserves a merged report`, () => {
    const f = setup();
    const comment = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: f.member.id,
      body: `[@Replay owner](mention://agent/${f.agent.id}) Work` });
    const original = f.store.listTasksForIssue(f.issue.id)[0]!;
    const report = f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to: { role: "issue_owner", issueId: f.issue.id },
      kind: "report", wake: "now", source: {}, body: "Surviving report" }, [], createCommitEventQueue()))[0]!;
    const mutable = f.repo as unknown as {
      updateIssueCommentWithinTransaction(id: string, input: UpdateIssueCommentInput, events: CommitEventQueue): { dispatchIntentId: string };
      deleteIssueCommentWithinTransaction(id: string, events: CommitEventQueue): { dispatchIntentId: string };
    };
    const changed = f.transaction(() => kind === "edit"
      ? mutable.updateIssueCommentWithinTransaction(comment.id, { body: "Edited" }, createCommitEventQueue())
      : mutable.deleteIssueCommentWithinTransaction(comment.id, createCommitEventQueue()));
    const event = intent(f, changed.dispatchIntentId);
    expect(event.payload.commentIds).toEqual([comment.id]);
    expect(event.payload.lanes).toEqual([expect.objectContaining({ agentId: f.agent.id, issueSessionId: f.session.id, executionScope: "" })]);
    if (legacy) {
      const payload = { ...event.payload, lanes: (event.payload.lanes as Record<string, unknown>[]).map(({ triggerSummary, ...lane }) => lane) };
      f.db.run("UPDATE multiremi_system_events SET payload = ? WHERE id = ?", [JSON.stringify(payload), event.id]);
    }
    if (kind === "delete") f.db.run("UPDATE multiremi_tasks SET trigger_comment_id = NULL WHERE id = ?", [original.id]);
    expect(f.store.getTask(original.id)!.status).toBe("queued");
    if (kind === "delete") expect(f.store.getIssueComment(comment.id)).toBeNull();
    f.store.dispatchPendingSystemEvents(new Date(Date.parse(event.availableAt)));
    const tasks = f.store.listTasksForIssue(f.issue.id);
    expect(tasks).toHaveLength(2);
    expect(f.store.getTask(original.id)!.status).toBe("cancelled");
    const queued = tasks.filter(t => t.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ wakeSource: "re_ring", triggerCommentId: null, chatSessionId: null });
    expect(Number(f.db.query("SELECT wake_seq FROM multiremi_tasks WHERE id = ?").get(queued[0]!.id)!.wake_seq)).toBe(report.entry.seq);
    expect(f.store.listIssueActivity(f.issue.id).filter(a => a.type === "re_ring").map(a => a.data))
      .toEqual([expect.objectContaining({ origin: "trigger_comment_changed" })]);
    expect(f.store.getConversationLogEntryById(report.entry.id)!.body_md).toBe("Surviving report");
    expect(intent(f, event.id).lastError).toBeNull();
    expect(replayActivities(f)).toHaveLength(1);
    f.store.dispatchPendingSystemEvents(new Date(Date.parse(event.availableAt) + 60_000));
    expect(f.store.listTasksForIssue(f.issue.id).map(t => t.id).sort()).toEqual(tasks.map(t => t.id).sort());
    expect(replayActivities(f)).toHaveLength(1);
  });

  for (const kind of ["edit", "delete"] as const) for (const mode of ["normal", "replay"] as const)
    for (const ownership of ["detached return", "another comment"] as const)
      it(`04: ${mode} ${kind} rechecks ownership before cancelling a task now belonging to ${ownership}`, () => {
        const f = setup();
        const comment = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: f.member.id,
          body: `[@Replay owner](mention://agent/${f.agent.id}) Work` });
        const original = f.store.listTasksForIssue(f.issue.id)[0]!;
        f.transaction(() => f.store.sendEnvelopeWithinTransaction({ to: { role: "issue_owner", issueId: f.issue.id },
          kind: "report", wake: "now", source: {}, body: "Merged work must not ring a detached return" }, [], createCommitEventQueue()));
        const other = f.store.createIssueComment(f.issue.id, { authorType: "system", body: "Another comment" });
        const ids = f.store.listTasksForIssue(f.issue.id).map(task => task.id);
        const mutable = f.repo as unknown as {
          consumeCommentDispatchIntent(id: string): unknown;
          updateIssueCommentWithinTransaction(id: string, input: UpdateIssueCommentInput, events: CommitEventQueue): { dispatchIntentId: string };
          deleteIssueCommentWithinTransaction(id: string, events: CommitEventQueue): { dispatchIntentId: string };
        };
        const detach = () => f.db.run(`UPDATE multiremi_tasks
          SET trigger_comment_id = ?, trigger_summary = ?, prompt = ? WHERE id = ?`,
        [ownership === "another comment" ? other.id : null, ownership === "another comment" ? other.body : null,
          "Terminal return retained", original.id]);
        let eventId: string;
        if (mode === "normal") {
          const consume = mutable.consumeCommentDispatchIntent;
          mutable.consumeCommentDispatchIntent = id => {
            eventId = id;
            // The change and snapshot have committed; promotion wins before
            // the post-commit consumer gets W, just like the PG lock fixture.
            expect(f.db.inTransaction).toBe(false);
            detach();
            return consume.call(f.repo, id);
          };
          try {
            if (kind === "edit") f.store.updateIssueComment(comment.id, { body: "Edited" });
            else f.store.deleteIssueComment(comment.id);
          } finally { mutable.consumeCommentDispatchIntent = consume; }
        } else {
          const changed = f.transaction(() => kind === "edit"
            ? mutable.updateIssueCommentWithinTransaction(comment.id, { body: "Edited" }, createCommitEventQueue())
            : mutable.deleteIssueCommentWithinTransaction(comment.id, createCommitEventQueue()));
          eventId = changed.dispatchIntentId;
          detach();
          f.store.dispatchPendingSystemEvents(new Date(Date.parse(intent(f, eventId).availableAt)));
        }
        expect(f.store.getTask(original.id)).toMatchObject({ status: "queued", prompt: "Terminal return retained",
          triggerCommentId: ownership === "another comment" ? other.id : null });
        expect(f.store.listTasksForIssue(f.issue.id).map(task => task.id)).toEqual(ids);
        expect(f.store.listIssueActivity(f.issue.id).filter(activity => activity.type === "re_ring")).toHaveLength(0);
        expect(intent(f, eventId!).status).toBe("processed");
        expect(replayActivities(f).map(activity => (activity.data as { taskIds: string[] }).taskIds))
          .toEqual(mode === "replay" ? [[]] : []);
        f.store.dispatchPendingSystemEvents(new Date(Date.parse(intent(f, eventId!).availableAt) + 60_000));
        expect(f.store.listTasksForIssue(f.issue.id).map(task => task.id)).toEqual(ids);
      });

  it("05/07: normal post-commit consumption is depth one and broadcasts only after COMMIT", () => {
    const f = setup();
    const created = deferred(f);
    const depths: boolean[] = [];
    const off = f.store.onTaskEnqueued(() => depths.push(f.db.inTransaction!));
    const db = f.db as typeof f.db & { resetTransactionDepthStats?: () => void; maxTransactionDepth?: number };
    db.resetTransactionDepthStats?.();
    const transaction = f.db.transaction;
    let depth = 0;
    let maxDepth = 0;
    f.db.transaction = (<T>(fn: (...args: any[]) => T) => transaction.call(f.db, (...args: any[]) => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      try { return fn(...args); }
      finally { depth--; }
    }) as (...args: any[]) => T);
    try { f.store.runIssueCommentPostCommit(created, { authorId: f.member.id }); }
    finally { off(); f.db.transaction = transaction; }
    expect(depths).toEqual([false]);
    expect(maxDepth).toBe(1);
    if (backend === "PostgreSQL") expect(db.maxTransactionDepth).toBe(1);
    expect(intent(f, created.dispatchIntentId!).status).toBe("processed");
    const before = f.store.listTasksForIssue(f.issue.id).map(t => t.id);
    f.store.dispatchPendingSystemEvents(new Date(Date.now() + 61_000));
    expect(f.store.listTasksForIssue(f.issue.id).map(t => t.id)).toEqual(before);
    expect(replayActivities(f)).toHaveLength(0);
  });

  it("05/14: fencing rejects both late normal dispatch and an expired lease owner", () => {
    const f = setup();
    const created = deferred(f);
    const event = intent(f, created.dispatchIntentId!);
    const now = Date.parse(event.availableAt);
    const old = f.store.claimPendingSystemEvents(new Date(now))[0]!;
    f.store.runIssueCommentPostCommit(created, { authorId: f.member.id });
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
    expect(f.store.claimPendingSystemEvents(new Date(now + 59_999))).toHaveLength(0);
    const fresh = f.store.claimPendingSystemEvents(new Date(now + 60_001))[0]!;
    expect(fresh.attemptCount).toBe(old.attemptCount + 1);
    expect(f.store.replayCommentDispatchEvent(old, now + 60_001)).toEqual([]);
    expect(intent(f, event.id)).toMatchObject({ status: "processing", attemptCount: fresh.attemptCount });
    f.store.replayCommentDispatchEvent(fresh, now + 60_001);
    f.store.replayCommentDispatchEvent(old, now + 120_000);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    expect(replayActivities(f)).toHaveLength(1);
  });

  for (const skip of ["comment_missing", "expired", "replay_disabled"] as const) it(`06: discards ${skip} comment dispatch without reviving it`, () => {
    const f = setup();
    const created = deferred(f);
    const event = intent(f, created.dispatchIntentId!);
    if (skip === "comment_missing") f.store.deleteIssueComment(created.comment.id);
    const previous = process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY;
    if (skip === "replay_disabled") process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY = "off";
    try {
      f.store.dispatchPendingSystemEvents(new Date(Date.parse(event.createdAt) + (skip === "expired" ? 24 * 60 * 60_000 + 1 : 61_000)));
    } finally {
      if (previous === undefined) delete process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY;
      else process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY = previous;
    }
    expect(intent(f, event.id)).toMatchObject({ status: "processed", lastError: skip });
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
    f.store.dispatchPendingSystemEvents(new Date(Date.parse(event.createdAt) + 25 * 60 * 60_000));
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
  });

  it("06: replay switch never suppresses normal dispatch, and honors the exact delay boundary", () => {
    const f = setup();
    const first = deferred(f);
    const event = intent(f, first.dispatchIntentId!);
    expect(f.store.claimPendingSystemEvents(new Date(Date.parse(event.availableAt) - 1))).toHaveLength(0);
    const previous = process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY;
    process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY = "disabled";
    try { f.store.runIssueCommentPostCommit(first, { authorId: f.member.id }); }
    finally {
      if (previous === undefined) delete process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY;
      else process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY = previous;
    }
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    expect(intent(f, event.id).status).toBe("processed");
  });

  for (const failure of ["task", "activity"] as const) it(`05: ${failure} failure rolls back intent and all dispatch writes before retry`, () => {
    const f = setup();
    const created = deferred(f);
    const event = intent(f, created.dispatchIntentId!);
    const now = Date.parse(event.availableAt);
    const undo = reject(f, failure === "task" ? "multiremi_tasks" : "multiremi_issue_activity",
      failure === "activity" ? "NEW.type = 'comment_dispatch_replayed'" : "TRUE");
    try { f.store.dispatchPendingSystemEvents(new Date(now)); }
    finally { undo(); }
    expect(intent(f, event.id)).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
    expect(replayActivities(f)).toHaveLength(0);
    f.store.dispatchPendingSystemEvents(new Date(now + 1000));
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    expect(replayActivities(f)).toHaveLength(1);
  });

  it("06: caps failures at eight attempts and keeps another event moving", () => {
    const f = setup();
    const first = deferred(f);
    const other = setup();
    const second = deferred(other);
    const event = intent(f, first.dispatchIntentId!);
    let now = Date.parse(event.availableAt);
    const undo = reject(f, "multiremi_tasks", `NEW.agent_id = '${f.agent.id}'`);
    try {
      for (let attempt = 1; attempt <= 8; attempt++) {
        f.store.dispatchPendingSystemEvents(new Date(now));
        expect(intent(f, event.id).attemptCount).toBe(attempt);
        now = Date.parse(intent(f, event.id).availableAt);
      }
    } finally { undo(); }
    expect(intent(f, event.id).status).toBe("failed");
    expect(intent(f, event.id).lastError).toContain("injected replay write failure");
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
    expect(intent(other, second.dispatchIntentId!).status).toBe("processed");
    expect(other.store.listTasksForIssue(other.issue.id)).toHaveLength(1);
  });

  it("05: a multi-target SQL failure leaves no partially dispatched group", () => {
    const f = setup();
    const peer = f.store.createAgent({ name: "Second target", provider: "codex" });
    const created = deferred(f, `[@Owner](mention://agent/${f.agent.id}) [@Second](mention://agent/${peer.id}) Work`);
    const event = intent(f, created.dispatchIntentId!);
    const now = Date.parse(event.availableAt);
    const undo = reject(f, "multiremi_tasks", `NEW.agent_id = '${peer.id}'`);
    try { f.store.dispatchPendingSystemEvents(new Date(now)); }
    finally { undo(); }
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
    expect(intent(f, event.id).status).toBe("pending");
    expect(f.store.listIssueActivity(f.issue.id).filter(a => a.type === "comment_mention_triggered")).toHaveLength(0);
    f.store.dispatchPendingSystemEvents(new Date(now + 1000));
    const tasks = f.store.listTasksForIssue(f.issue.id);
    expect(tasks.map(t => t.agentId).sort()).toEqual([f.agent.id, peer.id].sort());
    expect(replayActivities(f)).toHaveLength(1);
    f.store.dispatchPendingSystemEvents(new Date(now + 61_000));
    expect(f.store.listTasksForIssue(f.issue.id).map(t => t.id).sort()).toEqual(tasks.map(t => t.id).sort());
  });

  it("06: a 24-hour-old dispatch is still eligible and an archived recipient is not", () => {
    const f = setup();
    const first = deferred(f);
    const event = intent(f, first.dispatchIntentId!);
    f.store.dispatchPendingSystemEvents(new Date(Date.parse(event.createdAt) + 24 * 60 * 60_000));
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    const other = setup();
    const second = deferred(other);
    other.db.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), other.agent.id]);
    other.store.dispatchPendingSystemEvents(new Date(Date.parse(intent(other, second.dispatchIntentId!).availableAt)));
    expect(other.store.listTasksForIssue(other.issue.id)).toHaveLength(0);
  });

  it("05: member mentions suppress assignee replay and replay never repeats notifications", () => {
    const f = setup();
    const created = deferred(f, `[@Member](mention://member/${f.member.id}) Please review`);
    const notifications: string[] = [];
    const trigger = (f.repo as unknown as { triggerMemberMentions: (...args: unknown[]) => string[] }).triggerMemberMentions;
    (f.repo as unknown as { triggerMemberMentions: (...args: unknown[]) => string[] }).triggerMemberMentions = () => {
      notifications.push("notified");
      return [f.member.id];
    };
    try { f.store.dispatchPendingSystemEvents(new Date(Date.parse(intent(f, created.dispatchIntentId!).availableAt))); }
    finally { (f.repo as unknown as { triggerMemberMentions: typeof trigger }).triggerMemberMentions = trigger; }
    expect(notifications).toEqual([]);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(0);
    expect(intent(f, created.dispatchIntentId!).status).toBe("processed");
  });

  it("14: stale deletion recovery cannot cancel work under a new lease", () => {
    const f = setup();
    const comment = f.store.createIssueComment(f.issue.id, { authorType: "member", authorId: f.member.id, body: "Work" });
    const original = f.store.listTasksForIssue(f.issue.id)[0]!;
    const mutable = f.repo as unknown as { deleteIssueCommentWithinTransaction(id: string, events: CommitEventQueue): { dispatchIntentId: string } };
    const changed = f.transaction(() => mutable.deleteIssueCommentWithinTransaction(comment.id, createCommitEventQueue()));
    const event = intent(f, changed.dispatchIntentId);
    const now = Date.parse(event.availableAt);
    const old = f.store.claimPendingSystemEvents(new Date(now)).find(e => e.id === event.id)!;
    const fresh = f.store.claimPendingSystemEvents(new Date(now + 60_001)).find(e => e.id === event.id)!;
    f.store.replayCommentDispatchEvent(old, now + 60_001);
    expect(f.store.getTask(original.id)!.status).toBe("queued");
    // Dispatch-only discard rules never discard edit/delete recovery.
    const previous = process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY;
    process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY = "off";
    try { f.store.replayCommentDispatchEvent(fresh, now + 25 * 60 * 60_000); }
    finally {
      if (previous === undefined) delete process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY;
      else process.env.MULTIREMI_COMMENT_DISPATCH_REPLAY = previous;
    }
    expect(f.store.getTask(original.id)!.status).toBe("cancelled");
    expect(intent(f, event.id)).toMatchObject({ status: "processed", lastError: null });
    f.store.replayCommentDispatchEvent(old, now + 26 * 60 * 60_000);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    expect(replayActivities(f)).toHaveLength(1);
  });
});
