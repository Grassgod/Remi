import { turnCompletion } from "../../fixtures/turn-report.js";
import { expect, spyOn, test } from "bun:test";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

for (const confirmed of [false, true]) {
  test(`recovers start after ${confirmed ? "confirmed" : "unconfirmed"} acceptance disconnect without running twice`, async () => {
    let finish!: () => void;
    const finishing = new Promise<void>(resolve => { finish = resolve; });
    let runs = 0;
    let droppedAcceptance = false;
    let droppedStart = false;
    let droppedCompletionAck = false;
    const replies: Array<ReturnType<typeof spyOn>> = [];
    const cards: string[] = [];
    const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5],
      onRoundCard: taskId => cards.push(taskId),
      providerFactory: () => ({
        async *sendStream() {
          runs++;
          await finishing;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "synthetic answer" }] } as any;
        },
        getLastResponse: () => ({ text: "synthetic answer", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }),
      beforeSend(frame, socket, harness) {
        const offer = socket.frames.find(row => row.t === "task.offer");
        if (!confirmed && !droppedAcceptance && frame.t === "res" && offer && frame.re === String(offer.seq)) {
          droppedAcceptance = true;
          return false;
        }
        if (!droppedStart && frame.t === "task.start") {
          droppedStart = true;
          socket.close(4001);
          return false;
        }
        if (frame.t === "turn.complete" && !droppedCompletionAck) {
          const session = harness.sessions.at(-1)!;
          const sendReply = session.sendReply.bind(session);
          replies.push(spyOn(session, "sendReply").mockImplementation((re, payload) => {
            if (re === String(frame.seq) && (payload as { ok?: unknown }).ok === true && !droppedCompletionAck) {
              droppedCompletionAck = true;
              socket.close(4001);
              return false;
            }
            return sendReply(re, payload);
          }));
        }
      },
    });
    try {
      await h.startDaemon();
      await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const agent = h.store.createAgent({ name: "inert report recovery", provider: "claude", runtimeId, workspaceId: "local" });
      const issue = h.store.createIssue({ title: "Recovered report", workspaceId: "local", assigneeType: "agent", assigneeId: agent.id });
      const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "inert recovery", maxAttempts: 1 });
      await waitFor(() => droppedStart && h.client.connectionState() === "disconnected", "first start disconnected", 5_000);
      if (confirmed) {
        expect(h.store.getTask(task.id)?.acceptedAt).not.toBeNull();
        expect(h.store.getTask(task.id)?.status).toBe("dispatched");
      } else {
        await waitFor(() => h.store.getTask(task.id)?.status === "queued", "actual offer-close requeue", 5_000);
        expect(h.store.getTask(task.id)?.acceptedAt).toBeNull();
      }
      // Recovery must not wait for a new offer: drain deliberately gates dispatch.
      h.store.beginPlatformDrain({ operationId: "report-recovery", ttlMs: 120_000 });
      await h.reconnect();
      await waitFor(() => h.ledger.some(entry => entry.type === "task.start" && entry.partition === task.id), "welcome-retried start ingress", 5_000);
      await waitFor(() => h.daemon.outboxStats()?.pending === 0, "start acknowledgement", 5_000);
      expect(h.store.getTask(task.id)?.status).toBe("running");
      expect(h.store.getTask(task.id)?.startedAt).not.toBeNull();
      await waitFor(() => runs === 1, "inert provider starts once", 5_000);
      await waitFor(() => (h.daemon as unknown as { serverDrainActive: boolean }).serverDrainActive, "daemon applies drain", 5_000);
      h.clock.advance(15_000);
      await waitFor(() => h.store.getPlatformDrainStatus().ackedDaemons === 1, "drain acknowledgement", 5_000);
      expect(h.store.getPlatformDrainStatus()).toMatchObject({ activeTasks: 1, ready: false });
      finish();
      await waitFor(() => h.store.getTask(task.id)?.status === "completed", "recovered completion", 5_000);
      await waitFor(() => droppedCompletionAck && h.client.connectionState() === "disconnected", "committed completion loses ACK", 5_000);
      const comments = h.store.listIssueComments(issue.id);
      const session = h.store.getTask(task.id)!.issueSessionId!;
      const events = h.store.listSessionEvents(session);
      const attempts = h.store.getTask(task.id)!.attempt;
      const counters = h.store.listWorkspaceAgentRunCounts();
      await h.reconnect();
      await waitFor(() => h.daemon.outboxStats()?.pending === 0, "completion acknowledgement", 5_000);
      expect(runs).toBe(1);
      expect(h.store.getTask(task.id)?.result).toBe("synthetic answer");
      expect(h.effectiveLedger.filter(entry => entry.type === "task.start" && entry.partition === task.id)).toHaveLength(1);
      expect(h.effectiveLedger.filter(entry => entry.type === "turn.complete" && entry.partition === task.id)).toHaveLength(1);
      expect(h.ledger.filter(entry => entry.type === "turn.complete" && entry.partition === task.id)).toHaveLength(2);
      expect(h.store.listIssueComments(issue.id)).toEqual(comments);
      expect(comments.filter(comment => comment.body === "synthetic answer")).toHaveLength(1);
      expect(h.store.listSessionEvents(session)).toEqual(events);
      expect(h.store.getTask(task.id)!.attempt).toBe(attempts);
      expect(h.store.listWorkspaceAgentRunCounts()).toEqual(counters);
      expect(cards.filter(id => id === task.id)).toHaveLength(1);
      expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id)).toHaveLength(1);
      await waitFor(() => h.store.getPlatformDrainStatus().ready, "recovery opens drain gate", 5_000);
      expect(h.store.getPlatformDrainStatus()).toMatchObject({ activeTasks: 0, ready: true });
    } finally {
      finish();
      for (const reply of replies) reply.mockRestore();
      await h.dispose();
    }
  }, 15_000);
}

