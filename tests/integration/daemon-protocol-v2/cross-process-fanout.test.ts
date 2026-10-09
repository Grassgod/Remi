import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { createPeerChannel, type PeerFetch } from "../../../packages/server/src/api/peer/peer-channel.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";

interface UiReply {
  ready?: boolean;
  op?: string;
  port?: number;
  taskId?: string;
  requestId?: string;
  steerId?: string;
  daemonHookCalls?: number;
  daemonSessions?: number;
  stopped?: boolean;
  error?: string;
}

async function startUiProcess(databasePath: string, runtimePort: number, secret: string) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../../fixtures/daemon-protocol-v2/ui-process.ts"),
    databasePath, String(runtimePort), secret], {
    cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env },
  });
  const queued: UiReply[] = [];
  const waiting: Array<(reply: UiReply) => void> = [];
  let output = "";
  const reader = child.stdout.getReader();
  const readLoop = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      output += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (!line.startsWith("MUL419 ")) continue;
        const reply = JSON.parse(line.slice(7)) as UiReply;
        const resolve = waiting.shift();
        if (resolve) resolve(reply); else queued.push(reply);
      }
    }
  })();
  const next = async (): Promise<UiReply> => {
    if (queued.length) return queued.shift()!;
    return await Promise.race([
      new Promise<UiReply>(resolve => waiting.push(resolve)),
      Bun.sleep(10_000).then(() => { throw new Error("ui process control response timed out"); }),
    ]);
  };
  const ready = await next();
  if (!ready.ready || !ready.port) throw new Error(`ui process did not start: ${ready.error ?? "no ready frame"}`);
  return {
    port: ready.port,
    async command(command: { op: string; runtimeId?: string; taskId?: string; agentId?: string;
      issueId?: string; requestId?: string; humanToken?: string; status?: "timeout" | "cancelled" }): Promise<UiReply> {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      await child.stdin.flush();
      const reply = await next();
      if (reply.error) throw new Error(`ui process ${command.op}: ${reply.error}`);
      expect(reply.op).toBe(command.op);
      return reply;
    },
    async close(): Promise<void> {
      if (!child.killed) {
        try {
          await this.command({ op: "stop" });
        }
        catch { child.kill(); }
      }
      child.stdin.end();
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
      if (!exited) child.kill();
      await child.exited;
      await readLoop;
    },
  };
}

const harnesses: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.dispose(); });

