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
async function setup({ store }: PendingTurnTestFixture) {
  const rt = "rt_decision_callback", daemonId = "daemon_decision_callback";
  store.registerRuntime({ id: rt, daemonId, name: rt, provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "Callback", provider: "claude", runtimeId: rt });
  const issue = store.createIssue({ title: "Callback", assigneeType: "agent", assigneeId: agent.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const send = (body_md: string, wake_requested: "now" | "next_turn" = "now", attachment_ids?: string[]) =>
    store.sendMessage({ session_id: session.id, sender: { type: "member", id: "mem_local_local" },
      to: { type: "agent", ref: agent.id }, message_kind: "request", wake_requested, body_md, attachment_ids });
  send("Start");
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
    runtime: () => ({ runtime_id: rt, provider: "claude", max_concurrency: 1, active_task_ids: [attempt.id] }),
    heartbeat: () => ({ active_task_count: 1 }), onHeartbeatAck: async () => {}, probeUpgrade: async () => {},
    onTerminal: async () => {}, onStateChange: () => inbox.connectionChanged(),
    onConnected: () => { client.send({ t: "runtime.ready", rt, p: { active_task_ids: [attempt.id] } }); },
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
  expect((await inbox.rpc("turn.input", { ...inbox.turnInput(attempt.id), message_ids: offer.input_messages.map(m => m.id) })).ok).toBe(true);
  const { token } = await store.createTaskAccessToken(attempt, "local");
  return { store, rt, agent, issue, session, attempt, offer, send, frames, inbox, feed, permission, question,
    serverUrl: `http://127.0.0.1:${server.port}`,
    async readRange(from: number, to: number) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/log/entry?from=${from}&to=${to}`,
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
      const answer = h.store.answerMessageDecision(decision.id, { sender: { type: "member", id: "mem_local_local" }, body_md: optionId });
      expect(await result).toEqual(optionId === "unknown" ? { outcome: "cancelled" } : { outcome: "selected", optionId });
      expect(h.inbox.pendingTaskSteerMessages(h.attempt.id)).toEqual([]);
      await h.inbox.consumeTaskSteerMessages(h.attempt.id, []);
      expect(h.store.getTurn(h.offer.turn_id)?.input_to_seq).toBe(answer.message.seq);
    } finally { await h.close(); }
  }, 120_000);

  for (const kind of ["text", "option", "multi_text_keys", "multi_field_keys", "long_text", "unread_context", "invalid_multi"] as const) {
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
          : kind === "invalid_multi" ? JSON.stringify({ answers: { unknown: "invalid" } })
          : kind === "long_text" ? "Paris".repeat(2000) : "Paris";
        const answer = h.store.answerMessageDecision(decision.id, { sender: { type: "member", id: "mem_local_local" }, body_md: body });
        expect(await result).toEqual(kind === "invalid_multi" ? { action: "cancel" } : { action: "accept",
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
          expect(range.find(m => m.id === answer.message.id)?.body_md).toBe(body);
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
            { sender: { type: "member", id: "mem_local_local" }, body_md: "allow" }).message.seq;
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
            expect(range.some(m => m.body_md === "allow")).toBe(true);
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
      workspacesRoot: workDir, gcEnabled: false, sshMeshManager: disabledSshMeshRuntime(), providerFactory: () => provider });
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