test("a new Issue message during offer recovery is consumed in the same turn", async () => {
  let finish!: () => void;
  const finishing = new Promise<void>(resolve => { finish = resolve; });
  let droppedAcceptance = false;
  let droppedStart = false;
  let providers = 0;
  const prompts: string[] = [];
  const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5], daemonOptions: { maxConcurrency: 1 },
    providerFactory: () => {
      ++providers;
      let text = "first turn answer";
      return {
        async *sendStream(message) {
          prompts.push(message);
          text = message.includes("New input must be consumed by recovered turn") ? "new input answer" : "first turn answer";
          if (prompts.length === 1) await finishing;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text }] } as any;
        },
        getLastResponse: () => ({ text, sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      };
    },
    beforeSend(frame, socket) {
      const offer = socket.frames.find(row => row.t === "task.offer");
      if (!droppedAcceptance && frame.t === "res" && offer && frame.re === String(offer.seq)) {
        droppedAcceptance = true;
        return false;
      }
      if (!droppedStart && frame.t === "task.start") {
        droppedStart = true;
        socket.close(4001);
        return false;
      }
    },
  });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const agent = h.store.createAgent({ name: "Issue envelope recovery", provider: "claude", runtimeId });
    const issue = h.store.createIssue({ title: "New work during recovery", status: "in_progress",
      assigneeType: "agent", assigneeId: agent.id });
    const send = (body: string, dedupeKey: string) => {
      const events = createCommitEventQueue();
      const delivery = h.db.transaction(() => h.store.sendEnvelopeWithinTransaction({
        to: { role: "issue_owner", issueId: issue.id }, kind: "report", outcome: "done", wake: "now",
        body, dedupeKey, source: {},
      }, [], events)[0]!)();
      (h.store as unknown as { ctx: StoreContext }).ctx.emitCommitEvents(events);
      return delivery;
    };
    const initial = send("First immutable input", "initial-input");
    const oldTaskId = initial.task!.id;
    await waitFor(() => droppedStart && h.client.connectionState() === "disconnected"
      && h.store.getTask(oldTaskId)?.status === "queued" && prompts.length === 1,
    "real Issue offer disconnect and requeue", 5_000);
    const oldTask = h.store.getTask(oldTaskId)!;
    const oldBound = h.store.getBoundIssueLogToSeq(oldTaskId);
    const oldOffer = h.received.find(frame => frame.t === "task.offer" && frame.p.attempt_id === oldTaskId)!;
    const deliveredTo = oldOffer.p.session_projection.to_seq;
    const next = send("New input must be consumed by recovered turn", "new-input");
    expect(next.task?.id).toBe(oldTaskId);
    expect(next.entry.seq).toBeGreaterThan(deliveredTo);
    expect(h.store.getTask(oldTaskId)).toMatchObject({ prompt: oldTask.prompt,
      triggerCommentId: oldTask.triggerCommentId });
    expect(h.store.getBoundIssueLogToSeq(oldTaskId)).toBe(oldBound);
    expect(prompts[0]).toContain("First immutable input");
    expect(prompts[0]).not.toContain(next.entry.body_md);
    await h.reconnect();
    await waitFor(() => h.store.getTask(oldTaskId)?.status === "running", "old Issue turn recovered", 5_000);
    finish();
    await waitFor(() => h.store.getTask(oldTaskId)?.status === "completed"
      && h.daemon.outboxStats()?.pending === 0,
    "recovered turn consumes its interrupt and completes", 5_000);
    const tasks = h.store.listTasksForIssue(issue.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.result).toBe("new input answer");
    expect(h.received.filter(frame => frame.t === "turn.message" && frame.p.message.id === next.entry.id)).toHaveLength(1);
    expect(h.store.getTurnForAttempt(oldTaskId)?.input_to_seq).toBeGreaterThanOrEqual(next.entry.seq);
    expect(h.ledger.some(entry => entry.type === "turn.input" && entry.frame.p.input_to_seq >= next.entry.seq)).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(next.entry.body_md);
    expect(providers).toBe(1);
    for (const task of tasks) {
      expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id)).toHaveLength(1);
      expect(h.effectiveLedger.filter(entry => entry.type === "turn.complete" && entry.partition === task.id)).toHaveLength(1);
    }
  } finally {
    finish();
    await h.dispose();
  }
}, 15_000);

