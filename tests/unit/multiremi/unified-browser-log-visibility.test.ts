import { expect, it } from "bun:test";
import { startMultiremiServer } from "@multiremi/api.js";
import { createReadPool } from "@multiremi/store/db/read-pool.js";
import { createHub } from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { createConversationLogFillReader } from "@multiremi/api/hub/conversation-log-fill-reader.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { authenticateBrowserWebSocket } from "./helpers.js";

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

pendingTurnBackendTests("MUL-508 browser log source visibility", fixture => {
  async function scaffold(shared = false) {
    const { store, db, databaseUrl } = fixture();
    const user = store.getOrCreateUser({ externalId: "ws-member", name: "Member" });
    store.createWorkspaceMember({ userId: user.id, name: user.name, role: "member" });
    const sourceOwner = store.getOrCreateUser({ externalId: "ws-source-owner", name: "Source owner" });
    store.createWorkspaceMember({ userId: sourceOwner.id, name: sourceOwner.name, role: "member" });
    const agent = store.createAgent({ name: "Source", provider: "codex", visibility: shared ? "workspace" : "private", ownerId: sourceOwner.id });
    const issue = store.createIssue({ title: "Browser visibility", assigneeType: "agent", assigneeId: agent.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const member = await store.createAccessToken({ type: "pat", name: "Member", userId: user.id, workspaceId: "local" });
    const owner = await store.createAccessToken({ type: "pat", name: "Source owner", userId: sourceOwner.id, workspaceId: "local" });
    const pool = createReadPool({ databaseUrl, sqliteDb: db });
    const hub = createHub({ transport: createLocalHubTransport(), fill: createConversationLogFillReader(store, pool) });
    const sockets: WebSocket[] = [];
    let server: ReturnType<typeof startMultiremiServer> | undefined;
    let detach: (() => void) | undefined;
    function question(kind: "permission" | "question") {
      const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Public request" });
      hub.flushNow();
      db.run("UPDATE multiremi_turns SET status='running',legacy_prompt='Private turn prompt' WHERE current_attempt_id=?", [task.id]);
      db.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?", [task.id]);
      const request = store.createTaskHumanRequest({ taskId: task.id, kind, payload: kind === "permission"
        ? { title: "Private request payload", options: [{ optionId: "allow_once", kind: "allow_once", name: "Allow" }] }
        : { title: "Private request payload", questions: [{ question: "Continue?" }] } });
      hub.flushNow();
      store.issueMessageCardToken(request.id, "open_owner");
      const turn = store.getTurnForAttempt(task.id)!;
      return { task, request, turn, row: store.getConversationLogEntryById(request.id)! };
    }
    function start() {
      detach = store.subscribeConversationLog({ onEntry: (id, row) => {
        hub.onEntry(id, "target_seq" in row ? { ...row, session_id: id } : row);
        hub.flushNow();
      } });
      server = startMultiremiServer({ store, liveHub: hub, readPool: pool, authToken: null, scheduler: null, port: 0, hostname: "127.0.0.1" });
    }
    async function connect(auth: string) {
      const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/ws?workspace_id=local`);
      sockets.push(socket);
      const events: any[] = [];
      socket.addEventListener("message", event => events.push(JSON.parse(String(event.data))));
      await authenticateBrowserWebSocket(socket, auth);
      const frames = () => events.filter(event => event.type === "stream.data").flatMap(event => event.payload.frames);
      const subscribe = async (from = 0) => {
        const before = events.filter(event => event.type === "stream.ack").length;
        socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "log", id: session.id, from_seq: from } }));
        await waitFor(() => events.filter(event => event.type === "stream.ack").length > before, "stream ack");
      };
      const through = async (seq: number) => {
        try { await waitFor(() => frames().some(frame => frame.seq === seq), `log seq ${seq}`); }
        catch {
          throw new Error(JSON.stringify({ missing_seq: seq, events: events.map(event => ({ type: event.type,
            code: event.payload?.code, from: event.payload?.from, to: event.payload?.to,
            seqs: event.payload?.frames?.map((frame: any) => frame.seq) })) }));
        }
      };
      return { socket, events, frames, subscribe, through };
    }
    async function close() {
      for (const socket of sockets) socket.close();
      server?.stop(true);
      detach?.();
      hub.shutdown();
      await pool.close();
    }
    return { store, db, agent, session, member, owner, hub, question, start, connect, close };
  }
  function noCredentials(value: unknown) {
    if (Array.isArray(value)) { value.forEach(noCredentials); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      expect(key.startsWith("card_token_")).toBe(false);
      noCredentials(nested);
    }
  }
  function privateRowsHidden(frames: any[], ids: string[]) {
    const text = JSON.stringify(frames);
    for (const id of ids) expect(frames.some(frame => frame.payload.id === id || frame.payload.task_id === id)).toBe(false);
    expect(text).not.toContain("Private turn prompt");
    expect(text).not.toContain("Private request payload");
    expect(text).not.toContain("Private updated body");
    noCredentials(frames);
  }

  for (const kind of ["permission", "question"] as const) it(`cold replay hides private ${kind} and turn; owner sees credential-free rows`, async () => {
    const f = await scaffold();
    try {
      const q = f.question(kind);
      expect(f.store.getMessage(q.request.id)?.card_token_hash).toBeTruthy();
      f.start();
      const member = await f.connect(f.member.token), owner = await f.connect(f.owner.token);
      await member.subscribe(); await owner.subscribe();
      const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
      await member.through(head); await owner.through(head);
      privateRowsHidden(member.frames(), [q.request.id, q.turn.id, q.task.id]);
      expect(member.frames().find(frame => frame.seq === q.row.seq)?.payload).toEqual({
        session_id: f.session.id, seq: q.row.seq, revision: q.row.revision, visibility: "hidden",
      });
      const rows = owner.frames().map(frame => frame.payload);
      expect(rows.find(row => row.id === q.request.id)?.metadata.human_request.kind).toBe(kind);
      expect(rows.find(row => row.id === q.turn.id)?.metadata.status).toBe("awaiting_human");
      noCredentials(owner.frames());
      expect(member.events[1]?.type).toBe("stream.ack");
      expect(member.frames().map(frame => frame.seq)).toEqual(Array.from({ length: head + 1 }, (_, seq) => seq));
    } finally { await f.close(); }
  });

  for (const via of ["live", "peer fill"] as const) it(`${via} filters entries, turn patches, response and edit markers per recipient`, async () => {
    const f = await scaffold();
    try {
      f.start();
      const member = await f.connect(f.member.token), owner = await f.connect(f.owner.token);
      await member.subscribe(); await owner.subscribe();
      await member.through(0); await owner.through(0);
      const original = f.hub.onEntry.bind(f.hub);
      if (via === "peer fill") f.hub.onEntry = () => {};
      const q = f.question("permission");
      f.hub.onEntry = original;
      const head = f.store.getConversationLogHead(f.session.id)!.headSeq;
      if (via === "peer fill") await f.hub.applyRemoteHead(`log:${f.session.id}`, head);
      f.hub.flushNow();
      await member.through(head); await owner.through(head);
      privateRowsHidden(member.frames(), [q.request.id, q.turn.id, q.task.id]);
      expect(owner.frames().some(frame => frame.payload.id === q.request.id)).toBe(true);
      const version = q.row.revision + 1;
      fixture().transaction(() => f.store.updateConversationLogWithinTransaction(f.session.id, q.row.seq, {
        fields: { body_md: "Private updated body", metadata: { ...q.row.metadata, card_token_future: "fixture", nested: { card_token_hash: "fixture" } } },
      }));
      f.hub.flushNow();
      await waitFor(() => owner.frames().some(frame => frame.kind === "patch" && frame.seq === q.row.seq && frame.payload.revision === version), "authorized patch");
      await waitFor(() => member.frames().some(frame => frame.seq === q.row.seq && frame.payload.revision === version), "redacted patch marker");
      const edited = f.store.appendConversationLog({ sessionId: f.session.id, kind: "message_edited", authorType: "system",
        metadata: { target_seq: q.row.seq, previous_body: "Private request payload", body: "Private updated body" } });
      await member.through(edited.seq); await owner.through(edited.seq);
      expect(member.frames().find(frame => frame.seq === edited.seq)?.payload.visibility).toBe("hidden");
      const reply = f.store.sendMessage({ session_id: f.session.id, sender: { type: "member", id: "mem_local_local" },
        to: { type: "none" }, reply_to_id: q.request.id, body_md: "Private response", metadata: { human_response: { option_id: "allow_once" } }, wake_requested: "inbox_only" }).message;
      await member.through(reply.seq); await owner.through(reply.seq);
      privateRowsHidden(member.frames(), [q.request.id, q.turn.id, q.task.id, reply.id]);
      expect(JSON.stringify(member.frames())).not.toContain("Private response");
      expect(owner.frames().some(frame => frame.payload.id === reply.id)).toBe(true);
      noCredentials(owner.frames());
      expect(member.events.filter(event => event.type.startsWith("task:")).length).toBe(0);
      expect(owner.events.some(event => event.type.startsWith("task:"))).toBe(true);
    } finally { await f.close(); }
  });

  it("shared sources remain visible and a permission change is applied to retained replay", async () => {
    const f = await scaffold(true);
    try {
      const q = f.question("question"); f.start();
      const member = await f.connect(f.member.token);
      await member.subscribe(); await member.through(f.store.getConversationLogHead(f.session.id)!.headSeq);
      expect(member.frames().some(frame => frame.payload.id === q.request.id)).toBe(true);
      noCredentials(member.frames());
      f.store.updateAgent(f.agent.id, { visibility: "private" });
      member.events.length = 0;
      await member.subscribe(q.row.seq); await member.through(q.row.seq);
      privateRowsHidden(member.frames(), [q.request.id, q.turn.id, q.task.id]);
    } finally { await f.close(); }
  });
});
