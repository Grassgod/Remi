import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingTurnBackendTests, type PendingTurnTestFixture } from "../multiremi/pending-turn-test-backends.js";
import { resetMultiremiTestEnv, useUploadDir } from "../multiremi/helpers.js";
import { startMultiremiServer } from "../../fixtures/daemon-protocol.js";
import { DaemonProtocolClient, type DaemonProtocolLane } from "@multiremi/worker/daemon-protocol-client.js";
import { DaemonTaskDownlinks } from "@multiremi/worker/daemon-downlinks.js";
import { MultiremiDaemon, type MultiremiTaskProvider } from "@multiremi/worker/daemon.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { materializeTaskSteerAttachments, buildSteerInjectionPrompt, TaskSteerFeed } from "@multiremi/worker/steer.js";
import { bindReportFrames } from "../../fixtures/report-session.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { createAgentResponse } from "@multiremi/contracts/provider-types.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { ElicitationCreateParams, ElicitationResult, RequestPermissionParams, PermissionOutcome } from "@multiremi/contracts/acp-protocol.js";

// Based on QA's actual Store + native WS + callback probes, with real downloads.
afterEach(resetMultiremiTestEnv);
const permissionParams: RequestPermissionParams = {
  sessionId: "provider-session",
  toolCall: { sessionUpdate: "tool_call_update", toolCallId: "tool", title: "Write" },
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" }],
};
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Store/WS callback did not settle");
    await Bun.sleep(5);
  }
}
async function setup({ store }: PendingTurnTestFixture, delegated = false) {
  const rt = "rt_decision_callback", daemonId = "daemon_decision_callback";
  store.registerRuntime({ id: rt, daemonId, name: rt, provider: "claude", workspaceId: "local", metadata: { parallel_agent_execution: 1 } });
  const agent = store.createAgent({ name: "Callback", provider: "claude", runtimeId: rt });
  const issue = store.createIssue({ title: "Callback", assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: 'mem_local_local' });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const send = (body_md: string, wake_requested: "now" | "next_turn" = "now", attachment_ids?: string[]) =>
    store.sendMessage({ session_id: session.id, sender: { type: "member", id: "mem_local_local" },
      to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested, body_md, attachment_ids });
  let dispatch: { leaderId: string; sessionId: string } | null = null;
  if (delegated) {
    const leaderRuntime = store.registerRuntime({ name: 'Original dispatch host', provider: 'claude', workspaceId: 'local', daemonId: 'original-dispatch-daemon' });
    const leader = store.createAgent({ name: 'Original delegator', provider: 'claude', runtimeId: leaderRuntime.id });
    const dispatchSession = store.createIssueSession(issue.id, { title: 'Original dispatch', inheritMode: 'none' });
    const leaderTask = store.createTask({ agentId: leader.id, issueId: issue.id, issueSessionId: dispatchSession.id, prompt: 'Coordinate' });
    expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id); store.startTask(leaderTask.id);
    store.sendMessage({ session_id: session.id, sender: { type: 'agent', id: leader.id }, source_turn_id: store.getTurnForAttempt(leaderTask.id)!.id,
      to: { type: 'agent', ref: agent.id }, message_kind: 'request', wake_requested: 'now', body_md: 'Start delegated work' });
    store.completeTask(leaderTask.id, { output: 'Dispatched the original work' });
    dispatch = { leaderId: leader.id, sessionId: dispatchSession.id };
  } else send("Start");
  const claimed = store.claimTask(rt)!;
  store.startTask(claimed.id);
  const attempt = store.getTaskWithAgent(claimed.id)!;
  const offer = store.getDaemonTurnBridge().offerInput(attempt);
  store.recordSessionAgentRangeRead(session.id, agent.id, { seq: 1, offset: 0 }, { seq: offer.input_to_seq + 1, offset: 0 }, attempt.id);
  const server = startMultiremiServer({ store, hostname: "127.0.0.1", port: 0, authToken: "callback-fixture" });
  const frames: Array<Record<string, any>> = [];
  const client = new DaemonProtocolClient({ serverUrl: `http://127.0.0.1:${server.port}`, token: "callback-fixture",
    daemonId, cliVersion: DAEMON_MIN_CLI_VERSION, onFrame: f => { frames.push(f.raw); } });
  const inbox = new DaemonTaskDownlinks(client, () => rt);
  inbox.bindTurn(offer);
  const feed = new TaskSteerFeed(inbox, attempt.id);
  feed.start();
  const lane: DaemonProtocolLane = {
    runtime: () => ({ runtime_id: rt, provider: "claude", max_concurrency: 1, active_task_ids: [attempt.id], active_question_waits: inbox.activeQuestionWaits() }),
    heartbeat: () => ({ active_task_count: 1 }), onHeartbeatAck: async () => {}, probeUpgrade: async () => {},
    onTerminal: async () => {}, onStateChange: () => inbox.connectionChanged(),
    onConnected: () => { client.send({ t: "runtime.ready", rt, p: { active_task_ids: [attempt.id], active_question_waits: inbox.activeQuestionWaits() } }); },
  };
  client.addLane(lane);
  const daemon = Object.create(MultiremiDaemon.prototype);
  Object.assign(daemon, { options: { approvalMode: "ask", humanRequestTimeoutMs: 10_000, runtimeId: rt },
    pollAbort: new AbortController(), ensureTrace: () => ({ append: () => {} }), taskDownlinks: inbox });
  let permission!: (params: RequestPermissionParams) => Promise<PermissionOutcome>;
  let question!: (params: ElicitationCreateParams) => Promise<ElicitationResult>;
  const provider = { setPermissionHandler: (h: typeof permission) => { permission = h; },
    setElicitationHandler: (h: typeof question) => { question = h; } } as MultiremiTaskProvider;
  daemon.attachHumanInputHandlers(provider, attempt, new AbortController().signal, () => 1);
  client.startLane(lane);
  await until(() => client.connectionState() === "connected");
  await inbox.consumeTaskSteerMessages(attempt.id, offer.input_messages.map(m => m.id));
  expect(store.getTurn(offer.turn_id)?.input_to_seq).toBe(offer.input_to_seq);
  const { token } = await store.createTaskAccessToken(attempt, "local");
  return { store, rt, agent, issue, session, attempt, offer, dispatch, send, frames, inbox, feed, permission, question, client, lane,
    serverUrl: `http://127.0.0.1:${server.port}`,
    async readRange(from: number, to: number) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/messages?from=${from}&to=${to}`,
        { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const page = await response.json() as { entries: Array<{ id: string; body_md: string }>; next_cursor: string | null };
      expect(page.next_cursor).toBeNull();
      return page.entries;
    },
    async decision() {
      await until(() => store.getTurn(offer.turn_id)?.status === "awaiting_human");
      return store.getMessage(store.getTurn(offer.turn_id)!.waiting_on_message_id!)!;
    },
    async close() { feed.stop(); client.stopLane(lane); await client.drain(); server.stop(true); },
  };
}

pendingTurnBackendTests("decision callbacks over Store and native WS", fixture => {
  it('same process socket reconnect preserves native wait and never schedules a second consumer', async () => {
    const h = await setup(fixture());
    try {
      const result = h.question({ mode: 'form', sessionId: 'same-process', message: 'Where?',
        requestedSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } });
      const decision = await h.decision();
      const nonce = h.inbox.activeQuestionWaits()[0]!.wait_id;
      h.client.runtimesChanged();
      await until(() => h.client.connectionState() === 'connected');
      expect(h.inbox.activeQuestionWaits()[0]!.wait_id).toBe(nonce);
      expect(h.store.getQuestion(decision.id)?.wait_status).toBe('waiting');
      h.store.answerMessageDecision(decision.id, { expected_route_revision: 1, sender: { type: 'member', id: 'mem_local_local' }, body_md: 'Paris', response: { answer: 'Paris' } });
      expect(await result).toEqual({ action: 'accept', content: { answer: 'Paris' } });
      expect(h.store.getQuestion(decision.id)?.wait_status).toBe('consumed');
      expect(h.store.getQuestion(decision.id)?.history.filter(event => event.type === 'continue')).toHaveLength(0);
    } finally { await h.close(); }
  }, 120_000);

  it('explicit close reaches the live provider callback without turning cancellation into an answer or continuation', async () => {
    const h = await setup(fixture());
    try {
      const result = h.question({ mode: 'form', sessionId: 'close-provider', message: 'Where?',
        requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Where?' } }, required: ['answer'] } });
      const decision = await h.decision();
      h.store.closeQuestion(decision.id, { expected_route_revision: 1, reason: 'User explicitly stops this question' }, { type: 'member', id: 'mem_local_local' });
      expect(await result).toEqual({ action: 'cancel' });
      expect(h.store.getQuestion(decision.id)).toMatchObject({ status: 'closed', answer: null, wait_status: 'detached', wait_reason: 'explicit_stop' });
      expect(h.store.getQuestion(decision.id)?.history.filter(event => event.type === 'close')).toHaveLength(1);
      h.store.reconcileQuestionWaits(h.rt, []);
      expect(h.store.getQuestion(decision.id)?.history.filter(event => event.type === 'continue')).toHaveLength(0);
    } finally { await h.close(); }
  }, 120_000);

  it('process exit loses its wait nonce; a persisted answer executes exactly one new provider consumer', async () => {
    const h = await setup(fixture(), true);
    const processes: Array<ReturnType<typeof Bun.spawn>> = [];
    const events: Array<Record<string, any>> = [];
    const launch = (mode: 'source' | 'consumer') => {
      const child = Bun.spawn([process.execPath, 'tests/fixtures/question-process-daemon.ts', JSON.stringify({
        mode, serverUrl: h.serverUrl, rt: h.rt, attempt: h.attempt, offer: h.offer,
      })], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', env: process.env });
      processes.push(child);
      void new Response(child.stderr).text().then(stderr => { if (stderr) console.error(`question ${mode} process: ${stderr}`); });
      void (async () => {
        let buffered = '';
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffered += new TextDecoder().decode(chunk);
          const lines = buffered.split('\n'); buffered = lines.pop()!;
          for (const line of lines) if (line.startsWith('{')) events.push(JSON.parse(line));
        }
      })();
      return child;
    };
    try {
      h.feed.stop(); h.client.stopLane(h.lane); await h.client.drain();
      h.store.pinTaskSession(h.attempt.id, 'original-provider-session', '/tmp/original-question-workdir');
      expect(h.attempt.delegatedByAgentId).toBe(h.dispatch!.leaderId);
      const source = launch('source');
      const decision = await h.decision();
      expect(h.store.getQuestion(decision.id)?.wait_status).toBe('waiting');
      source.kill('SIGKILL'); await source.exited;
      const oldToken = (await h.store.createTaskAccessToken(h.attempt, 'local')).token;
      h.store.answerMessageDecision(decision.id, { expected_route_revision: 1, sender: { type: 'member', id: 'mem_local_local' }, body_md: 'Paris', response: { answer: 'Paris' } });
      // The saved answer is not yet consumed by a callback in the exited process.
      expect(h.store.getQuestion(decision.id)?.wait_status).toBe('waiting');
      launch('consumer');
      try { await until(() => events.some(event => event.event === 'consumer_completed')); }
      catch (error) { console.error('process restart evidence', JSON.stringify({ events, question: h.store.getQuestion(decision.id), turns: fixture().db.query('SELECT * FROM multiremi_turns').all(), runtime: h.store.getRuntimeLite(h.rt), exits: processes.map(child => child.exitCode) })); throw error; }
      const question = h.store.getQuestion(decision.id)!;
      expect(question.wait_status).toBe('continuation_consumed');
      expect(question.history.filter(event => event.type === 'continue')).toHaveLength(1);
      expect(events.filter(event => event.event === 'provider_executed')).toHaveLength(1);
      expect(events.filter(event => event.event === 'old_provider_returned')).toHaveLength(0);
      expect(h.store.getTask(h.attempt.id)?.status).toBe('cancelled');
      const stale = await fetch(`${h.serverUrl}/api/sessions/${h.session.id}/messages`, { headers: { Authorization: `Bearer ${oldToken}` } });
      expect(stale.status).toBe(401);
      const newConsumer = h.store.getTask(events.find(event => event.event === 'consumer_ack')!.attempt_id)!;
      expect(newConsumer.execution_scope).toBe(h.attempt.execution_scope);
      expect(newConsumer.continuedFromTaskId).toBe(h.attempt.id);
      expect(newConsumer).toMatchObject({ sessionId: '', workDir: '', projectionMode: 'bootstrap',
        delegationId: h.attempt.delegationId, delegatedByAgentId: h.dispatch!.leaderId, delegatedFromIssueSessionId: h.dispatch!.sessionId, status: 'completed' });
      expect(Number(fixture().db.query("SELECT COUNT(*) AS count FROM multiremi_turns WHERE status IN ('pending','running','awaiting_human') AND agent_id=?").get(h.agent.id).count)).toBe(0);
      const returns = h.store.listConversationLogEntries(h.dispatch!.sessionId).filter(entry => (entry.metadata.message_source as { taskId?: string } | undefined)?.taskId === newConsumer.id);
      expect(returns).toHaveLength(1);
      expect(h.store.getMessage(returns[0]!.id)).toMatchObject({ to_agent_id: h.dispatch!.leaderId, message_kind: 'report' });
      expect(h.store.listConversationLogEntries(h.dispatch!.sessionId).filter(entry => (entry.metadata.message_source as { taskId?: string } | undefined)?.taskId === h.attempt.id)).toHaveLength(0);
      h.store.reconcileQuestionWaits(h.rt, []);
      expect(h.store.getQuestion(decision.id)?.history.filter(event => event.type === 'continue')).toHaveLength(1);
    } finally {
      for (const child of processes) { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
      await h.close();
    }
  }, 120_000);

  for (const optionId of ["allow", "deny", "unknown"]) it(`permission preserves ${optionId}, kind and tool call`, async () => {
    const h = await setup(fixture());
    try {
      const result = h.permission(permissionParams);
      const decision = await h.decision();
      expect(decision.metadata.human_request).toMatchObject({ kind: "permission", payload: {
        kind: "permission", session_id: permissionParams.sessionId, tool_call: permissionParams.toolCall,
        options: permissionParams.options,
      } });
      expect(decision.options?.map(o => o.value)).toEqual(["allow", "deny"]);
      expect(decision.metadata.options).toEqual(permissionParams.options);
      expect(h.store.getTaskHumanRequest(decision.id)).toMatchObject({ kind: "permission",
        payload: { options: permissionParams.options, tool_call: permissionParams.toolCall } });
      if (optionId === "unknown") {
        expect(() => h.store.answerMessageDecision(decision.id, { expected_route_revision: 1, sender: { type: "member", id: "mem_local_local" },
          body_md: optionId, response: { option_id: optionId } })).toThrow("invalid human response");
        expect(h.store.getTaskHumanRequest(decision.id)?.status).toBe("pending");
        await h.inbox.rpc("turn.decision.expire", { ...h.inbox.turnInput(h.attempt.id), message_id: decision.id, status: "cancelled" });
        expect(await result).toEqual({ outcome: "cancelled" });
        return;
      }
      const answer = h.store.answerMessageDecision(decision.id, { expected_route_revision: 1, sender: { type: "member", id: "mem_local_local" },
        body_md: optionId, response: { option_id: optionId } });
      expect(await result).toEqual(optionId === "unknown" ? { outcome: "cancelled" } : { outcome: "selected", optionId });
      expect(h.inbox.pendingTaskSteerMessages(h.attempt.id)).toEqual([]);
      await h.inbox.consumeTaskSteerMessages(h.attempt.id, []);
      expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(answer.message.seq);
    } finally { await h.close(); }
  }, 120_000);

  for (const kind of ["text", "option", "multi_text_keys", "multi_field_keys", "multi_options", "multi_conflict", "multi_duplicate", "long_text", "unread_context", "invalid_multi"] as const) {
    it(`elicitation restores ${kind} and preserves unread input`, async () => {
      const h = await setup(fixture());
      try {
        const multi = kind.startsWith("multi") || kind === "invalid_multi";
        const result = h.question({ mode: "form", sessionId: "provider-session", message: "Where?",
          requestedSchema: { type: "object", properties: {
            answer: { type: "string", title: "Where?", ...(kind === "option" || multi ? { enum: ["Paris", "Tokyo"] } : {}) },
            ...(multi ? { second: { type: "string", description: "When?", enum: ["Now", "Later"] } } : {}),
          }, required: ["answer"] } });
        const decision = await h.decision();
        expect(decision.metadata.human_request).toMatchObject({ kind: "question" });
        const ordinary = kind === "unread_context" ? h.send("Ordinary message must still be read", "next_turn") : null;
        const body = kind === "option" ? decision.options![0]!.value
          : kind === "multi_text_keys" ? JSON.stringify({ answers: { "Where?": "Paris", "When?": "Now" } })
          : kind === "multi_field_keys" ? JSON.stringify({ answers: { answer: "Paris", second: "Now" } })
          : kind === "multi_conflict" ? JSON.stringify({ answers: { answer: "Paris", "Where?": "Tokyo", second: "Now" } })
          : kind === "multi_options" ? JSON.stringify({ selected_options: decision.options!.filter(option =>
            ["Paris", "Now"].includes(JSON.parse(option.value).answer)).map(option => option.value) })
          : kind === "multi_duplicate" ? JSON.stringify({ selected_options: [decision.options![0]!.value, decision.options![0]!.value] })
          : kind === "invalid_multi" ? JSON.stringify({ answers: { unknown: "invalid" } })
          : kind === "long_text" ? "Paris".repeat(2000) : "Paris";
        const response = kind === "option" ? { selected_options: [body] }
          : multi ? JSON.parse(body) : { answer: body };
        if (kind === "invalid_multi" || kind === "multi_conflict" || kind === "multi_duplicate") {
          expect(() => h.store.answerMessageDecision(decision.id, { expected_route_revision: 1, sender: { type: "member", id: "mem_local_local" },
            body_md: body, response })).toThrow("invalid human response");
          expect(h.store.getTaskHumanRequest(decision.id)?.status).toBe("pending");
          await h.inbox.rpc("turn.decision.expire", { ...h.inbox.turnInput(h.attempt.id), message_id: decision.id, status: "cancelled" });
          expect(await result).toEqual({ action: "cancel" });
          return;
        }
        const answer = h.store.answerMessageDecision(decision.id, { expected_route_revision: 1, sender: { type: "member", id: "mem_local_local" }, body_md: body, response });
        expect(await result).toEqual({ action: "accept",
          content: multi ? { answer: "Paris", second: "Now" } : { answer: kind === "long_text" ? body : "Paris" } });
        const projection = h.frames.find(f => f.t === "turn.message" && f.p.message.id === answer.message.id)?.p.message;
        expect(projection.body_md).toStartWith('{"type":"unread_range"');
        if (ordinary || kind === "long_text") {
          const hints = h.inbox.pendingTaskSteerMessages(h.attempt.id);
          expect(hints).toHaveLength(1);
          expect(h.feed.take()).toEqual(hints);
          expect(buildSteerInjectionPrompt(hints)).toContain("remi message list");
          expect(hints[0]!.content).toContain("unread_range");
          expect(hints[0]!.content).toContain("remi message list");
          await expect(h.inbox.consumeTaskSteerMessages(h.attempt.id, [])).rejects.toThrow("unconfirmed turn input gap");
          expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(h.offer.input_to_seq);
          // A full range read sees the omitted ordinary body and advances its checkpoint.
          await expect(h.inbox.consumeTaskSteerMessages(h.attempt.id, hints.map(m => m.id))).rejects.toMatchObject({ code: "input_gap" });
          const range = await h.readRange(h.offer.input_to_seq, answer.message.seq);
          if (ordinary) expect(range.find(m => m.id === ordinary.message.id)?.body_md).toBe(ordinary.message.body_md);
          const readAnswer = range.find(m => m.id === answer.message.id)!;
          expect(JSON.parse(readAnswer.body_md)).toEqual(kind === "long_text" || !multi
            ? { ...response, answers: { "Where?": kind === "long_text" ? body : "Paris" } }
            : { ...response, answers: { "Where?": "Paris", "When?": "Now" } });
          await h.inbox.consumeTaskSteerMessages(h.attempt.id, hints.map(m => m.id));
        } else {
          expect(h.inbox.pendingTaskSteerMessages(h.attempt.id)).toEqual([]);
          await h.inbox.consumeTaskSteerMessages(h.attempt.id, []);
        }
        expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(answer.message.seq);
      } finally { await h.close(); }
    }, 120_000);
  }

  for (const scenario of ["read", "unread", "late_interrupt"] as const) it(`provider HTTP range receipt: ${scenario}`, async () => {
    const h = await setup(fixture());
    const workDir = mkdtempSync(join(tmpdir(), "decision-range-run-"));
    let permission!: (params: RequestPermissionParams) => Promise<PermissionOutcome>;
    let turns = 0, answerSeq = 0, lateSeq = 0, text = "";
    const provider: MultiremiTaskProvider = {
      setPermissionHandler: handler => { permission = handler; },
      typedSessionFailures: true,
      async *sendStream(prompt) {
        turns++;
        if (turns === 1) {
          const result = permission(permissionParams);
          const decision = await h.decision();
          const ordinary = h.send("Still-unread ordinary context", "next_turn");
          answerSeq = h.store.answerMessageDecision(decision.id,
            { expected_route_revision: 1, sender: { type: "member", id: "mem_local_local" }, body_md: "allow", response: { option_id: "allow" } }).message.seq;
          expect(await result).toEqual({ outcome: "selected", optionId: "allow" });
          expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(h.offer.input_to_seq);
          expect(h.store.getMessage(ordinary.message.id)?.body_md).toBe("Still-unread ordinary context");
          text = "Permission received";
        } else if (turns === 2) {
          expect(turns).toBe(2);
          expect(prompt).toContain("remi message list");
          expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(h.offer.input_to_seq);
          expect(h.store.getSessionAgentReadProgress(h.session.id, h.agent.id).seq).toBe(h.offer.input_to_seq);
          if (scenario !== "unread") {
            const range = await h.readRange(h.offer.input_to_seq, answerSeq);
            expect(range.some(m => m.body_md === "Still-unread ordinary context")).toBe(true);
            expect(range.some(m => JSON.parse(m.body_md.startsWith("{") ? m.body_md : "null")?.option_id === "allow")).toBe(true);
          }
          if (scenario === "late_interrupt") {
            const late = h.send("Second directive during provider execution");
            lateSeq = late.message.seq;
            await until(() => h.inbox.pendingTaskSteerMessages(h.attempt.id).some(m => m.id === late.message.id));
          }
          text = "Ordinary context handled";
        } else {
          expect(scenario).toBe("late_interrupt");
          expect(turns).toBe(3);
          expect(prompt).toContain("Second directive during provider execution");
          expect(h.store.getSessionAgentReadProgress(h.session.id, h.agent.id).seq).toBe(answerSeq);
          expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBeLessThan(lateSeq);
          const range = await h.readRange(answerSeq, lateSeq);
          expect(range.some(m => m.body_md === "Second directive during provider execution")).toBe(true);
          text = "Both directives handled";
        }
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text }] };
      },
      getLastResponse: () => createAgentResponse({ text, sessionId: "provider-session", inputTokens: 1, durationMs: 1 }),
    };
    const daemon = new MultiremiDaemon({ serverUrl: h.serverUrl, token: "callback-fixture", runtimeId: h.rt,
      provider: "claude", daemonId: "daemon_decision_callback", workspaceId: "local", approvalMode: "ask",
      workspacesRoot: workDir, outboxPath: join(workDir, "outbox.db"), gcEnabled: false,
      sshMeshManager: disabledSshMeshRuntime(), providerFactory: () => provider });
    const state = daemon as any;
    const downloader = new MultiremiDaemonClient(h.serverUrl, "callback-fixture");
    const drain = bindReportFrames(downloader, h.store, { runtimeId: h.rt });
    state.client = downloader;
    state.taskDownlinks = h.inbox;
    state.assertWorkspaceRootOwner = () => {};
    state.registerTaskRepos = async () => [];
    state.prepareTaskWorkspace = async () => ({ repos: [], checkouts: [] });
    state.reportIssueWorkspaceAfterRun = async () => {};
    state.enqueueTaskReport = () => {};
    state.ensureTrace = () => ({ append: (_attempt: string, _runtime: string, events: unknown[]) => events });
    try {
      const run = state.runAgent({ ...h.attempt, holdsWorkspace: false }, new AbortController().signal,
        { workDir, ensureDir: false });
      if (scenario === "unread") {
        await expect(run).rejects.toMatchObject({ code: "input_gap" });
        expect(turns).toBe(2);
        expect(h.store.getSessionAgentReadProgress(h.session.id, h.agent.id).seq).toBe(h.offer.input_to_seq);
        expect(h.store.getTurn(h.offer.turn_id)).toMatchObject({ status: "running", input_to_seq: h.offer.input_to_seq, reply_message_id: null });
        return;
      }
      const result = await run;
      expect(result.completed).toBe(true);
      expect(turns).toBe(scenario === "late_interrupt" ? 3 : 2);
      expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(lateSeq || answerSeq);
      expect(h.store.getTurn(h.offer.turn_id)?.status).toBe("completed");
      expect(h.store.getMessage(h.store.getTurn(h.offer.turn_id)!.reply_message_id!)?.body_md)
        .toBe(scenario === "late_interrupt" ? "Both directives handled" : "Ordinary context handled");
    } finally { await drain(); await h.close(); rmSync(workDir, { recursive: true, force: true }); }
  }, 120_000);

  it("range receipts allow omitted read IDs but reject foreign, duplicate and reordered IDs", async () => {
    const h = await setup(fixture());
    try {
      const first = h.send("First HTTP-only input", "next_turn");
      const second = h.send("Second HTTP-only input", "next_turn");
      const offer = h.store.getDaemonTurnBridge().offerInput(h.store.getTaskWithAgent(h.attempt.id)!);
      const input = { ...h.inbox.turnInput(h.attempt.id), input_to_seq: offer.input_to_seq };
      await expect(h.inbox.rpc("turn.input", { ...input, message_ids: [] })).rejects.toMatchObject({ code: "input_gap" });
      expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(h.offer.input_to_seq);
      await h.readRange(h.offer.input_to_seq, offer.input_to_seq);
      for (const ids of [["foreign"], [first.message.id, first.message.id], [second.message.id, first.message.id]]) {
        await expect(h.inbox.rpc("turn.input", { ...input, message_ids: ids })).rejects.toMatchObject({ code: "input_gap" });
        expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(h.offer.input_to_seq);
      }
      expect(await h.inbox.rpc("turn.input", { ...input, message_ids: [] })).toMatchObject({ ok: true, input_to_seq: offer.input_to_seq });
    } finally { await h.close(); }
  }, 120_000);

  it("delivers, downloads and injects a mid-run attachment under the current attempt", async () => {
    useUploadDir();
    const workDir = mkdtempSync(join(tmpdir(), "turn-attachment-"));
    const h = await setup(fixture());
    try {
      const form = new FormData();
      const bytes = Buffer.from("current attempt attachment");
      form.append("file", new File([bytes], "probe.png", { type: "image/png" }));
      form.append("issue_id", h.issue.id);
      const uploaded = await fetch(`${h.serverUrl}/api/upload-file`, { method: "POST", headers: { Authorization: "Bearer callback-fixture" }, body: form });
      expect(uploaded.status).toBe(200);
      const { attachment } = await uploaded.json() as { attachment: { id: string } };
      const sent = h.send("Inspect attachment", "now", [attachment.id]);
      await until(() => h.inbox.pendingTaskSteerMessages(h.attempt.id).some(m => m.id === sent.message.id));
      const received = h.inbox.pendingTaskSteerMessages(h.attempt.id).find(m => m.id === sent.message.id)!;
      expect(received.taskId).toBe(h.attempt.id);
      expect(h.feed.take()).toEqual([received]);
      expect(received.attachments?.map(a => a.id)).toEqual([attachment.id]);
      const token = (await h.store.createTaskAccessToken(h.attempt, "local")).token;
      const downloader = new MultiremiDaemonClient(h.serverUrl, "callback-fixture");
      const prepared = await materializeTaskSteerAttachments([received], workDir, h.attempt.id,
        id => downloader.downloadTaskAttachment(id, token));
      const local = prepared[0]!.localAttachments![0] as { localPath: string };
      expect(local.localPath).toStartWith(workDir);
      expect(readFileSync(local.localPath)).toEqual(bytes);
      expect(buildSteerInjectionPrompt(prepared)).toContain(local.localPath);
      await h.inbox.consumeTaskSteerMessages(h.attempt.id, [received.id]);
      expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(sent.message.seq);
    } finally { await h.close(); rmSync(workDir, { recursive: true, force: true }); }
  }, 120_000);
});