test("duplicate completion does not repeat delegation wakeups, comments or counters", async () => {
  const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5] });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const leaderRuntime = h.store.registerRuntime({ name: "Inert upstream", provider: "codex", workspaceId: "local", daemonId: "upstream-device" });
    const leader = h.store.createAgent({ name: "Upstream", provider: "codex", runtimeId: leaderRuntime.id });
    const worker = h.store.createAgent({ name: "Actual offered worker", provider: "claude", runtimeId });
    const parent = h.store.createIssue({ title: "Delegation parent", status: "in_progress", assigneeType: "agent", assigneeId: leader.id });
    const child = h.store.createIssue({ title: "Delegation child", parentIssueId: parent.id, status: "in_progress", assigneeType: "agent", assigneeId: worker.id });
    const source = h.store.createTask({ agentId: leader.id, issueId: parent.id, prompt: "Coordinate child" });
    expect(h.store.claimTask(leaderRuntime.id)?.id).toBe(source.id);
    h.store.startTask(source.id);
    h.store.completeTask(source.id, { output: "Await child result" });
    const task = h.store.createTask({ agentId: worker.id, issueId: child.id, prompt: "Inert delegated work",
      parentTaskId: source.id, delegationId: "dlg_replay_regression", delegatedByAgentId: leader.id,
      delegatedFromIssueSessionId: source.issueSessionId });
    await waitFor(() => h.store.getTask(task.id)?.status === "completed" && h.daemon.outboxStats()?.pending === 0, "actual offered child completion", 5_000);
    const finished = h.store.getTask(task.id)!;
    expect(finished.delegationReturnTaskId).toBeString();
    const returned = h.store.getTask(finished.delegationReturnTaskId!)!;
    expect(returned).toMatchObject({ agentId: leader.id, parentTaskId: null });
    expect(h.store.getMessage(returned.triggerCommentId!)?.metadata.message_source).toMatchObject({ taskId: task.id });
    expect(h.store.getTurnForAttempt(task.id)?.delegation_return_turn_id).toBe(h.store.getTurnForAttempt(returned.id)?.id);
    const comments = h.store.listIssueComments(child.id);
    const sessionEvents = h.store.listSessionEvents(source.issueSessionId!);
    const tasks = h.store.listTasks().map(task => ({ id: task.id, attempt: task.attempt, status: task.status }));
    const activity = h.store.listIssueActivity(parent.id);
    const counters = h.store.listWorkspaceAgentRunCounts();
    const reports = h.store.listMessages(source.issueSessionId!).filter(message => message.dedupe_key === `delegation_terminal:${task.id}`);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.metadata.message_source).toMatchObject({ taskId: task.id });
    for (const seq of [100_000, 100_001]) {
      await expect(h.client.event({ t: "turn.complete", seq, rt: runtimeId,
        p: turnCompletion(h.store, task.id, "fixture", {  }) })).resolves.toMatchObject({ ok: true });
    }
    expect(h.store.listIssueComments(child.id)).toEqual(comments);
    expect(h.store.listSessionEvents(source.issueSessionId!)).toEqual(sessionEvents);
    expect(h.store.listTasks().map(task => ({ id: task.id, attempt: task.attempt, status: task.status }))).toEqual(tasks);
    expect(h.store.listIssueActivity(parent.id)).toEqual(activity);
    expect(h.store.listWorkspaceAgentRunCounts()).toEqual(counters);
    expect(h.store.getTask(task.id)!.delegationReturnTaskId).toBe(returned.id);
  } finally { await h.dispose(); }
}, 15_000);

