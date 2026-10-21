/**
 * A Chat turn finishing on the runtime process reaches a browser on the ui
 * process, the production split (ADR 0009): the reply row, the terminal turn
 * card and `chat:done` are written in one transaction on the runtime process
 * and cross to the ui process over the peer channel.
 *
 * The browser reads its window over HTTP first and subscribes after the
 * window's head, as the web client does. A running Chat card is hidden and not
 * in that window, so the ui hub never delivered it to this subscriber; the card
 * re-emitted at its old position when the turn ends must still reach it, and
 * not only through the client's pending-task poll.
 *
 * Real daemon, runtime API in this process, ui API in its own OS process, one
 * shared database (SQLite file, or PostgreSQL with MULTIREMI_TEST_POSTGRES_URL).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createPeerChannel, type PeerFetch } from "../../../packages/server/src/api/peer/peer-channel.js";
import { authenticateBrowserWebSocket } from "../../unit/multiremi/helpers.js";
import { DaemonProtocolHarness, startUiProcess, waitFor } from "./harness.js";

/** Commit on the runtime process to the browser frame on the ui process; generous for shared runners. */
const SPLIT_DELIVERY_BOUND_MS = 2_000;

const harnesses: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.dispose(); });

describe("split ui/runtime: a finished Chat turn reaches a browser on the ui process", () => {
  it("delivers the terminal card to a subscriber that started past its hidden marker, with chat:done", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
    let uiPort: number | null = null;
    const secret = "split-chat-turn-delivery";
    const peer = createPeerChannel({
      url: "http://127.0.0.1:0", secret, origin: "split-chat-runtime-process", minBackoffMs: 20, maxBackoffMs: 100,
      fetchImpl: ((url: string, init: RequestInit) => uiPort === null
        ? Promise.reject(new Error("ui peer not ready")) : fetch(url.replace(":0", `:${uiPort}`), init)) as PeerFetch,
    });
    const h = await DaemonProtocolHarness.create({
      apiRole: "runtime", peerChannel: peer, peerSecret: secret,
      daemonOptions: { providerFactory: () => ({
        async *sendStream() {
          await providerGate;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "split reply" }] } as any;
        },
        getLastResponse: () => ({ text: "split reply", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }) },
    });
    harnesses.push(h);
    if (h.db.dialect === "sqlite") { h.db.exec("PRAGMA journal_mode = WAL"); h.db.exec("PRAGMA busy_timeout = 5000"); }
    let ui: Awaited<ReturnType<typeof startUiProcess>> | null = null;
    let socket: WebSocket | null = null;
    const events: { at: number; event: any }[] = [];
    let stage = "daemon startup";
    try {
      await h.startDaemon();
      await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
      const user = h.store.getOrCreateUser({ externalId: "split-chat-user", name: "Chat user" });
      h.store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
      const pat = await h.store.createAccessToken({ type: "pat", name: "Chat user", userId: user.id, workspaceId: "local" });
      const agent = h.store.createAgent({ name: "Split chat agent", provider: "claude", workspaceId: "local", runtimeId, visibility: "workspace" });
      const chat = h.store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: user.id });
      await h.layer.drain();
      stage = "ui startup";
      ui = await startUiProcess(h.databaseSource, h.server.port!, secret);
      uiPort = ui.port;
      const uiUrl = `http://127.0.0.1:${ui.port}`;
      const headers = { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" };

      stage = "send on the ui process";
      const sent = await fetch(`${uiUrl}/api/sessions/${chat.id}/messages`, { method: "POST", headers,
        body: JSON.stringify({ body_md: "hello", message_kind: "request", to: { type: "agent", ref: agent.id }, wake_requested: "now" }) });
      const sentBody = await sent.json() as { turn_id: string };
      expect(sent.status, JSON.stringify(sentBody)).toBe(200);
      const turn = h.store.getTurn(sentBody.turn_id)!;
      const cardSeq = Number(turn.seq);
      const attemptId = () => h.store.getTurn(sentBody.turn_id)?.current_attempt_id ?? null;
      await waitFor(() => !!attemptId() && h.store.getTask(attemptId()!)?.status === "running", "running chat turn", 10_000);

      stage = "browser window and subscription";
      const window = await (await fetch(`${uiUrl}/api/sessions/${chat.id}/log`, { headers })).json() as {
        head_seq: number; entries: { seq: number }[];
      };
      // The running card is hidden: its position is passed but it is not in the window.
      expect(window.head_seq).toBeGreaterThanOrEqual(cardSeq);
      expect(window.entries.some(entry => entry.seq === cardSeq)).toBe(false);
      socket = new WebSocket(`ws://127.0.0.1:${ui.port}/ws?workspace_id=local`);
      socket.addEventListener("message", event => events.push({ at: performance.now(), event: JSON.parse(String(event.data)) }));
      await authenticateBrowserWebSocket(socket, pat.token);
      socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id: chat.id, from_seq: window.head_seq + 1 } }));
      await waitFor(() => events.some(({ event }) => event.type === "stream.ack"), "stream ack", 5_000);

      stage = "turn completion";
      releaseProvider();
      await waitFor(() => h.store.getTask(attemptId()!)?.status === "completed", "completed chat turn", 10_000);
      const completedAt = performance.now();
      const frames = () => events.filter(({ event }) => event.type === "stream.data")
        .flatMap(({ at, event }) => event.payload.frames.map((frame: any) => ({ at, frame })));
      const reply = h.store.listChatMessages(chat.id).find(message => message.taskId === attemptId() && message.role === "assistant")!;
      const card = () => frames().find(({ frame }) => frame.seq === cardSeq && frame.payload.visibility === "shown");
      const done = () => events.find(({ event }) => event.type === "chat:done" && event.payload.task_id === attemptId());

      stage = "terminal card";
      await waitFor(() => !!card(), "terminal turn card on the ui socket", SPLIT_DELIVERY_BOUND_MS);
      expect(card()!.frame).toMatchObject({ kind: "entry", payload: { kind: "turn", id: sentBody.turn_id,
        metadata: { status: "completed", final_entry_id: reply.id } } });
      // Delivered as the row itself, not a reread request.
      expect(events.filter(({ event }) => event.type === "stream.gap")).toEqual([]);

      stage = "chat:done";
      await waitFor(() => !!done(), "chat:done on the ui socket", SPLIT_DELIVERY_BOUND_MS);
      expect(done()!.event.payload).toMatchObject({ chat_session_id: chat.id, message_id: reply.id });
      await waitFor(() => events.some(({ event }) => event.type === "task:completed" && event.payload.task_id === attemptId()),
        "task:completed on the ui socket", SPLIT_DELIVERY_BOUND_MS);
      expect(frames().some(({ frame }) => frame.payload.id === reply.id)).toBe(true);
      expect(Math.max(card()!.at, done()!.at) - completedAt).toBeLessThan(SPLIT_DELIVERY_BOUND_MS);
      // The ui process reports the cross-process chat:done and the socket it reached.
      await waitFor(() => /peer chat:done delivered[\s\S]*sockets: 1/.test(ui!.logs()), "ui chat:done diagnostic", SPLIT_DELIVERY_BOUND_MS);
      expect(ui.logs()).toContain(`task_id: "${attemptId()}"`);
      expect(h.errors).toEqual([]);
    } catch (error) {
      console.error(`split delivery stage=${stage} events=${JSON.stringify(events.map(({ event }) => [event.type,
        event.payload?.frames?.map((frame: any) => [frame.seq, frame.payload?.visibility]) ?? event.payload?.task_id ?? null]))}`);
      if (ui) console.error(`ui logs:\n${ui.logs().slice(-4_000)}`);
      throw error;
    } finally {
      releaseProvider();
      socket?.close();
      await h.stopDaemon();
      await h.layer.drain();
      if (ui) await ui.close();
    }
  }, 45_000);
});
