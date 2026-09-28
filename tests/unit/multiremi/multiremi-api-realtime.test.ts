// Daemon and browser websocket upgrades, workspace-scoped fanout, and the
// privacy boundaries on chat/member/invitation events.
import { afterEach, describe, expect, it } from "bun:test";
import { startMultiremiServer } from "@multiremi/api.js";
import { notifyBrowserWorkspaceEvent } from "../../../packages/server/src/api/realtime.js";
import { authenticateBrowserWebSocket, createStore, db, expectNoWebSocketMessage, expectWebSocketRejected, nextWebSocketMessage, nextWebSocketMessages, resetMultiremiTestEnv, signTestJwt, waitWebSocketOpen } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function v2Hello(daemonId: string, runtimeIds: string[]): string {
  return JSON.stringify({ v: 2, t: "hello", ts: Date.now(), p: {
    protocol: 2, daemon_id: daemonId, cli_version: "0.2.83", launched_by: null,
    runtimes: runtimeIds.map(runtime_id => ({ runtime_id, provider: "codex", max_concurrency: 1, active_task_ids: [] })), caps: [],
  } });
}

describe("Multiremi API — realtime websockets", () => {
  it("selects a human or restricted workspace-event frame per browser recipient", () => {
    const humanFrames: string[] = [];
    const taskFrames: string[] = [];
    const client = (frames: string[], accessToken: Record<string, unknown> | null) => ({
      data: {
        kind: "browser",
        connectedAt: new Date().toISOString(),
        workspaceId: "local",
        authenticated: true,
        userId: "local",
        accessToken,
        scopeSubscriptions: [],
      },
      sendText: (frame: string) => frames.push(frame),
      close: () => {},
    });
    const human = client(humanFrames, { type: "pat" });
    const task = client(taskFrames, { type: "task" });
    const workspaceRegistry = new Map([["local", new Set([human, task])]]) as any;

    notifyBrowserWorkspaceEvent(workspaceRegistry, new Map(), new Map(), {
      type: "autopilot:updated",
      workspaceId: "local",
      payload: {
        trigger: {
          id: "apt_1",
          webhookToken: "awt_camel_secret",
          webhook_token: "awt_snake_secret",
          webhookPath: "/api/webhooks/autopilots/awt_camel_secret",
          webhook_path: "/api/webhooks/autopilots/awt_snake_secret",
          webhookUrl: "https://example.test/camel",
          webhook_url: "https://example.test/snake",
          signingSecretHint: "secret-hint",
          signing_secret_hint: "secret-hint",
          signingSecretSet: true,
          signing_secret_set: true,
          issueCreationRestricted: true,
          issue_creation_restricted: true,
          issueCreationRestrictionReason: "restricted_task",
          issue_creation_restriction_reason: "restricted_task",
          issueCreationRestrictedByTaskId: "tsk_restricted",
          issue_creation_restricted_by_task_id: "tsk_restricted",
          label: "Webhook trigger",
        },
      },
    });

    const humanEvent = JSON.parse(humanFrames[0]!);
    expect(humanEvent.payload.trigger).toMatchObject({
      webhook_token: "awt_snake_secret",
      webhook_path: "/api/webhooks/autopilots/awt_snake_secret",
      signing_secret_hint: "secret-hint",
      issue_creation_restricted: true,
      issue_creation_restricted_by_task_id: "tsk_restricted",
    });
    const taskEvent = JSON.parse(taskFrames[0]!);
    expect(taskEvent.payload.trigger).toEqual({ id: "apt_1", label: "Webhook trigger" });
  });

  it("keeps browser realtime human-only while preserving human Autopilot diagnostics", async () => {
    const store = createStore();
    store.createWorkspaceMember({
      workspaceId: "local",
      userId: "local",
      name: "Local owner",
      role: "owner",
    });
    const worker = store.createAgent({ name: "Realtime worker", provider: "codex", workspaceId: "local" });
    const restricted = store.createAgent({
      name: "Restricted realtime worker",
      provider: "codex",
      workspaceId: "local",
      issueCreationRequiresProposal: true,
    });
    const restrictedTask = store.createTask({
      agentId: restricted.id,
      workspaceId: "local",
      prompt: "Verify browser realtime policy",
    });
    const taskToken = await store.createTaskAccessToken(restrictedTask, "local");
    const humanToken = await store.createAccessToken({
      name: "Realtime human",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const autopilot = store.createAutopilot({
      title: "Human managed webhook",
      assigneeId: worker.id,
      executionMode: "run_only",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      authToken: "root-secret",
      port: 0,
      hostname: "127.0.0.1",
    });
    const wsUrl = `ws://127.0.0.1:${server.port}/api/realtime/ws?workspace_id=local`;
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const human = new WebSocket(wsUrl);
    try {
      const taskUpgrade = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${taskToken.token}` },
      } as any);
      await expectWebSocketRejected(taskUpgrade);

      const taskAuthFrame = new WebSocket(wsUrl);
      await waitWebSocketOpen(taskAuthFrame);
      taskAuthFrame.send(JSON.stringify({ type: "auth", payload: { token: taskToken.token } }));
      expect(await nextWebSocketMessage(taskAuthFrame)).toEqual({ error: "forbidden for task token" });
      taskAuthFrame.close();

      await authenticateBrowserWebSocket(human, humanToken.token);
      const createdEvent = nextWebSocketMessage(human);
      const created = await fetch(`${baseUrl}/api/autopilots/${autopilot.id}/triggers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${humanToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: "webhook", label: "Human webhook" }),
      });
      expect(created.status).toBe(201);
      const trigger = await created.json() as Record<string, any>;
      expect(trigger.webhook_token).toStartWith("awt_");
      expect(await createdEvent).toMatchObject({
        type: "autopilot:updated",
        payload: {
          autopilot_id: autopilot.id,
          trigger: {
            id: trigger.id,
            webhook_token: trigger.webhook_token,
            webhook_path: trigger.webhook_path,
            issue_creation_restricted: false,
            issue_creation_restriction_reason: null,
            issue_creation_restricted_by_task_id: null,
          },
        },
      });

      const signingEvent = nextWebSocketMessage(human);
      const signed = await fetch(`${baseUrl}/api/autopilots/${autopilot.id}/triggers/${trigger.id}/signing-secret`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${humanToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ signing_secret: "0123456789abcdef" }),
      });
      expect(signed.status).toBe(200);
      expect(await signingEvent).toMatchObject({
        type: "autopilot:updated",
        payload: {
          trigger: {
            id: trigger.id,
            signing_secret_hint: "cdef",
            issue_creation_restricted: false,
          },
        },
      });
    } finally {
      human.close();
      server.stop(true);
    }
  });

  it("serves process-wide v2 heartbeat and realtime health without v1 wake-up or pending delivery", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_ws", name: "WS runtime", provider: "codex" });
    const second = store.registerRuntime({ id: "rt_ws_second", name: "Second WS runtime", provider: "claude" });
    const agent = store.createAgent({ name: "WS Codex", provider: "codex" });
    const model = store.createRuntimeModelListRequest(runtime.id);
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1" });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`);
    try {
      await waitWebSocketOpen(ws);
      ws.send(v2Hello("daemon-ws", [runtime.id, second.id]));
      expect(await nextWebSocketMessage(ws)).toMatchObject({ v: 2, t: "welcome" });
      expect(await (await fetch(`http://127.0.0.1:${server.port}/health/realtime`)).json()).toMatchObject({ enabled: true, connections: 1, transport: "websocket" });
      ws.send(JSON.stringify({ v: 2, t: "hb", id: "hb-1", p: { active_task_count: 0 } }));
      const ack = await nextWebSocketMessage(ws);
      expect(ack).toMatchObject({ t: "res", re: "hb-1", p: { runtime_acks: [
        { runtime_id: runtime.id, status: "ok" },
        { runtime_id: second.id, status: "ok" },
      ] } });
      expect(ack.p.runtime_acks[0].pending_model_list).toBeUndefined();
      expect(store.getRuntimeModelListRequest(runtime.id, model.id)?.status).toBe("pending");
      const queued = store.createTask({ agentId: agent.id, prompt: "polling transition" });
      await expectNoWebSocketMessage(ws);
      expect(store.claimTask(runtime.id)?.id).toBe(queued.id);
      store.cancelTask(queued.id);
      const update = store.createRuntimeUpdateRequest(runtime.id, { target_version: "v3.0.0" });
      ws.send(JSON.stringify({ v: 2, t: "hb", id: "hb-pending", p: { active_task_count: 0 } }));
      const pendingAck = await nextWebSocketMessage(ws);
      expect(pendingAck.p.runtime_acks[0].pending_update).toBeUndefined();
      expect(store.getRuntimeUpdateRequest(runtime.id, update.id)?.status).toBe("pending");
      expect(store.deleteRuntime(runtime.id)).toBeTrue();
      ws.send(JSON.stringify({ v: 2, t: "hb", id: "hb-2", p: { active_task_count: 0 } }));
      expect(await nextWebSocketMessage(ws)).toMatchObject({ t: "res", re: "hb-2", p: { runtime_acks: [
        { runtime_id: runtime.id, status: "runtime_gone", runtime_gone: true },
        { runtime_id: second.id, status: "ok" },
      ] } });
      ws.close();
      await Bun.sleep(25);
      expect(await (await fetch(`http://127.0.0.1:${server.port}/health/realtime`)).json()).toMatchObject({ connections: 0 });
    } finally { ws.close(); server.stop(true); }
  });

  it("serves browser workspace websocket fanout with workspace isolation", async () => {
    const store = createStore();
    const localRuntime = store.registerRuntime({ id: "rt_browser_local", name: "Browser local runtime", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Browser Claude", provider: "claude" });
    const remoteWorkspace = store.createWorkspace({ id: "ws_browser_remote", name: "Browser Remote", slug: "browser-remote" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local", title: "Private browser chat" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Local", role: "owner" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "other-user", name: "Other Local", role: "member" });
    store.createWorkspaceMember({ workspaceId: remoteWorkspace.id, userId: "local", name: "Local", role: "owner" });
    const localToken = await store.createAccessToken({ name: "Local browser", type: "pat", workspaceId: "local" });
    const otherLocalToken = await store.createAccessToken({ name: "Other local browser", type: "pat", workspaceId: "local", userId: "other-user" });
    const remoteToken = await store.createAccessToken({ name: "Remote browser", type: "pat", workspaceId: remoteWorkspace.id });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1" });
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_slug=local`);
    const remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`);
    const otherLocal = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`);
    const jwtUpgrade = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_slug=local`, {
      headers: { Authorization: `Bearer ${signTestJwt({ sub: "local", exp: Math.floor(Date.now() / 1000) + 60 })}` },
    } as any);
    const jwtForbidden = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`, {
      headers: { Authorization: `Bearer ${signTestJwt({ sub: "ghost-user", exp: Math.floor(Date.now() / 1000) + 60 })}` },
    } as any);
    try {
      expect(await nextWebSocketMessage(jwtUpgrade)).toMatchObject({ type: "auth_ack" });
      jwtUpgrade.close();
      await expectWebSocketRejected(jwtForbidden);

      await authenticateBrowserWebSocket(local, localToken.token);
      await authenticateBrowserWebSocket(remote, remoteToken.token);
      await authenticateBrowserWebSocket(otherLocal, otherLocalToken.token);

      const localTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "local browser realtime" });
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:queued",
        payload: {
          task_id: localTask.id,
          workspace_id: "local",
          status: "queued",
        },
        actor_id: agent.id,
        actor_type: "agent",
      });
      expect(await nextWebSocketMessage(otherLocal)).toMatchObject({
        type: "task:queued",
        payload: { task_id: localTask.id, workspace_id: "local" },
      });
      await expectNoWebSocketMessage(remote);

      local.send(JSON.stringify({ type: "ping" }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "pong" });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "workspace", id: "local" } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "workspace", id: "local" } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "user", id: "local" } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "user", id: "local" } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "task", id: localTask.id } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "task", id: localTask.id } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "subscribe_ack", payload: { scope: "chat", id: chat.id } });
      local.send(JSON.stringify({ type: "subscribe", payload: { scope: "unknown", id: "scope-1" } }));
      expect(await nextWebSocketMessage(local)).toEqual({
        type: "subscribe_error",
        payload: { scope: "unknown", id: "scope-1", error: "unknown_scope" },
      });
      otherLocal.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(otherLocal)).toEqual({
        type: "subscribe_error",
        payload: { scope: "chat", id: chat.id, error: "forbidden" },
      });
      local.send(JSON.stringify({ type: "unsubscribe", payload: { scope: "task", id: localTask.id } }));
      expect(await nextWebSocketMessage(local)).toEqual({ type: "unsubscribe_ack", payload: { scope: "task", id: localTask.id } });

      // A task inherits its agent's workspace, so the remote-workspace task
      // needs an agent that actually lives in the remote workspace.
      const remoteAgent = store.createAgent({ name: "Browser Remote", provider: "claude", workspaceId: remoteWorkspace.id });
      const remoteTask = store.createTask({ agentId: remoteAgent.id, prompt: "remote browser realtime" });
      expect(await nextWebSocketMessage(remote)).toMatchObject({
        type: "task:queued",
        payload: {
          task_id: remoteTask.id,
          workspace_id: remoteWorkspace.id,
          status: "queued",
        },
      });
      await expectNoWebSocketMessage(local);

      expect(store.claimTask(localRuntime.id)?.id).toBe(localTask.id);
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:dispatch",
        payload: {
          task_id: localTask.id,
          runtime_id: localRuntime.id,
          status: "dispatched",
        },
      });
      store.markTaskWaitingLocalDirectory(localTask.id, "/tmp/browser-local");
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:waiting_local_directory",
        payload: {
          task_id: localTask.id,
          wait_reason: "/tmp/browser-local",
          status: "waiting_local_directory",
        },
      });
      store.startTask(localTask.id);
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:running",
        payload: {
          task_id: localTask.id,
          status: "running",
        },
      });
      store.completeTask(localTask.id, { output: "done", sessionId: "sess-browser", workDir: "/tmp/browser-local" });
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "task:completed",
        payload: {
          task_id: localTask.id,
          status: "completed",
          session_id: "sess-browser",
          work_dir: "/tmp/browser-local",
          result: "done",
        },
      });
    } finally {
      local.close();
      remote.close();
      otherLocal.close();
      jwtUpgrade.close();
      jwtForbidden.close();
      server.stop(true);
    }
  });

  it("routes chat realtime events privately to the chat creator scope", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Chat Claude", provider: "claude", workspaceId: "local" });
    const runtime = store.registerRuntime({ id: "rt_chat_realtime", name: "chat runtime", provider: "claude", workspaceId: "local" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local", creatorId: "local", title: "Private chat" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Creator", role: "owner" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "peer-user", name: "Workspace peer", role: "member" });
    const creatorToken = await store.createAccessToken({ name: "Creator", type: "pat", workspaceId: "local", userId: "local" });
    const peerToken = await store.createAccessToken({ name: "Workspace peer", type: "pat", workspaceId: "local", userId: "peer-user" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1" });
    const creator = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_slug=local`);
    const peer = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`);
    const creatorMessages: any[] = [];
    const peerMessages: any[] = [];
    try {
      await authenticateBrowserWebSocket(creator, creatorToken.token);
      await authenticateBrowserWebSocket(peer, peerToken.token);

      creator.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(creator)).toEqual({ type: "subscribe_ack", payload: { scope: "chat", id: chat.id } });
      // A workspace peer cannot subscribe to a chat it does not own.
      peer.send(JSON.stringify({ type: "subscribe", payload: { scope: "chat", id: chat.id } }));
      expect(await nextWebSocketMessage(peer)).toEqual({
        type: "subscribe_error",
        payload: { scope: "chat", id: chat.id, error: "forbidden" },
      });

      // Accumulate every frame each socket receives from here on.
      creator.addEventListener("message", (event) => creatorMessages.push(JSON.parse(String(event.data))));
      peer.addEventListener("message", (event) => peerMessages.push(JSON.parse(String(event.data))));

      const sent = store.sendChatMessage(chat.id, { body: "hello private" });
      const queued = store.sendChatMessage(chat.id, { body: "private pending" });
      store.updateQueuedChatTask(chat.id, queued.task.id, "private revised input");
      store.removeQueuedChatTasks(chat.id, queued.task.id);
      expect(store.claimTask(runtime.id)?.id).toBe(sent.task.id);
      store.startTask(sent.task.id);
      store.completeTask(sent.task.id, { output: "all done", sessionId: "sess-chat", workDir: "/tmp/chat" });
      store.markChatSessionRead(chat.id);
      store.updateChatSession(chat.id, { title: "Renamed chat" });
      store.deleteChatSession(chat.id);

      // Let the asynchronous websocket delivery settle.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const first = (type: string) => creatorMessages.find((m) => m.type === type);
      expect(first("chat:message")).toMatchObject({
        type: "chat:message",
        payload: { chat_session_id: chat.id, message_id: sent.message.id, role: "user", content: "hello private", task_id: sent.task.id },
      });
      expect(first("chat:done")).toMatchObject({
        type: "chat:done",
        actor_type: "system",
        payload: { chat_session_id: chat.id, task_id: sent.task.id, content: "all done" },
      });
      expect(first("chat:queue_updated")).toMatchObject({ type: "chat:queue_updated", payload: { chat_session_id: chat.id } });
      expect(first("chat:session_read")).toMatchObject({ type: "chat:session_read", payload: { chat_session_id: chat.id } });
      expect(first("chat:session_updated")).toMatchObject({
        type: "chat:session_updated",
        payload: { chat_session_id: chat.id, title: "Renamed chat" },
      });
      expect(first("chat:session_deleted")).toMatchObject({ type: "chat:session_deleted", payload: { chat_session_id: chat.id } });
      // Chat-linked task lifecycle (which carries the assistant result text) stays on the private chat scope.
      expect(first("task:completed")?.payload).toMatchObject({ task_id: sent.task.id, chat_session_id: chat.id, result: "all done" });
      // The workspace peer must never receive any private chat session traffic.
      expect(peerMessages).toEqual([]);
    } finally {
      creator.close();
      peer.close();
      server.stop(true);
    }
  });

  it("routes workspace member and invitation realtime events like Go", async () => {
    const store = createStore();
    const localWorkspace = store.ensureLocalWorkspace();
    const localOwner = store.getWorkspaceMember(`mem_${localWorkspace.id}_local`)!;
    store.createWorkspaceMember({
      id: "mem_browser_realtime_backup",
      workspaceId: localWorkspace.id,
      name: "Browser Realtime Backup",
      email: "browser-realtime-backup@example.com",
      role: "owner",
    });
    const remoteWorkspace = store.createWorkspace({ id: "ws_browser_events_remote", name: "Browser Events Remote", slug: "browser-events-remote" });
    store.createWorkspaceMember({
      id: `mem_${remoteWorkspace.id}_admin-user`,
      userId: "admin-user",
      workspaceId: remoteWorkspace.id,
      name: "Remote Admin",
      email: "remote-admin@example.com",
      role: "owner",
    });
    db!.run("DELETE FROM multiremi_workspace_members WHERE id = ?", [`mem_${remoteWorkspace.id}_local`]);
    const localToken = await store.createAccessToken({ name: "Local browser events", type: "pat", workspaceId: localWorkspace.id });
    const remoteToken = await store.createAccessToken({
      name: "Remote browser events",
      type: "pat",
      workspaceId: remoteWorkspace.id,
      userId: "admin-user",
    });
    const server = startMultiremiServer({ store, scheduler: null, authToken: "test-root", port: 0, hostname: "127.0.0.1" });
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${localWorkspace.id}`);
    const remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      await authenticateBrowserWebSocket(local, localToken.token);
      await authenticateBrowserWebSocket(remote, remoteToken.token);

      const updatedEvent = nextWebSocketMessage(local);
      const updated = await fetch(`${baseUrl}/api/workspaces/${localWorkspace.id}/members/${localOwner.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${localToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      });
      expect(updated.status).toBe(200);
      expect(await updatedEvent).toMatchObject({
        type: "member:updated",
        payload: {
          member: {
            id: localOwner.id,
            workspace_id: localWorkspace.id,
            user_id: "local",
            role: "admin",
          },
        },
        actor_id: "local",
        actor_type: "member",
      });
      await expectNoWebSocketMessage(remote);

      const invited = await fetch(`${baseUrl}/api/workspaces/${localWorkspace.id}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: "browser-invite@example.com", role: "member" }),
      });
      expect(invited.status).toBe(201);
      const invitedBody = await invited.json();
      await expectNoWebSocketMessage(local);
      await expectNoWebSocketMessage(remote);

      const revoked = await fetch(`${baseUrl}/api/workspaces/${localWorkspace.id}/invitations/${invitedBody.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localToken.token}` },
      });
      expect(revoked.status).toBe(204);
      await expectNoWebSocketMessage(local);
      await expectNoWebSocketMessage(remote);

      const localInviteCreatedEvent = nextWebSocketMessage(local);
      const localInviteCreated = await fetch(`${baseUrl}/api/workspaces/${remoteWorkspace.id}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${remoteToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: store.getCurrentUser().email, role: "member" }),
      });
      expect(localInviteCreated.status).toBe(201);
      const localInviteBody = await localInviteCreated.json();
      expect(await localInviteCreatedEvent).toMatchObject({
        type: "invitation:created",
        payload: {
          invitation: {
            id: localInviteBody.id,
            workspace_id: remoteWorkspace.id,
            invitee_email: store.getCurrentUser().email,
            invitee_user_id: "local",
            role: "member",
            status: "pending",
          },
          workspace_name: remoteWorkspace.name,
        },
        actor_id: "admin-user",
        actor_type: "member",
      });
      await expectNoWebSocketMessage(remote);

      const localInviteRevokedEvent = nextWebSocketMessage(local);
      const localInviteRevoked = await fetch(`${baseUrl}/api/workspaces/${remoteWorkspace.id}/invitations/${localInviteBody.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${remoteToken.token}` },
      });
      expect(localInviteRevoked.status).toBe(204);
      expect(await localInviteRevokedEvent).toMatchObject({
        type: "invitation:revoked",
        payload: {
          invitation_id: localInviteBody.id,
          invitee_email: store.getCurrentUser().email,
          invitee_user_id: "local",
        },
        actor_id: "admin-user",
        actor_type: "member",
      });
      await expectNoWebSocketMessage(remote);

      const acceptedInviteCreatedEvent = nextWebSocketMessage(local);
      const acceptedInviteCreated = await fetch(`${baseUrl}/api/workspaces/${remoteWorkspace.id}/members`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${remoteToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: store.getCurrentUser().email, role: "member" }),
      });
      expect(acceptedInviteCreated.status).toBe(201);
      const acceptedInviteBody = await acceptedInviteCreated.json();
      expect(await acceptedInviteCreatedEvent).toMatchObject({ type: "invitation:created" });
      await expectNoWebSocketMessage(remote);

      const localMemberAddedEvent = nextWebSocketMessage(local);
      const remoteAcceptedEvents = nextWebSocketMessages(remote, 2);
      const accepted = await fetch(`${baseUrl}/api/invitations/${acceptedInviteBody.id}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localToken.token}` },
      });
      expect(accepted.status).toBe(200);
      expect(await localMemberAddedEvent).toMatchObject({
        type: "member:added",
        payload: {
          member: {
            workspace_id: remoteWorkspace.id,
            user_id: "local",
            role: "member",
          },
          workspace_name: remoteWorkspace.name,
        },
        actor_id: "local",
        actor_type: "member",
      });
      const [remoteMemberAddedEvent, remoteInvitationAcceptedEvent] = await remoteAcceptedEvents;
      expect(remoteMemberAddedEvent).toMatchObject({
        type: "member:added",
        payload: {
          member: {
            workspace_id: remoteWorkspace.id,
            user_id: "local",
            role: "member",
          },
          workspace_name: remoteWorkspace.name,
        },
      });
      expect(remoteInvitationAcceptedEvent).toMatchObject({
        type: "invitation:accepted",
        payload: {
          invitation_id: acceptedInviteBody.id,
          member: {
            workspace_id: remoteWorkspace.id,
            user_id: "local",
          },
        },
      });
      await expectNoWebSocketMessage(local);
    } finally {
      local.close();
      remote.close();
      server.stop(true);
    }
  });

  it("scopes daemon websocket upgrades to authorized runtime workspaces", async () => {
    const store = createStore();
    store.registerRuntime({
      id: "rt_ws_local",
      name: "Local WS",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-local",
      metadata: { agent_plugin_protocol: 1 },
    });
    store.registerRuntime({ id: "rt_ws_other_daemon", name: "Other daemon WS", provider: "codex", workspaceId: "local", daemonId: "daemon-other" });
    store.registerRuntime({ id: "rt_ws_remote", name: "Remote WS", provider: "codex", workspaceId: "remote" });
    const otherDaemonHeartbeat = store.getRuntime("rt_ws_other_daemon")!.lastHeartbeatAt;
    const remoteHeartbeat = store.getRuntime("rt_ws_remote")!.lastHeartbeatAt;
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      daemonId: "daemon-local",
      name: "Local daemon",
      type: "daemon",
    });
    const unboundDaemonToken = await store.createAccessToken({
      workspaceId: "local",
      name: "Unbound local daemon",
      type: "daemon",
    });
    const humanToken = await store.createAccessToken({
      workspaceId: "local",
      name: "Local human",
      type: "pat",
    });
    const taskAgent = store.createAgent({ name: "WS task agent", provider: "codex", workspaceId: "local" });
    const taskIssue = store.createIssue({ title: "WS task", workspaceId: "local" });
    const task = store.createTask({
      agentId: taskAgent.id,
      issueId: taskIssue.id,
      workspaceId: "local",
      prompt: "Do not assume daemon identity",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const removedMember = store.createWorkspaceMember({
      id: "member-removed-daemon-ws",
      workspaceId: "local",
      userId: "removed-daemon-ws-owner",
      name: "Removed daemon WS owner",
      role: "member",
    });
    const removedDaemonToken = await store.createAccessToken({
      workspaceId: "local",
      daemonId: "daemon-removed-ws",
      userId: "removed-daemon-ws-owner",
      name: "Removed daemon WS",
      type: "daemon",
    });
    store.registerRuntime({
      id: "rt_ws_removed_owner",
      name: "Removed owner WS",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-removed-ws",
      ownerId: "removed-daemon-ws-owner",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: "root-secret",
    });
    const sockets: WebSocket[] = [];
    const connect = async (token: string, daemonId: string, ids: string[]) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, { headers: { Authorization: `Bearer ${token}` } } as never);
      sockets.push(socket);
      await waitWebSocketOpen(socket);
      socket.send(v2Hello(daemonId, ids));
      expect(await nextWebSocketMessage(socket)).toMatchObject({ t: "welcome" });
      return socket;
    };
    try {
      const local = await connect(daemonToken.token, "daemon-local", ["rt_ws_local", "rt_ws_other_daemon", "rt_ws_remote"]);
      local.send(JSON.stringify({ v: 2, t: "hb", id: "hb-auth", p: { active_task_count: 0 } }));
      expect(await nextWebSocketMessage(local)).toMatchObject({ t: "res", re: "hb-auth", p: { runtime_acks: [
        { runtime_id: "rt_ws_local", status: "ok" },
        { runtime_id: "rt_ws_other_daemon", status: "runtime_gone", runtime_gone: true },
        { runtime_id: "rt_ws_remote", status: "runtime_gone", runtime_gone: true },
      ] } });
      local.close();
      const removedOwner = await connect(removedDaemonToken.token, "daemon-removed-ws", ["rt_ws_removed_owner"]);
      const removedPlan = store.getDaemonRetirementPlan("local", "daemon-removed-ws");
      expect(store.retireDaemon("local", "daemon-removed-ws", removedPlan.snapshot, "local")).toMatchObject({ status: "retired" });
      store.archiveWorkspaceMember(removedMember.id);
      const closed = new Promise<number>(resolve => removedOwner.addEventListener("close", event => resolve(event.code), { once: true }));
      removedOwner.send(JSON.stringify({ v: 2, t: "hb", id: "hb-removed", p: { active_task_count: 0 } }));
      expect(await closed).toBe(4401);
      for (const [token, status, code] of [
        [humanToken.token, 403, "daemon_token_required"],
        [taskToken.token, 403, "daemon_token_required"],
        [unboundDaemonToken.token, 403, "daemon_identity_forbidden"],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, { headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${token}` } });
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
      }
      // Retirement revokes the credential itself: a reconnect is unauthorized,
      // while the existing socket above observes the removed owner as 4401.
      const retired = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, { headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${removedDaemonToken.token}` } });
      expect(retired.status).toBe(401);
      const master = await connect("root-secret", "daemon-local", ["rt_ws_local"]);
      master.send(JSON.stringify({ v: 2, t: "hb", id: "hb-master", p: { active_task_count: 0 } }));
      expect(await nextWebSocketMessage(master)).toMatchObject({ t: "res", re: "hb-master", p: { runtime_acks: [{ runtime_id: "rt_ws_local", status: "ok" }] } });
      expect(store.getRuntime("rt_ws_local")?.metadata.agent_plugin_protocol).toBe(1);
      expect(store.getRuntime("rt_ws_remote")?.lastHeartbeatAt).toBe(remoteHeartbeat);
      expect(store.getRuntime("rt_ws_other_daemon")?.lastHeartbeatAt).toBe(otherDaemonHeartbeat);
    } finally {
      for (const socket of sockets) socket.close();
      server.stop(true);
    }
  });

  it("preserves Plugin capability while desired uses the HTTP fallback until business pushes are wired", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_ws_plugin_revision",
      name: "WS plugin runtime",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-ws-plugin",
      metadata: { agent_plugin_protocol: 1 },
    });
    const agent = store.createAgent({ name: "WS plugin agent", provider: "claude", workspaceId: "local" });
    const plugin = store.importAgentPlugin({
      workspaceId: "local",
      provider: "claude",
      manifest: { name: "ws-plugin", version: "1.0.0" },
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      daemonId: "daemon-ws-plugin",
      name: "WS plugin daemon",
      type: "daemon",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: "root-secret",
    });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: `Bearer ${daemonToken.token}` } } as any,
    );
    try {
      await waitWebSocketOpen(socket);
      socket.send(v2Hello("daemon-ws-plugin", [runtime.id]));
      expect(await nextWebSocketMessage(socket)).toMatchObject({ t: "welcome" });
      socket.send(JSON.stringify({
        v: 2, t: "hb", id: "hb-plugin", p: { active_task_count: 0 },
      }));
      const ack = await nextWebSocketMessage(socket);
      expect(ack).toMatchObject({
        t: "res", re: "hb-plugin",
        p: { runtime_acks: [{ runtime_id: runtime.id, status: "ok" }] },
      });
      expect(store.getRuntime(runtime.id)?.metadata.agent_plugin_protocol).toBe(1);
      const desired = await fetch(`http://127.0.0.1:${server.port}/api/daemon/runtimes/${runtime.id}/agent-plugins/desired`, { headers: { Authorization: `Bearer ${daemonToken.token}` } });
      expect(desired.status).toBe(200);
      expect((await desired.json() as any).revision).toBe(store.getRuntimeAgentPluginDesiredSnapshot(runtime.id).revision);
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("fans out runtime offline events on daemon deregister with workspace scoping", async () => {
    const store = createStore();
    const localRuntime = store.registerRuntime({
      id: "rt_deregister_ws_local",
      name: "Deregister Local WS",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-local",
    });
    const remoteWorkspace = store.createWorkspace({
      id: "ws_deregister_remote",
      name: "Deregister Remote",
      slug: "deregister-remote",
    });
    const remoteRuntime = store.registerRuntime({
      id: "rt_deregister_ws_remote",
      name: "Deregister Remote WS",
      provider: "codex",
      workspaceId: remoteWorkspace.id,
      daemonId: "daemon-remote",
    });
    store.createWorkspaceMember({ workspaceId: "local", userId: "local", name: "Local", role: "owner" });
    store.createWorkspaceMember({ workspaceId: remoteWorkspace.id, userId: "remote-user", name: "Remote", role: "owner" });
    const localBrowserToken = await store.createAccessToken({
      name: "Local browser",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const remoteBrowserToken = await store.createAccessToken({
      name: "Remote browser",
      type: "pat",
      workspaceId: remoteWorkspace.id,
      userId: "remote-user",
    });
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      daemonId: "daemon-local",
      name: "Local daemon",
      type: "daemon",
    });
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: "root-secret",
    });
    const local = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`);
    const remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=${remoteWorkspace.id}`);
    try {
      await authenticateBrowserWebSocket(local, localBrowserToken.token);
      await authenticateBrowserWebSocket(remote, remoteBrowserToken.token);

      const runtimeUpdatedEvent = nextWebSocketMessage(local);
      const deregistered = await fetch(`http://127.0.0.1:${server.port}/api/daemon/deregister`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runtime_ids: [localRuntime.id, remoteRuntime.id, "rt_missing_deregister_ws"] }),
      });
      expect(deregistered.status).toBe(200);
      expect(await deregistered.json()).toEqual({ status: "ok" });
      expect(await runtimeUpdatedEvent).toMatchObject({
        type: "runtime:updated",
        actor_id: "daemon-local",
        actor_type: "daemon",
        payload: {
          reason: "daemon_deregistered",
          runtime: {
            id: localRuntime.id,
            workspace_id: "local",
            daemon_id: "daemon-local",
            status: "offline",
          },
        },
      });
      await expectNoWebSocketMessage(remote);
      expect(store.getRuntime(localRuntime.id)?.status).toBe("offline");
      expect(store.getRuntime(remoteRuntime.id)?.status).toBe("online");

      const duplicateDeregister = await fetch(`http://127.0.0.1:${server.port}/api/daemon/deregister`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${daemonToken.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ runtime_ids: [localRuntime.id] }),
      });
      expect(duplicateDeregister.status).toBe(200);
      await expectNoWebSocketMessage(local);
    } finally {
      local.close();
      remote.close();
      server.stop(true);
    }
  });
});