for (const replacement of ["cancelled", "assigned elsewhere"] as const) {
  test(`late reports cannot overwrite a task ${replacement} after the real offer disconnect`, async () => {
    let finish!: () => void;
    const finishing = new Promise<void>(resolve => { finish = resolve; });
    let droppedAcceptance = false;
    let droppedStart = false;
    let runs = 0;
    const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5],
      providerFactory: () => ({
        async *sendStream() {
          runs++;
          await finishing;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "late result" }] } as any;
        },
        getLastResponse: () => ({ text: "late result", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }),
      beforeSend(frame, socket) {
        const offer = socket.frames.find(row => row.t === "task.offer");
        if (!droppedAcceptance && frame.t === "res" && offer && frame.re === String(offer.seq)) {
          droppedAcceptance = true;
          return false;
        }
        if (!droppedStart && frame.t === "task.start") {
          droppedStart = true;
          socket.close(4001);
          return false;
        }
      },
    });
    try {
      await h.startDaemon();
      await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const agent = h.store.createAgent({ name: "late report guard", provider: "claude", runtimeId, workspaceId: "local" });
      const task = h.store.createTask({ agentId: agent.id, prompt: "inert late report", maxAttempts: 1 });
      await waitFor(() => droppedStart && h.client.connectionState() === "disconnected"
        && h.store.getTask(task.id)?.status === "queued", "actual requeue before authority changes", 5_000);
      let reportTaskId = task.id;
      if (replacement === "cancelled") h.store.cancelTask(task.id);
      else {
        const other = h.store.registerRuntime({ name: "Other real assignment", provider: "claude", workspaceId: "local", daemonId: "other-device" });
        h.store.updateAgent(agent.id, { runtimeId: other.id });
        // A frozen existing turn cannot be rerouted by changing its Agent.
        // Use a genuine new claim on the other runtime to test that reports
        // from the old runtime cannot adopt or complete somebody else's task.
        const elsewhere = h.store.createTask({ agentId: agent.id, prompt: "Other runtime owns this turn" });
        expect(h.store.claimTask(other.id)?.id).toBe(elsewhere.id);
        expect(h.store.getTask(elsewhere.id)?.runtimeId).toBe(other.id);
        reportTaskId = elsewhere.id;
      }
      const authoritative = h.store.getTask(reportTaskId)!;
      await h.reconnect();
      await waitFor(() => h.ledger.some(entry => entry.type === "task.start" && entry.partition === task.id), "late start reaches server", 5_000);
      if (replacement === "assigned elsewhere") await expect(h.client.event({ t: "task.start", seq: 99_999, rt: runtimeId,
        p: { task_id: reportTaskId } })).rejects.toMatchObject({ code: "authority_revoked", retryable: false });
      const completion = h.client.event({ t: "turn.complete", seq: 100_000, rt: runtimeId,
        p: turnCompletion(h.store, reportTaskId, "late result", {  }) });
      await expect(completion).rejects.toMatchObject({ code: replacement === "assigned elsewhere" ? "stale_attempt" : "invalid_report", retryable: false });
      expect(h.store.getTask(reportTaskId)).toMatchObject({
        status: authoritative.status, runtimeId: authoritative.runtimeId,
        startedAt: authoritative.startedAt, result: authoritative.result, completedAt: authoritative.completedAt,
      });
      expect(h.effectiveLedger.filter(entry => entry.partition === reportTaskId)).toHaveLength(0);
      expect(runs).toBeLessThanOrEqual(1);
    } finally {
      finish();
      await h.dispose();
    }
  }, 15_000);
}