describe("MUL-419 ui to runtime fanout across OS processes", () => {
  for (const status of ["responded", "timeout", "cancelled"] as const) {
  it(`shares a UI-${status} decision message with its executor and Feishu card host`, async () => {
    const oldKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    const oldPublicUrl = process.env.MULTIREMI_PUBLIC_URL;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    process.env.MULTIREMI_PUBLIC_URL = "https://remi.example.com";
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    let uiPort: number | null = null;
    const secret = "mul401-settled-peer-fixture";
    const peer = createPeerChannel({ url: "http://127.0.0.1:0", secret, origin: "mul401-runtime-process",
      minBackoffMs: 20, maxBackoffMs: 100,
      fetchImpl: ((url: string, init: RequestInit) => uiPort === null
        ? Promise.reject(new Error("ui peer not ready")) : fetch(url.replace(":0", `:${uiPort}`), init)) as PeerFetch });
    const h = await DaemonProtocolHarness.create({ apiRole: "runtime", peerChannel: peer, peerSecret: secret,
      daemonOptions: { providerFactory: () => ({
        async *sendStream() { await providerGate;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "fixture" }] } as any; },
        getLastResponse: () => ({ text: "fixture", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }) } });
    harnesses.push(h);
    if (h.db.dialect === "sqlite") { h.db.exec("PRAGMA journal_mode = WAL"); h.db.exec("PRAGMA busy_timeout = 5000"); }
    let ui: Awaited<ReturnType<typeof startUiProcess>> | null = null;
    let host: WebSocket | null = null;
    let decisionTaskId: string | undefined;
    try {
      await h.startDaemon(); await h.settleHeartbeat();
      const executorId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
      const agent = h.store.createAgent({ name: "Decision executor", provider: "claude",
        workspaceId: "local" });
      h.store.registerRuntime({ id: "rt_bot_host", name: "Bot host", provider: "claude",
        workspaceId: "local", daemonId: "dmn_bot_host" });
      h.store.heartbeatRuntime("rt_bot_host", { supportsFeishuBotConfig: true, supportsDecisionCard: true });
      const config = h.store.upsertFeishuBotConfig("local", { agentId: agent.id,
        runtimeId: "rt_bot_host", appId: "mul401_settled", appSecretOp: "set", appSecret: "fixture-secret",
        domain: "feishu", enabled: true });
      h.store.reportFeishuBotRuntimeStatus("local", "rt_bot_host",
        { appliedRevision: config.revision, state: "online" });
      const workspace = h.store.getWorkspace("local")!;
      h.store.updateWorkspace("local", { settings: { ...workspace.settings,
        issueTopics: { enabled: true, chatId: "oc_settled", notifyMode: "person", notifyOpenId: "ou_recipient" } } });
      const issue = createResponsibleTestIssue(h.store, { title: "Settle", workspaceId: "local",
        assigneeType: "agent", assigneeId: agent.id, responsibleMemberId: 'mem_local_local' });
      const recipient = h.store.getOrCreateUser({ externalId: 'ou_recipient', name: 'Explicit question recipient' });
      h.db.run('UPDATE multiremi_workspace_members SET user_id=? WHERE id=?', [recipient.id, 'mem_local_local']);
      h.db.run('UPDATE multiremi_users SET feishu_union_id=? WHERE id=?', ['on_recipient', recipient.id]);
      const humanAccess = await h.store.createAccessToken({ name: 'Designated question human', type: 'pat', userId: recipient.id, workspaceId: 'local' });
      const seen = new Date().toISOString();
      h.db.run("INSERT INTO multiremi_feishu_bot_senders(id,workspace_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at) VALUES('fbs_cross_process','local','mul401_settled','ou_recipient','on_recipient','Human',1,?,?)", [seen, seen]);
      h.store.prepareFeishuIssueTopicWithinTransaction(issue);
      const root = h.store.claimFeishuBotOutbound("local", "rt_bot_host")!;
      h.store.reportFeishuBotOutbound("local", "rt_bot_host", root.id,
        { claimToken: root.claimToken, status: "sent", externalMessageId: "om_settled_root" });
      const token = await h.store.createAccessToken({ name: "bot-host", type: "daemon",
        workspaceId: "local", daemonId: "dmn_bot_host" });
      await h.layer.drain();
      ui = await startUiProcess(h.databaseSource, h.server.port!, secret);
      uiPort = ui.port;
      const taskId = (await ui.command({ op: "create_task", agentId: agent.id, issueId: issue.id,
        runtimeId: executorId })).taskId!;
      decisionTaskId = taskId;
      await waitFor(() => h.store.getTask(taskId)?.status === "running", "running decision task", 10_000);
      (h.daemon as any).taskDownlinks.beginDecision(taskId);
      (h.daemon as any).taskDownlinks.beginQuestionWait(taskId, `cross-process-question:${taskId}`, `cross-process-wait:${taskId}`);
      const requestId = (await ui.command({ op: "create_human_request", taskId })).requestId!;
      (h.daemon as any).taskDownlinks.registerDecision(h.store.getMessage(requestId)!, taskId);
      const card = h.store.claimFeishuBotOutbound("local", "rt_bot_host")!;
      expect(card.kind).toBe("decision_card");
      expect(card.degraded).toBeUndefined();
      expect(h.store.getMessage(requestId)?.card_token_recipient).toBe('ou_recipient');
      h.store.reportFeishuBotOutbound("local", "rt_bot_host", card.id, {
        claimToken: card.claimToken, status: "sent", externalMessageId: "om_settled_card",
        interactionOpenId: "ou_recipient" });
      const hostFrames: Record<string, any>[] = [];
      host = new WebSocket(`${h.url.replace("http:", "ws:")}/api/daemon/ws?protocol=2`,
        { headers: { Authorization: `Bearer ${token.token}` } } as never);
      host.addEventListener("message", event => hostFrames.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => { host!.addEventListener("open", () => resolve(), { once: true });
        host!.addEventListener("error", reject, { once: true }); });
      host.send(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: "dmn_bot_host",
        cli_version: DAEMON_MIN_CLI_VERSION, caps: [], runtimes: [{ runtime_id: "rt_bot_host",
          provider: "claude", max_concurrency: 1, active_task_ids: [], capabilities: { feishu_decision_card: 1, feishu_concierge_protocol: 1 } }] } }));
      await waitFor(() => hostFrames.some(frame => frame.t === "welcome"), "bot host welcome");
      expect(hostFrames.filter(frame => frame.t === "task.human_request.settled")).toHaveLength(0);
      if (status !== "responded") await new Promise<void>(resolve => {
        host!.addEventListener("close", () => resolve(), { once: true }); host!.close(); });
      await h.settleHeartbeat();
      await h.layer.drain();
      const claims = spyOn(h.store, "claimTask");
      const started = performance.now();
      expect((await ui.command(status === "responded" ? { op: "respond_human_request", requestId, humanToken: humanAccess.token }
        : { op: "expire_human_request", requestId, status })).requestId).toBe(requestId);
      if (status === "responded") await waitFor(() => h.received.some(frame => frame.t === "turn.message"
        && frame.p.message.reply_to_id === requestId), "decision reply message", 200);
      expect(performance.now() - started).toBeLessThan(200);
      expect(claims).not.toHaveBeenCalled();
      claims.mockRestore();
      expect(h.received.filter(frame => frame.t === "turn.message" && frame.p.message.reply_to_id === requestId))
        .toHaveLength(status === "responded" ? 1 : 0);
      const read = await fetch(`${h.url}/api/daemon/messages/${requestId}`, { headers: { Authorization: `Bearer ${token.token}` } });
      expect(read.status).toBe(200);
      expect((await read.json() as any).request).toMatchObject({ id: requestId, status: status === 'responded' ? 'responded' : 'pending' });
      if (status !== 'responded') expect(h.store.getQuestion(requestId)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: status });
      expect(hostFrames.filter(frame => frame.t === "turn.message")).toHaveLength(0);
      expect(h.received.filter(frame => frame.t === "task.human_request.settled")).toHaveLength(0);
      expect((await ui.command({ op: "stats" })).daemonHookCalls).toBe(0);

      if (status === "responded") await new Promise<void>(resolve => {
        host!.addEventListener("close", () => resolve(), { once: true }); host!.close(); });
      if (status === 'responded') {
        expect(h.store.listFeishuBotLiveDecisionCards("local", "rt_bot_host")).toEqual([]);
        expect(h.store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot_host"))
          .toContainEqual({ requestId, taskId });
      } else {
        expect(h.store.listFeishuBotLiveDecisionCards("local", "rt_bot_host")).toHaveLength(1);
        expect(h.store.listFeishuBotSettledHumanRequestCandidates("local", "rt_bot_host"))
          .not.toContainEqual({ requestId, taskId });
      }
      const recoveredFrames: Record<string, any>[] = [];
      host = new WebSocket(`${h.url.replace("http:", "ws:")}/api/daemon/ws?protocol=2`,
        { headers: { Authorization: `Bearer ${token.token}` } } as never);
      host.addEventListener("message", event => recoveredFrames.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => { host!.addEventListener("open", () => resolve(), { once: true });
        host!.addEventListener("error", reject, { once: true }); });
      host.send(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: "dmn_bot_host",
        cli_version: DAEMON_MIN_CLI_VERSION, caps: [], runtimes: [{ runtime_id: "rt_bot_host",
          provider: "claude", max_concurrency: 1, active_task_ids: [], capabilities: { feishu_decision_card: 1, feishu_concierge_protocol: 1 } }] } }));
      await waitFor(() => recoveredFrames.some(frame => frame.t === "welcome"), "bot host reconnect");
      const recovered = await fetch(`${h.url}/api/daemon/messages/${requestId}`, { headers: { Authorization: `Bearer ${token.token}` } });
      expect(recovered.status).toBe(200);
      expect((await recovered.json() as any).request).toMatchObject({ id: requestId, status: status === 'responded' ? 'responded' : 'pending' });
      expect(recoveredFrames.filter(frame => frame.t === "task.human_request.settled" || frame.t === "turn.message")).toHaveLength(0);
    } finally {
      if (decisionTaskId) (h.daemon as any).taskDownlinks.finishDecision(decisionTaskId);
      releaseProvider();
      if (host && host.readyState !== WebSocket.CLOSED) await new Promise<void>(resolve => {
        host!.addEventListener("close", () => resolve(), { once: true }); host!.close(); });
      await h.stopDaemon(); await h.layer.drain();
      if (ui) await ui.close();
      if (oldKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = oldKey;
      if (oldPublicUrl === undefined) delete process.env.MULTIREMI_PUBLIC_URL;
      else process.env.MULTIREMI_PUBLIC_URL = oldPublicUrl;
    }
  }, 45_000);
  }

  it("offers a ui-created task and pushes a command and steer only from runtime", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    let uiPort: number | null = null;
    const secret = "mul419-local-peer-fixture";
    const peer = createPeerChannel({
      url: "http://127.0.0.1:0", secret, origin: "mul419-runtime-process",
      minBackoffMs: 20, maxBackoffMs: 100,
      fetchImpl: ((url: string, init: RequestInit) => {
        if (uiPort === null) return Promise.reject(new Error("ui peer not ready"));
        return fetch(url.replace(":0", `:${uiPort}`), init);
      }) as PeerFetch,
    });
    const h = await DaemonProtocolHarness.create({
      apiRole: "runtime", peerChannel: peer, peerSecret: secret,
      daemonOptions: { providerFactory: () => ({
        async *sendStream() {
          await providerGate;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "fixture" }] } as any;
        },
        getLastResponse: () => ({ text: "fixture", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }) },
    });
    harnesses.push(h);
    if (h.db.dialect === "sqlite") { h.db.exec("PRAGMA journal_mode = WAL"); h.db.exec("PRAGMA busy_timeout = 5000"); }
    let ui: Awaited<ReturnType<typeof startUiProcess>> | null = null;
    let stage = "daemon startup";
    try {
      await h.startDaemon();
      await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
      const agent = h.store.createAgent({ name: "Cross-process agent", provider: "claude",
        workspaceId: "local", runtimeId });
      await h.layer.drain();
      stage = "ui startup";
      ui = await startUiProcess(h.databaseSource, h.server.port!, secret);
      uiPort = ui.port;
      stage = "task offer";
      const taskId = (await ui.command({ op: "create_task", agentId: agent.id })).taskId!;
      await waitFor(() => h.received.some(frame => frame.t === "task.offer" && frame.p.attempt_id === taskId),
        "peer-delivered offer", 10_000);
      await waitFor(() => h.store.getTask(taskId)?.status === "running", "running task", 10_000);

      stage = "command and steer";
      const requestId = (await ui.command({ op: "create_command", runtimeId })).requestId!;
      const steerId = (await ui.command({ op: "create_steer", taskId })).steerId!;
      stage = "command frame";
      await waitFor(() => h.received.some(frame => frame.t === "runtime.command" && frame.p.id === requestId),
        "peer-delivered runtime command", 10_000);
      stage = "steer frame";
      await waitFor(() => h.received.some(frame => frame.t === "turn.message" && frame.p.message.id === steerId),
        "peer-delivered steer", 10_000);

      const stats = await ui.command({ op: "stats" });
      expect(stats).toMatchObject({ daemonHookCalls: 0, daemonSessions: 0 });
      const refused = await fetch(`http://127.0.0.1:${ui.port}/api/daemon/ws?protocol=2`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13" },
      });
      expect(refused.status).toBe(421);
      expect(await refused.json()).toEqual({ error: "misdirected", role: "ui" });

      releaseProvider();
      await waitFor(() => h.store.getTask(taskId)?.status === "completed", "completed task", 10_000);
      expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === taskId)).toHaveLength(1);
      expect(h.errors).toEqual([]);
    } catch (error) {
      console.error(`cross-process stage=${stage} frames=${h.received.map(frame => frame.t).join(",")}`);
      throw error;
    } finally {
      releaseProvider();
      await h.stopDaemon();
      await h.layer.drain();
      if (ui) await ui.close();
    }
  }, 45_000);
});
