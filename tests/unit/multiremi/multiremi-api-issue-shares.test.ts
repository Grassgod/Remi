import { createResponsibleTestIssue } from './helpers.js';
import { turnApiPath, mutateExecutionFixture } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import { isTraceFileEvent } from "@multiremi/contracts/trace-file.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

import { TRACE_READ_MAX_BYTES } from "@multiremi/trace/trace-reader.js";
import { traceWriter } from "../../helpers/turn-trace.js";
import {
  bulkItem, messageEvent, oversizedTraceCases, TRACE_BUDGET_FIXTURE_TS, TRACE_STORED_EVENT_MAX_BYTES,
  storedEventBytes, turnStartedEvent,
} from "./trace-budget-fixtures.js";

afterEach(resetMultiremiTestEnv);

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** An Issue task whose hot trace lives in `trace`, plus the page and share trace paths for it. */
async function sharedTraceFixture(trace: InMemoryTraceStore, endpoint: "page" | "share", daemon = new InMemoryDaemonTraceReader(() => trace)) {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "rt_budget", name: "Budget runtime", provider: "codex", workspaceId: "local" });
  const agent = store.createAgent({ name: "Budget agent", provider: "codex", workspaceId: "local" });
  const issue = createResponsibleTestIssue(store, { title: "Budget issue", workspaceId: "local" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Budget" });
  store.markTaskTraceDaemon(task.id, runtime.id);
  const app = createMultiremiApp({ store, daemonTraceReader: daemon, shareSecret: "test-share-secret" });
  const shared = await app.request(`/api/issues/${issue.id}/share`, { method: "POST" });
  expect(shared.status).toBe(201);
  const token = (await shared.json()).share.token;
  const path = endpoint === "page" ? turnApiPath(store, task.id, "/trace") : `/api/shares/${encodeURIComponent(token)}/tasks/${task.id}/trace`;
  const get = async (query = "") => {
    const response = await app.request(`${path}${query}`, { headers: { "X-Remi-Share": token } });
    const text = await response.text();
    return { status: response.status, text, page: response.status === 200 ? JSON.parse(text) : null };
  };
  return { task, get };
}

describe("Multiremi API - issue sharing", () => {
  for (const endpoint of ["page", "share"] as const) {
    for (const { name, input } of oversizedTraceCases) {
      it(`${endpoint} trace view=events returns ${name} byte-for-byte alone and keeps pagination`, async () => {
        const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
        const { task, get } = await sharedTraceFixture(trace, endpoint);
        const original = trace.append(task.id, [input, messageEvent("msg:last", "last")]).events;
        const eventBytes = storedEventBytes(original[0]!);
        expect(eventBytes).toBeGreaterThan(TRACE_READ_MAX_BYTES);
        expect(eventBytes).toBeLessThanOrEqual(TRACE_STORED_EVENT_MAX_BYTES);
        expect(isTraceFileEvent(original[0])).toBe(true);
        const first = await get("?view=events");
        expect(first.status).toBe(200);
        expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(eventBytes + 512);
        expect(first.page).toMatchObject({ view: "events", format: "v2", state: "ok", head: 2, next_after_seq: original[0]!.seq, eof: false });
        expect(first.page.events).toHaveLength(1);
        expect(JSON.stringify(first.page.events[0])).toBe(JSON.stringify(original[0]));
        const last = await get(`?view=events&after_seq=${first.page.next_after_seq}`);
        expect(last.status).toBe(200);
        expect(last.page).toMatchObject({ state: "ok", head: 2, next_after_seq: original[1]!.seq, eof: true });
        expect(JSON.stringify(last.page.events)).toBe(JSON.stringify([original[1]!]));
        console.log(`PR2 trace ${name} HTTP ${endpoint}: event=${eventBytes}, events=${Buffer.byteLength(JSON.stringify(first.page.events))}, body=${Buffer.byteLength(first.text)}`);
      });
    }

    it(`${endpoint} trace view=events returns normal, oversized, normal events on exact successive pages`, async () => {
      const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
      const { task, get } = await sharedTraceFixture(trace, endpoint);
      const original = trace.append(task.id, [
        messageEvent("msg:first", "first"), oversizedTraceCases[1]!.input, messageEvent("msg:last", "last"),
      ]).events;
      let afterSeq = 0;
      for (const event of original) {
        const { status, text, page } = await get(`?view=events&after_seq=${afterSeq}`);
        expect(status).toBe(200);
        expect(page).toMatchObject({ state: "ok", head: 3, next_after_seq: event.seq, eof: event.seq === 3 });
        expect(JSON.stringify(page.events)).toBe(JSON.stringify([event]));
        if (event.seq !== 2) {
          expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES);
          expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
        }
        afterSeq = page.next_after_seq;
      }
    });

    it(`${endpoint} trace view=events keeps two 600KiB events on separate bounded pages`, async () => {
      const trace = new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS);
      const daemon = new InMemoryDaemonTraceReader(() => trace);
      const { task, get } = await sharedTraceFixture(trace, endpoint, daemon);
      const original = trace.append(task.id, [0, 1].map((i) =>
        ({ type: "item.completed" as const, item: bulkItem(`cmd_${i}`, "\u0001".repeat(100_000)) }))).events;
      expect(storedEventBytes(original[0]!)).toBeGreaterThan(600_000);
      for (const afterSeq of [0, 1]) {
        // This source intentionally ignores the byte budget, exercising B5 itself.
        daemon.read = async () => ({ ok: true, view: "events", format: "v2", events: original.slice(afterSeq), next_after_seq: 2, head: 2, eof: true, closed: true });
        const { status, text, page } = await get(`?view=events&after_seq=${afterSeq}`);
        expect(status).toBe(200);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(TRACE_READ_MAX_BYTES + 512);
        expect(page).toMatchObject({ next_after_seq: afterSeq + 1, eof: afterSeq === 1 });
        expect(JSON.stringify(page.events)).toBe(JSON.stringify([original[afterSeq]!]));
      }
    });

    it(`${endpoint} trace defaults to view=turn and pages items by item_cursor`, async () => {
      const writer = traceWriter(new InMemoryTraceStore(() => TRACE_BUDGET_FIXTURE_TS), { runtimeId: "rt_budget" });
      const { task, get } = await sharedTraceFixture(writer.store as InMemoryTraceStore, endpoint);
      try {
        writer.append(task.id, [turnStartedEvent(task.id), oversizedTraceCases[0]!.input, messageEvent("msg:last", "last")]);
        const first = await get();
        expect(first.status).toBe(200);
        expect(first.page).toMatchObject({ view: "turn", format: "v2", state: "ok", closed: false, head: 3,
          next_item_cursor: 1, turn: { id: task.id, status: "running" } });
        expect(first.page.items.map((item: { id: string }) => item.id)).toEqual(["agent_ceiling"]);
        expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(TRACE_STORED_EVENT_MAX_BYTES + 2048);
        const rest = await get(`?item_cursor=${first.page.next_item_cursor}`);
        expect(rest.page).toMatchObject({ next_item_cursor: null, items: [{ id: "msg:last", text: "last" }] });
        writer.close(task.id, "completed");
        const closed = await get("?view=turn&limit=1");
        expect(closed.page).toMatchObject({ closed: true, turn: { status: "completed" }, items: [{ id: "agent_ceiling" }], next_item_cursor: 1 });
        for (const query of ["?after_seq=1", "?view=events&item_cursor=1", "?view=fragments", "?item_cursor=-1", "?max_bytes=0"]) {
          expect((await get(query)).status, query).toBe(400);
        }
      } finally { await writer.stop(); }
    });
  }

  it("hard-denies task credentials from minting, reading, extending, or revoking share capabilities", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Share task agent", provider: "codex", workspaceId: "local" });
    const taskIssue = createResponsibleTestIssue(store, { title: "Task source", workspaceId: "local", createdBy: "local" });
    const siblingIssue = createResponsibleTestIssue(store, { title: "Sibling target", workspaceId: "local", createdBy: "local" });
    const task = store.createTask({
      agentId: agent.id,
      issueId: taskIssue.id,
      workspaceId: "local",
      prompt: "Do not mint shares",
    });
    const taskCredential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret", shareSecret: "test-share-secret" });

    for (const [method, suffix] of [
      ["GET", ""],
      ["POST", ""],
      ["POST", "/extend"],
      ["DELETE", ""],
    ] as const) {
      const response = await app.request(`/api/issues/${siblingIssue.id}/share${suffix}`, {
        method,
        ...bearer(taskCredential.token),
      });
      expect(response.status, `${method} ${suffix || "/"}`).toBe(403);
      expect(await response.json()).toEqual({
        error: "forbidden for task token",
        code: "task_token_hard_denied",
      });
    }
    expect(store.getActiveIssueShare(siblingIssue.id)).toBeNull();
  });

  it("grants a signed, revocable, issue-only read view to a logged-in non-member", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const traceStore = new InMemoryTraceStore();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      shareSecret: "test-share-secret",
      daemonTraceReader: new InMemoryDaemonTraceReader(() => traceStore),
    });
    const owner = await store.createAccessToken({
      name: "Owner session",
      workspaceId: "local",
      userId: "local",
      type: "pat",
      purpose: "session",
      expiresInDays: 30,
    });
    const viewerUser = store.getOrCreateUser({
      externalId: "ou_share_viewer",
      email: "viewer@feishu.local",
      name: "Viewer",
    });
    const viewer = await store.createAccessToken({
      name: "Viewer session",
      workspaceId: "local",
      userId: viewerUser.id,
      type: "pat",
      purpose: "session",
      expiresInDays: 30,
    });
    const project = store.createProject({
      title: "Internal delivery project",
      workspaceId: "local",
      instructions: "INTERNAL_AGENT_RULE_DO_NOT_SHARE",
    });
    const issue = createResponsibleTestIssue(store, {
      title: "Shared launch plan",
      description: "Everything visible on the issue page",
      workspaceId: "local",
      projectId: project.id,
      createdBy: "local",
    });
    const runtime = store.registerRuntime({
      id: "rt_shared_workspace",
      name: "claude",
      provider: "claude",
      workspaceId: "local",
      daemonId: "daemon-shared-workspace",
      runtimeMode: "local",
      deviceInfo: "share-host · macOS (arm64)",
    });
    store.updateDaemonDisplayName("local", "daemon-shared-workspace", "Shared Mac", "local");
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: runtime.id,
      rootPath: `/tmp/${issue.key}`,
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const otherIssue = createResponsibleTestIssue(store, {
      title: "Unrelated confidential issue",
      workspaceId: "local",
      createdBy: "local",
    });
    store.createIssueComment(issue.id, {
      authorType: "member",
      authorId: "local",
      body: "A visible comment",
    });
    const session = store.createIssueSession(issue.id, {
      title: "Delivery",
      createdByType: "member",
      createdById: "local",
    });
    store.appendSessionEvent(session.id, {
      authorType: "member",
      authorId: "local",
      kind: "message",
      body: "A visible session event",
    });
    const agent = store.createAgent({ name: "Delivery Agent", provider: "claude", workspaceId: "local", visibility: "private", ownerId: "local" });
    const task = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      issueSessionId: session.id,
      workspaceId: "local",
      prompt: "Deliver the plan",
    });
    store.appendTaskMessages(task.id, [{ type: "assistant", content: "A visible task message" }]);
    traceStore.append(task.id, [messageEvent("msg:visible", "A visible task message")]);
    store.markTaskTraceDaemon(task.id, runtime.id);
    store.publishSessionResult(session.id, {
      title: "Release result",
      body: "A visible published result",
      publishedByType: "member",
      publishedById: "local",
    });
    const attachment = store.createAttachment({
      workspaceId: "local",
      issueId: issue.id,
      uploaderType: "member",
      uploaderId: "local",
      filename: "plan.txt",
      url: "https://example.com/plan.txt",
      contentType: "text/plain",
      sizeBytes: 12,
    });
    const unrelatedAttachment = store.createAttachment({
      workspaceId: "local",
      issueId: otherIssue.id,
      uploaderType: "member",
      uploaderId: "local",
      filename: "secret.txt",
      url: "https://example.com/secret.txt",
      contentType: "text/plain",
      sizeBytes: 18,
    });

    expect((await app.request(`/api/issues/${issue.id}`, bearer(viewer.token))).status).toBe(404);

    const created = await app.request(`/api/issues/${issue.id}/share`, {
      method: "POST",
      ...bearer(owner.token),
    });
    expect(created.status).toBe(201);
    const { share } = await created.json();
    expect(share.token).toStartWith("shr_");
    const durationDays = (Date.parse(share.expires_at) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(durationDays).toBeGreaterThan(59.9);
    expect(durationDays).toBeLessThanOrEqual(60);

    const repeated = await app.request(`/api/issues/${issue.id}/share`, {
      method: "POST",
      ...bearer(owner.token),
    });
    expect((await repeated.json()).share.token).toBe(share.token);

    const viewed = await app.request(
      `/api/shares/${encodeURIComponent(share.token)}`,
      bearer(viewer.token),
    );
    expect(viewed.status).toBe(200);
    const bundle = await viewed.json();
    expect(bundle.issue).toMatchObject({
      id: issue.id,
      title: "Shared launch plan",
      description: "Everything visible on the issue page",
    });
    expect(bundle.project).toMatchObject({
      id: project.id,
      title: "Internal delivery project",
    });
    expect(bundle.project).not.toHaveProperty("instructions");
    expect(bundle.project).not.toHaveProperty("instructions_revision");
    expect(bundle.timeline.some((entry: { content?: string }) => entry.content === "A visible comment")).toBe(true);
    expect(bundle.sessions.some((item: { events: Array<{ body?: string }> }) => (
      item.events.some((event) => event.body === "A visible session event")
    ))).toBe(true);
    expect(bundle.sessions[0].tasks[0]).not.toHaveProperty("messages");
    expect(JSON.stringify(bundle)).not.toContain("A visible task message");
    const tracePath = `/api/shares/${encodeURIComponent(share.token)}/tasks/${task.id}/trace`;
    const sharedTrace = await app.request(tracePath, bearer(viewer.token));
    expect(sharedTrace.status).toBe(200);
    expect(await sharedTrace.json()).toMatchObject({ view: "turn", state: "ok", source: "daemon", items: [{ text: "A visible task message" }] });
    traceStore.append(task.id, [
      { type: "item.completed", item: bulkItem("cmd_a", "a".repeat(600_000)) },
      { type: "item.completed", item: bulkItem("cmd_b", "b".repeat(600_000)) },
    ]);
    for (const [path, credential] of [
      [tracePath, viewer.token],
      [turnApiPath(store, task.id, "/trace"), owner.token],
    ]) {
      const response = await app.request(path, bearer(credential));
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(await response.text())).toBeLessThanOrEqual(1024 * 1024 + 512);
    }
    // The share deliberately preserves today's private-agent bypass.
    expect((await app.request(turnApiPath(store, task.id, "/trace"), bearer(viewer.token))).status).toBe(404);
    expect((await app.request(tracePath)).status).toBe(401);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/tsk_unknown/trace`, bearer(viewer.token))).status).toBe(404);
    const foreignTask = store.createTask({ agentId: agent.id, issueId: otherIssue.id, workspaceId: "local", prompt: "foreign" });
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${foreignTask.id}/trace`, bearer(viewer.token))).status).toBe(404);
    const unscopedTask = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "unscoped" });
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${unscopedTask.id}/trace`, bearer(viewer.token))).status).toBe(200);
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET chat_session_id = 'chat_share_excluded' WHERE id = ?", [unscopedTask.id]);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${unscopedTask.id}/trace`, bearer(viewer.token))).status).toBe(404);
    const foreignSession = store.createIssueSession(otherIssue.id, { title: "Foreign session" });
    const wrongSessionTask = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "wrong session" });
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET issue_session_id = ? WHERE id = ?", [foreignSession.id, wrongSessionTask.id]);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}/tasks/${wrongSessionTask.id}/trace`, bearer(viewer.token))).status).toBe(404);
    const shareId = store.getActiveIssueShare(issue.id)!.id;
    db!.run("UPDATE multiremi_issue_shares SET expires_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", shareId]);
    expect((await app.request(tracePath, bearer(viewer.token))).status).toBe(404);
    db!.run("UPDATE multiremi_issue_shares SET expires_at = ? WHERE id = ?", [share.expires_at, shareId]);
    expect(bundle.session_results[0].body).toBe("A visible published result");
    expect(bundle.issue_workspace).toMatchObject({
      runtime_id: runtime.id,
      runtime_name: "claude",
      runtime_provider: "claude",
      runtime_mode: "local",
      runtime_device_info: "share-host · macOS (arm64)",
      runtime_daemon_id: "daemon-shared-workspace",
      runtime_machine_name: "Shared Mac",
    });
    expect(bundle.issue.attachments[0].url).toContain(`/api/shares/${encodeURIComponent(share.token)}/attachments/${attachment.id}/content`);
    expect(JSON.stringify(bundle)).not.toContain(otherIssue.title);
    expect(JSON.stringify(bundle)).not.toContain("viewer@feishu.local");
    expect(JSON.stringify(bundle)).not.toContain("INTERNAL_AGENT_RULE_DO_NOT_SHARE");

    const unrelatedFile = await app.request(
      `/api/shares/${encodeURIComponent(share.token)}/attachments/${unrelatedAttachment.id}/content`,
      bearer(viewer.token),
    );
    expect(unrelatedFile.status).toBe(404);

    const tampered = share.token.slice(0, -1) + (share.token.endsWith("a") ? "b" : "a");
    expect((await app.request(`/api/shares/${encodeURIComponent(tampered)}`, bearer(viewer.token))).status).toBe(404);
    expect((await app.request(`/api/shares/${encodeURIComponent(tampered)}/tasks/${task.id}/trace`, bearer(viewer.token))).status).toBe(404);

    const viewerRevoke = await app.request(`/api/issues/${issue.id}/share`, {
      method: "DELETE",
      ...bearer(viewer.token),
    });
    expect(viewerRevoke.status).toBe(404);

    const revoked = await app.request(`/api/issues/${issue.id}/share`, {
      method: "DELETE",
      ...bearer(owner.token),
    });
    expect(revoked.status).toBe(204);
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}`, bearer(viewer.token))).status).toBe(404);
    expect((await app.request(tracePath, bearer(viewer.token))).status).toBe(404);
  });

  it("requires a logged-in user even when the share token is valid", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({
      store,
      authToken: "root-secret",
      shareSecret: "test-share-secret",
    });
    const issue = createResponsibleTestIssue(store, { title: "Login gate", workspaceId: "local", createdBy: "local" });
    const owner = await store.createAccessToken({
      name: "Owner session",
      workspaceId: "local",
      userId: "local",
      type: "pat",
      purpose: "session",
    });
    const created = await app.request(`/api/issues/${issue.id}/share`, {
      method: "POST",
      ...bearer(owner.token),
    });
    const { share } = await created.json();
    expect((await app.request(`/api/shares/${encodeURIComponent(share.token)}`)).status).toBe(401);
    expect((await app.request(
      `/api/shares/${encodeURIComponent(share.token)}`,
      bearer("root-secret"),
    )).status).toBe(401);
  });
});
