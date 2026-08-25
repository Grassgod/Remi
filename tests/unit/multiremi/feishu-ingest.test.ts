import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { FeishuIngestScheduler } from "@multiremi/feishu-ingest/scheduler.js";
import { feishuIngestionStore } from "@multiremi/feishu-ingest/store.js";
import { PersonalAutomationFeishuAdapter } from "@multiremi/feishu-ingest/personal-automation.js";
import type { FeishuPollContext, FeishuPollPage, FeishuSourceAdapter } from "@multiremi/feishu-ingest/types.js";
import type { IngestedFeishuMessageInput } from "@multiremi/store/repos/feishu-ingest-repo.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Feishu message ingestion", () => {
  it("defaults to zero ingestion and keeps an auditable multi-outcome ledger", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      workspaceId: "local",
      endpoint: "http://127.0.0.1:8042",
    });
    expect(source.allowlist).toEqual([]);
    expect(source.retentionDays).toBe(90);
    expect(() => store.createFeishuSource({ endpoint: "http://10.0.0.1:8042" }))
      .toThrow("must use a loopback host");

    const configured = store.updateFeishuSource(source.id, {
      allowlist: [{ chatId: "oc_allowed1", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const allowed = message("om_allowed", "oc_allowed1", "2026-08-25T10:01:00.000Z", "first");
    const blocked = message("om_blocked", "oc_blocked1", "2026-08-25T10:01:00.000Z", "private");

    expect(store.ingestFeishuBatch(configured.id, [allowed, blocked])).toMatchObject({
      inserted: 1,
      updated: 0,
      unchanged: 1,
      eventId: expect.any(String),
    });
    expect(store.ingestFeishuBatch(configured.id, [allowed, blocked])).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
      eventId: null,
    });
    expect(store.getFeishuMessage("om_blocked")).toBeNull();

    const edited = { ...allowed, searchableText: "edited", contentFingerprint: "fingerprint-edited" };
    expect(store.ingestFeishuBatch(configured.id, [edited])).toMatchObject({ updated: 1 });
    expect(store.getFeishuMessage(allowed.messageId)).toMatchObject({ edited: true, searchableText: "edited" });
    expect(() => store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "ignored",
    })).toThrow("reason is required");
    expect(() => store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "issue_created",
    })).toThrow("ref is required");

    const ignored = store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "ignored",
      reason: "casual conversation",
    });
    expect(ignored.message.processedAt).toBeString();
    store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "issue_created",
      ref: "issue:MUL-999",
    });
    const outcomeKinds = store.listFeishuMessageOutcomes(allowed.messageId).map((entry) => entry.outcomeKind);
    expect(outcomeKinds).toHaveLength(2);
    expect(outcomeKinds).toEqual(expect.arrayContaining(["ignored", "issue_created"]));
    expect(store.listFeishuMessages({ workspaceId: "local", unprocessed: true })).toEqual([]);
  });

  it("polls with checkpoint overlap and deduplicates repeated pages", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpoint: "http://127.0.0.1:8042",
      pollIntervalSeconds: 3,
      allowlist: [{ chatId: "oc_overlap1", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const adapter = new RecordingAdapter([
      message("om_overlap", "oc_overlap1", "2026-08-25T10:01:00.000Z", "hello"),
    ]);
    let current = new Date("2026-08-25T10:10:00.000Z");
    const scheduler = new FeishuIngestScheduler({
      store: feishuIngestionStore(store),
      adapters: [adapter],
      now: () => current,
    });

    expect(await scheduler.runOnce(current)).toMatchObject({ inserted: 1, eventsCreated: 1, completed: 1 });
    expect(adapter.calls[0]).toMatchObject({
      start: "2026-08-25T09:58:00.000Z",
      end: "2026-08-25T10:10:00.000Z",
    });
    expect(store.getFeishuSyncCursor(source.id, "messages")?.watermark).toBe("2026-08-25T10:10:00.000Z");

    current = new Date("2026-08-25T10:15:00.000Z");
    expect(await scheduler.runOnce(current)).toMatchObject({ inserted: 0, eventsCreated: 0, completed: 1 });
    expect(adapter.calls[1]).toMatchObject({
      start: "2026-08-25T10:08:00.000Z",
      end: "2026-08-25T10:15:00.000Z",
    });
    expect(store.listFeishuMessages({ workspaceId: "local" })).toHaveLength(1);
  });

  it("filters by activation watermark and retries transient sidecar failures", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpoint: "http://127.0.0.1:8042",
      allowlist: [{ chatId: "oc_adapter1", addedAt: "2026-08-25T10:00:30.000Z" }],
    });
    const requestBodies: Record<string, unknown>[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return Response.json({
        ok: true,
        data: {
          messages: [
            { message_id: "om_before", chat_id: "oc_adapter1", text: "before", create_time: "2026-08-25T10:00:59.000Z" },
            { message_id: "om_after", chat_id: "oc_adapter1", text: "after", create_time: "2026-08-25T10:01:00.000Z", sender: { id: "ou_sender" } },
            { message_id: "om_other", chat_id: "oc_other1", text: "other", create_time: "2026-08-25T10:02:00.000Z" },
          ],
          next_page_token: "",
        },
      });
    }) as typeof fetch;
    const adapter = new PersonalAutomationFeishuAdapter({
      fetch: fetchFn,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const page = await adapter.poll({
      source,
      cursor: null,
      start: new Date("2026-08-25T09:58:00.000Z"),
      end: new Date("2026-08-25T10:05:00.000Z"),
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([250]);
    expect(requestBodies[1]).toMatchObject({
      version: "v1",
      action: "message.search",
      input: { chat_ids: ["oc_adapter1"], page_limit: 10 },
    });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      messageId: "om_after",
      searchableText: "after",
      sender: { id: "ou_sender" },
    });
  });

  it("dispatches Feishu ingest events to the configured fixed Issue only", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Message watcher", provider: "codex" });
    const issue = store.createIssue({ title: "Feishu duty" });
    const source = store.createFeishuSource({
      endpoint: "http://127.0.0.1:8042",
      allowlist: [{ chatId: "oc_event1", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const autopilot = store.createAutopilot({
      title: "Process Feishu messages",
      description: "Read and resolve every unprocessed Feishu message",
      assigneeId: agent.id,
      executionMode: "trigger_issue",
    });
    const trigger = store.createAutopilotTrigger(autopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "feishu_source",
        event: "messages_ingested",
        sourceIds: [source.id],
        triggerIssueId: issue.id,
      },
    });
    store.ingestFeishuBatch(source.id, [
      message("om_event", "oc_event1", "2026-08-25T10:01:00.000Z", "action needed"),
    ]);

    const [run] = store.dispatchPendingSystemEvents();
    expect(run).toMatchObject({
      autopilotId: autopilot.id,
      triggerId: trigger.id,
      source: "system_event",
      issueId: issue.id,
      status: "running",
    });
    expect(store.getTask(run!.taskId!)?.prompt).toBe("Read and resolve every unprocessed Feishu message");
  });

  it("runs API ingest, task-scoped list, and transactional resolve end to end", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const create = await app.request("/api/workspaces/local/feishu/sources", {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "http://127.0.0.1:8042",
        allowlist: [{ chatId: "oc_api001", addedAt: "2026-08-25T10:00:00.000Z" }],
      }),
    });
    expect(create.status).toBe(201);
    const source = (await create.json()).source;
    store.ingestFeishuBatch(source.id, [
      message("om_api", "oc_api001", "2026-08-25T10:01:00.000Z", "hello API"),
    ]);

    const agent = store.createAgent({ name: "API watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "process messages" });
    const taskCredential = await store.createAccessToken({
      name: "Feishu test task",
      type: "task",
      purpose: "task",
      workspaceId: "local",
      taskId: task.id,
      agentId: agent.id,
    });
    const headers = { Authorization: `Bearer ${taskCredential.token}` };
    const list = await app.request("/api/workspaces/local/feishu/messages?unprocessed=true", { headers });
    expect(list.status).toBe(200);
    expect((await list.json()).messages).toEqual([expect.objectContaining({ messageId: "om_api" })]);

    const resolve = await app.request("/api/workspaces/local/feishu/messages/om_api/resolve", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "ignored", reason: "test noise", task_id: "tsk_spoofed" }),
    });
    expect(resolve.status).toBe(200);
    expect((await resolve.json()).outcome).toMatchObject({ outcomeKind: "ignored", taskId: task.id });
    expect(store.listFeishuMessages({ workspaceId: "local", unprocessed: true })).toEqual([]);

    const forbidden = await app.request(`/api/workspaces/local/feishu/sources/${source.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(forbidden.status).toBe(403);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_feishu_message_outcomes").get()).toEqual({ count: 1 });
  });
});

class RecordingAdapter implements FeishuSourceAdapter {
  readonly type = "personal_automation" as const;
  readonly calls: Array<{ start: string; end: string; cursor: Record<string, unknown> | null }> = [];

  constructor(private readonly messages: IngestedFeishuMessageInput[]) {}

  async poll(context: FeishuPollContext): Promise<FeishuPollPage> {
    this.calls.push({
      start: context.start.toISOString(),
      end: context.end.toISOString(),
      cursor: context.cursor,
    });
    return { messages: this.messages, cursor: null, done: true };
  }
}

function message(
  messageId: string,
  chatId: string,
  createdAt: string,
  text: string,
): IngestedFeishuMessageInput {
  return {
    messageId,
    chatId,
    sender: { id: "ou_sender" },
    content: { message_id: messageId, chat_id: chatId, text, create_time: createdAt },
    searchableText: text,
    contentFingerprint: `fingerprint:${messageId}:${text}`,
    createdAt,
  };
}