for (const terminalReport of ["complete", "fail"] as const) {
for (const accepted of [true, false]) {
test(`a real ${accepted ? "accepted" : "requeued"} offer can ${terminalReport} when its start write was lost`, async () => {
  let finish!: () => void;
  const finishing = new Promise<void>(resolve => { finish = resolve; });
  let droppedStart = false;
  let droppedAcceptance = false;
  let terminalSent = false;
  let runs = 0;
  const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5],
    providerFactory: () => ({
      async *sendStream() {
        runs++;
        await finishing;
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "accepted completion" }] } as any;
      },
      getLastResponse: () => ({ text: "accepted completion", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
      close: async () => {},
    }),
    beforeSend(frame, socket) {
      const offer = socket.frames.find(row => row.t === "task.offer");
      if (!accepted && !droppedAcceptance && frame.t === "res" && offer && frame.re === String(offer.seq)) {
        droppedAcceptance = true;
        return false;
      }
      if (frame.t === "task.start" && !terminalSent) {
        if (!accepted && !droppedStart) socket.close(4001);
        droppedStart = true;
        return false;
      }
    },
  });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const agent = h.store.createAgent({ name: "Completion without start", provider: "claude", runtimeId });
    const task = h.store.createTask({ agentId: agent.id, prompt: "Inert accepted completion", maxAttempts: 1 });
    await waitFor(() => droppedStart && runs === 1
      && (accepted ? h.store.getTask(task.id)?.acceptedAt != null
        : h.client.connectionState() === "disconnected" && h.store.getTask(task.id)?.status === "queued"),
      "real offer received, local provider running, start absent", 5_000);
    expect(h.store.getTask(task.id)).toMatchObject({ status: accepted ? "dispatched" : "queued", startedAt: null });
    if (!accepted) {
      h.store.beginPlatformDrain({ operationId: `terminal-${terminalReport}`, ttlMs: 120_000 });
      h.clock.advance(1_000);
      await waitFor(() => h.client.connectionState() === "connected", "welcome while start remains unsent", 5_000);
    }
    expect(h.ledger.filter(entry => entry.partition === task.id && entry.type === "task.start")).toHaveLength(0);
    if (terminalReport === "complete") {
      const offer = h.received.find(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id)!.p;
      expect(await h.client.rpc("turn.input", { turn_id: offer.turn_id, attempt_id: task.id,
        input_to_seq: offer.input_to_seq, message_ids: offer.input_messages.map((message: { id: string }) => message.id) }, runtimeId))
        .toEqual({ ok: true, input_to_seq: offer.input_to_seq });
    }
    const expected = terminalReport === "complete"
      ? { status: "completed", result: "accepted completion" }
      : { status: "failed", error: "synthetic provider failure" };
    await expect(h.client.event({ t: terminalReport === "complete" ? "turn.complete" : "task.fail", seq: 100_000, rt: runtimeId,
      p: terminalReport === "complete" ? turnCompletion(h.store, task.id, "accepted completion")
        : { task_id: task.id, error: "synthetic provider failure" } })).resolves.toMatchObject({ ok: true });
    expect(h.store.getTask(task.id)).toMatchObject(expected);
    terminalSent = true;
    // Expire the unsent start exchange through the harness's clock; the real
    // outbox retries that row, receives a terminal replay ACK and then drains.
    h.clock.advance(30_000);
    finish();
    await waitFor(() => h.daemon.outboxStats()?.pending === 0
      && h.ledger.some(entry => entry.partition === task.id && entry.type === "task.start"),
    "lost start retries against the now-terminal task and drains", 5_000);
    expect(runs).toBe(1);
    // The ledger observes state writes for complete; fail is asserted directly
    // against its persisted terminal row, and neither report reruns the provider.
    if (terminalReport === "complete") expect(h.effectiveLedger.filter(entry => entry.partition === task.id && entry.type === "turn.complete")).toHaveLength(1);
    expect(h.store.getTask(task.id)).toMatchObject(expected);
    expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id)).toHaveLength(1);
    if (!accepted) {
      await waitFor(() => h.store.getPlatformDrainStatus().ready, "terminal recovery opens drain gate", 5_000);
      expect(h.store.getPlatformDrainStatus()).toMatchObject({ activeTasks: 0, ready: true });
    }
  } finally {
    finish();
    await h.dispose();
  }
}, 15_000);
}
}
