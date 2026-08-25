// Daemon and browser websocket upgrades, workspace-scoped fanout, and the
// privacy boundaries on chat/member/invitation events.
import { afterEach, describe, expect, it } from "bun:test";
import { startMultiremiServer } from "@multiremi/api.js";
import { authenticateBrowserWebSocket, createStore, db, expectNoWebSocketMessage, expectWebSocketRejected, nextWebSocketMessage, nextWebSocketMessages, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — realtime websockets", () => {
  it("serves daemon websocket upgrades and realtime health", async () => {
    const store = createStore();
    const workspaceEvents: any[] = [];
    const unsubscribeWorkspaceEvents = store.onWorkspaceEvent((event) => workspaceEvents.push(event));
    const runtime = store.registerRuntime({ id: "rt_ws", name: "WS runtime", provider: "codex" });
    const agent = store.createAgent({ name: "WS Codex", provider: "codex" });
    const updateRequest = store.createRuntimeUpdateRequest(runtime.id, { target_version: "v3.0.0" });
    const modelRequest = store.createRuntimeModelListRequest(runtime.id);
    const localSkillRequest = store.createRuntimeLocalSkillListRequest(runtime.id);
    const importOne = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "ws-one" });
    const importTwo = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "ws-two" });
    const camelRuntime = store.registerRuntime({
      id: "rt_ws_camel",
      name: "Camel WS runtime",
      provider: "codex",
      daemonId: "daemon-ws-camel",
      metadata: { agent_plugin_protocol: 1 },
    });
    const camelImportOne = store.createRuntimeLocalSkillImportRequest(camelRuntime.id, { skill_key: "ws-camel-one" });
    const camelImportTwo = store.createRuntimeLocalSkillImportRequest(camelRuntime.id, { skill_key: "ws-camel-two" });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1" });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      await expectWebSocketRejected(new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtimeId=rt_ws_camel`));
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws`);
      const ready = await nextWebSocketMessage(ws);
      expect(ready).toMatchObject({ type: "ready", transport: "websocket", runtime_id: "rt_ws", runtime_ids: ["rt_ws"] });
      const camelWs = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_camel`);
      expect(await nextWebSocketMessage(camelWs)).toMatchObject({ type: "ready", runtime_id: "rt_ws_camel" });

      camelWs.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtimeId: "rt_ws_camel", supports_batch_import: true },
      }));
      await expectNoWebSocketMessage(camelWs);

      camelWs.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: {
          runtime_id: "rt_ws_camel",
          supportsBatchImport: true,
          ssh_mesh_protocol: 1,
          ssh_mesh_status: { status: "disabled" },
        },
      }));
      const camelHeartbeatAck = await nextWebSocketMessage(camelWs);
      expect(camelHeartbeatAck).toMatchObject({
        type: "daemon:heartbeat_ack",
        payload: {
          runtime_id: "rt_ws_camel",
          status: "ok",
          pending_local_skill_import: { id: camelImportOne.id, skill_key: "ws-camel-one" },
          ssh_mesh: { enabled: false, rotation_state: "stable" },
        },
      });
      expect(camelHeartbeatAck.payload.pending_local_skill_imports).toBeUndefined();
      expect(workspaceEvents.find((event) => event.type === "daemon:heartbeat")).toMatchObject({
        workspaceId: "local",
        actorType: "daemon",
        actorId: "daemon-ws-camel",
        payload: {
          runtime_id: "rt_ws_camel",
          daemon_id: "daemon-ws-camel",
          ssh_mesh: { status: "disabled", enabled: false, rotation_state: "stable" },
        },
      });
      expect(store.getRuntime(camelRuntime.id)?.metadata.agent_plugin_protocol).toBe(1);
      expect(store.getRuntimeLocalSkillImportRequest(camelRuntime.id, camelImportTwo.id)?.status).toBe("pending");
      camelWs.close();
      await Bun.sleep(25);

      const connectedHealth = await fetch(`${baseUrl}/health/realtime`);
      expect(await connectedHealth.json()).toMatchObject({ enabled: true, connections: 1, transport: "websocket" });

      ws.send(JSON.stringify({ type: "ping", runtime_id: "rt_ws" }));
      const pong = await nextWebSocketMessage(ws);
      expect(pong).toMatchObject({ type: "pong", received_type: "ping", runtime_id: "rt_ws", ok: true });

      const queued = store.createTask({ agentId: agent.id, prompt: "wake runtime" });
      const wakeup = await nextWebSocketMessage(ws);
      expect(wakeup).toMatchObject({
        type: "daemon:task_available",
        payload: { runtime_id: "rt_ws", task_id: queued.id },
      });

      expect(store.claimTask(runtime.id)?.id).toBe(queued.id);
      store.markTaskWaitingLocalDirectory(queued.id, "/tmp/ws-runtime");
      const waiting = await nextWebSocketMessage(ws);
      expect(waiting).toMatchObject({
        type: "task:waiting_local_directory",
        payload: {
          runtime_id: "rt_ws",
          task_id: queued.id,
          status: "waiting_local_directory",
          wait_reason: "/tmp/ws-runtime",
        },
      });

      ws.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtime_id: "rt_ws", supports_batch_import: true },
      }));
      const heartbeatAck = await nextWebSocketMessage(ws);
      expect(heartbeatAck).toMatchObject({
        type: "daemon:heartbeat_ack",
        payload: {
          runtime_id: "rt_ws",
          status: "ok",
          pending_update: { id: updateRequest.id, target_version: "v3.0.0" },
          pending_model_list: { id: modelRequest.id },
          pending_local_skills: { id: localSkillRequest.id },
          pending_local_skill_import: { id: importOne.id, skill_key: "ws-one" },
        },
      });
      expect(heartbeatAck.payload.pending_local_skill_imports.map((item: any) => item.id)).toEqual([importOne.id, importTwo.id]);

      store.cancelTask(queued.id);
      expect(store.deleteRuntime(runtime.id)).toBeTrue();
      ws.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtime_id: "rt_ws" },
      }));
      const runtimeGoneAck = await nextWebSocketMessage(ws);
      expect(runtimeGoneAck).toMatchObject({
        type: "daemon:heartbeat_ack",
        payload: { runtime_id: "rt_ws", status: "runtime_gone", runtime_gone: true },
      });

      ws.close();
      await Bun.sleep(25);

      const closedHealth = await fetch(`${baseUrl}/health/realtime`);
      expect(await closedHealth.json()).toMatchObject({ enabled: true, connections: 0, transport: "websocket" });
    } finally {
      unsubscribeWorkspaceEvents();
      server.stop(true);
    }
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
    try {
      const local = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_local`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      } as any);
      expect(await nextWebSocketMessage(local)).toMatchObject({
        type: "ready",
        runtime_id: "rt_ws_local",
        runtime_ids: ["rt_ws_local"],
      });
      local.close();

      const removedOwner = new WebSocket(
        `ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_removed_owner`,
        { headers: { Authorization: `Bearer ${removedDaemonToken.token}` } } as any,
      );
      expect(await nextWebSocketMessage(removedOwner)).toMatchObject({ type: "ready" });
      const removedPlan = store.getDaemonRetirementPlan("local", "daemon-removed-ws");
      expect(store.retireDaemon(
        "local",
        "daemon-removed-ws",
        removedPlan.snapshot,
        "local",
      )).toMatchObject({ status: "retired" });
      store.archiveWorkspaceMember(removedMember.id);
      removedOwner.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtime_id: "rt_ws_removed_owner" },
      }));
      expect(await nextWebSocketMessage(removedOwner)).toMatchObject({
        type: "error",
        code: "daemon_owner_membership_required",
      });

      const removedOwnerReconnect = new WebSocket(
        `ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_removed_owner`,
        { headers: { Authorization: `Bearer ${removedDaemonToken.token}` } } as any,
      );
      await expectWebSocketRejected(removedOwnerReconnect);

      const human = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_local`, {
        headers: { Authorization: `Bearer ${humanToken.token}` },
      } as any);
      await expectWebSocketRejected(human);

      const taskSocket = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_local`, {
        headers: { Authorization: `Bearer ${taskToken.token}` },
      } as any);
      await expectWebSocketRejected(taskSocket);
      expect(store.getRuntime("rt_ws_local")?.metadata.agent_plugin_protocol).toBe(1);

      const master = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_local`, {
        headers: { Authorization: "Bearer root-secret" },
      } as any);
      expect(await nextWebSocketMessage(master)).toMatchObject({ type: "ready" });
      master.send(JSON.stringify({
        type: "daemon:heartbeat",
        payload: { runtime_id: "rt_ws_local", agent_plugin_protocol: 2 },
      }));
      expect(await nextWebSocketMessage(master)).toMatchObject({
        type: "daemon:heartbeat_ack",
        payload: { runtime_id: "rt_ws_local", status: "ok" },
      });
      expect(store.getRuntime("rt_ws_local")?.metadata.agent_plugin_protocol).toBe(2);
      master.close();

      const otherDaemon = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_other_daemon`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      } as any);
      await expectWebSocketRejected(otherDaemon);

      const unboundDaemon = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_local`, {
        headers: { Authorization: `Bearer ${unboundDaemonToken.token}` },
      } as any);
      await expectWebSocketRejected(unboundDaemon);

      const remote = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_ws_remote`, {
        headers: { Authorization: `Bearer ${daemonToken.token}` },
      } as any);
      await expectWebSocketRejected(remote);
    } finally {
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
