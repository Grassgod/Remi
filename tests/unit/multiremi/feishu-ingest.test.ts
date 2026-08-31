import { afterEach, describe, expect, it } from "bun:test";
import { FeishuIngestScheduler } from "@multiremi/feishu-ingest/scheduler.js";
import { feishuIngestionStore } from "@multiremi/feishu-ingest/store.js";
import { PersonalAutomationFeishuAdapter } from "@multiremi/feishu-ingest/personal-automation.js";
import { feishuSidecarEndpointsFromEnv } from "@multiremi/feishu-ingest/endpoints.js";
import type { FeishuPollContext, FeishuPollPage, FeishuSourceAdapter } from "@multiremi/feishu-ingest/types.js";
import type { IngestedFeishuMessageInput } from "@multiremi/store/repos/feishu-ingest-repo.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const sidecarEndpoints = feishuSidecarEndpointsFromEnv("local=http://127.0.0.1:8042");

/**
 * The legacy sidecar ingestion engine, which no HTTP route reaches any more:
 * `/feishu` is served by the Messaging Core and covered in feishu-compat.test.ts.
 * What is left here guards the old engine until it is removed.
 */
describe("Feishu message ingestion", () => {
  it("defaults to zero ingestion and keeps an auditable multi-outcome ledger", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      workspaceId: "local",
      endpointName: "local",
    });
    expect(source.allowlist).toEqual([]);
    expect(source.retentionDays).toBe(90);
    expect(() => feishuSidecarEndpointsFromEnv("broken=http://user:secret@sidecar:8042"))
      .toThrow("must not contain credentials");

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
    })).toThrow("dedicated Feishu command");
    expect(() => store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "notified",
      ref: "inbox:fake",
    })).toThrow("dedicated Feishu command");
    expect(() => store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "ignored",
      ref: "issue:fake",
      reason: "forged ref",
    })).toThrow("assigned only by dedicated Feishu outcome commands");

    const ignored = store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "ignored",
      reason: "casual conversation",
    });
    expect(ignored.message.processedAt).toBeString();
    const dismissed = store.resolveFeishuMessage(allowed.messageId, {
      workspaceId: "local",
      outcome: "dismissed",
      reason: "superseded",
    });
    expect(dismissed.outcome.reason).toBe("superseded");
    const outcomeKinds = store.listFeishuMessageOutcomes(allowed.messageId).map((entry) => entry.outcomeKind);
    expect(outcomeKinds).toHaveLength(2);
    expect(outcomeKinds).toEqual(expect.arrayContaining(["ignored", "dismissed"]));
    expect(store.listFeishuMessages({ workspaceId: "local", unprocessed: true })).toEqual([]);
  });

  it("polls with checkpoint overlap and deduplicates repeated pages", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpointName: "local",
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
      sidecarEndpoints,
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
      endpointName: "local",
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
      endpoint: "http://127.0.0.1:8042",
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
      endpointName: "local",
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

  it("retries stale unresolved messages and forces a terminal timeout outcome", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpointName: "local",
      enabled: false,
      unprocessedRetrySeconds: 60,
      unprocessedRetryLimit: 3,
      allowlist: [{ chatId: "oc_retry001", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    store.ingestFeishuBatch(source.id, [
      message("om_retry", "oc_retry001", "2026-08-25T10:01:00.000Z", "needs outcome"),
    ]);
    db!.run(
      "UPDATE multiremi_feishu_messages SET ingested_at = ? WHERE message_id = ?",
      ["2026-08-25T10:05:00.000Z", "om_retry"],
    );
    let current = new Date("2026-08-25T10:06:00.000Z");
    const scheduler = new FeishuIngestScheduler({
      store: feishuIngestionStore(store),
      sidecarEndpoints,
      now: () => current,
    });

    for (let retry = 1; retry <= 3; retry += 1) {
      const result = await scheduler.runOnce(current);
      expect(result).toMatchObject({ retried: 1, dismissed: 0 });
      expect(store.getFeishuMessage("om_retry")).toMatchObject({ retryCount: retry, processedAt: null });
      current = new Date(current.getTime() + 60_000);
    }
    const terminal = await scheduler.runOnce(current);
    expect(terminal).toMatchObject({ retried: 0, dismissed: 1 });
    expect(store.getFeishuMessage("om_retry")?.processedAt).toBeString();
    expect(store.listFeishuMessageOutcomes("om_retry")).toEqual([
      expect.objectContaining({ outcomeKind: "dismissed", reason: "unprocessed_timeout", taskId: null }),
    ]);
    expect(store.getFeishuSourceStatus(source.id)).toMatchObject({
      sourceId: source.id,
      unprocessedCount: 0,
      timedOutCount: 1,
      oldestUnprocessedAt: null,
      maximumRetryCount: 0,
    });
  });

  it("reports connection lag and sends one alert per failure episode", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateNotificationPreferences({ preferences: { updates: "muted" } });
    const source = store.createFeishuSource({
      endpointName: "local",
      pollIntervalSeconds: 3,
      allowlist: [{ chatId: "oc_health01", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const adapter = new SequencedAdapter([
      new Error("secret-shaped transport failure"),
      new Error("second transport failure"),
      new Error("third transport failure"),
      new Error("fourth transport failure"),
      { messages: [], cursor: null, done: true },
    ]);
    let current = new Date("2026-08-25T10:10:00.000Z");
    const scheduler = new FeishuIngestScheduler({
      store: feishuIngestionStore(store),
      adapters: [adapter],
      sidecarEndpoints,
      now: () => current,
    });

    for (let failure = 1; failure <= 4; failure += 1) {
      expect(await scheduler.runOnce(current)).toMatchObject({ attempted: 1, failed: 1 });
      expect(store.getFeishuSourceStatus(source.id, current)).toMatchObject({
        sourceId: source.id,
        lastSuccessfulIngestAt: null,
        lastErrorCode: "ingest_failed",
        lastErrorAt: current.toISOString(),
        lagSeconds: null,
        consecutiveFailures: failure,
        connectionAlertedAt: failure >= 3 ? expect.any(String) : null,
      });
      current = new Date(current.getTime() + 60_000);
    }
    const alerts = store.listInboxItems().filter((item) => item.type === "feishu_ingest_connection_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "attention",
      details: { source_id: source.id, error_code: "ingest_failed", consecutive_failures: 3 },
    });
    expect(JSON.stringify(alerts[0])).not.toContain("secret-shaped");

    expect(await scheduler.runOnce(current)).toMatchObject({ completed: 1, failed: 0 });
    expect(store.getFeishuSourceStatus(source.id, current)).toMatchObject({
      lastSuccessfulIngestAt: current.toISOString(),
      lastErrorCode: "ingest_failed",
      lagSeconds: 0,
      consecutiveFailures: 0,
      connectionAlertedAt: null,
    });
  });

  it("delivers connection alerts through member-level system notification muting", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const owner = store.listWorkspaceMembers("local").find((member) => member.role === "owner")!;
    store.updateNotificationPreferences({
      workspaceId: "local",
      memberId: owner.id,
      preferences: { system_notifications: "muted" },
    });
    const source = store.createFeishuSource({
      endpointName: "local",
      allowlist: [{ chatId: "oc_alertmember", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const context = (store as unknown as { ctx: StoreContext }).ctx;
    expect(context.createInboxItem({
      workspaceId: "local",
      memberId: owner.id,
      type: "system_test_notification",
      title: "Ordinary system notification",
    })).toBeNull();

    for (let failure = 0; failure < 4; failure += 1) {
      store.recordFeishuConnectionFailure(
        source.id,
        "ingest_failed",
        new Date(Date.UTC(2026, 7, 25, 13, failure)).toISOString(),
      );
    }

    expect(store.listInboxItems(owner.id).filter((item) => item.type === "feishu_ingest_connection_alert"))
      .toHaveLength(1);
    expect(store.getFeishuSourceStatus(source.id)).toMatchObject({
      connectionAlertedAt: expect.any(String),
      connectionAlertDeliveryFailureCount: 0,
      connectionAlertDeliveryErrorCode: null,
      connectionAlertDeliveryFailedAt: null,
    });

    store.recordFeishuConnectionSuccess(source.id, "2026-08-25T13:05:00.000Z");
    for (let failure = 0; failure < 3; failure += 1) {
      store.recordFeishuConnectionFailure(
        source.id,
        "ingest_failed",
        new Date(Date.UTC(2026, 7, 25, 14, failure)).toISOString(),
      );
    }
    expect(store.listInboxItems(owner.id).filter((item) => item.type === "feishu_ingest_connection_alert"))
      .toHaveLength(2);
  });

  it("delivers connection alerts through workspace-level system notification muting", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const owner = store.listWorkspaceMembers("local").find((member) => member.role === "owner")!;
    store.updateNotificationPreferences({
      workspaceId: "local",
      preferences: { system_notifications: "muted" },
    });
    const source = store.createFeishuSource({
      endpointName: "local",
      allowlist: [{ chatId: "oc_alertworkspace", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const context = (store as unknown as { ctx: StoreContext }).ctx;
    expect(context.createInboxItem({
      workspaceId: "local",
      memberId: owner.id,
      type: "system_test_notification",
      title: "Ordinary system notification",
    })).toBeNull();

    for (let failure = 0; failure < 3; failure += 1) {
      store.recordFeishuConnectionFailure(
        source.id,
        "ingest_failed",
        new Date(Date.UTC(2026, 7, 25, 15, failure)).toISOString(),
      );
    }

    expect(store.listInboxItems().filter((item) => item.type === "feishu_ingest_connection_alert"))
      .toHaveLength(1);
    expect(store.getFeishuSourceStatus(source.id).connectionAlertedAt).toBeString();
  });

  it("records and sanitizes connection alert delivery failures when no recipient exists", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpointName: "local",
      name: "Sensitive source label",
      allowlist: [{ chatId: "oc_alertmissing", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    db!.run(
      "UPDATE multiremi_workspace_members SET archived_at = ? WHERE workspace_id = ?",
      ["2026-08-25T16:00:00.000Z", "local"],
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      for (let failure = 0; failure < 4; failure += 1) {
        store.recordFeishuConnectionFailure(
          source.id,
          "secret-shaped transport failure",
          new Date(Date.UTC(2026, 7, 25, 16, failure)).toISOString(),
        );
      }
    } finally {
      console.warn = originalWarn;
    }

    expect(store.listInboxItems().filter((item) => item.type === "feishu_ingest_connection_alert"))
      .toHaveLength(0);
    expect(store.getFeishuSourceStatus(source.id)).toMatchObject({
      consecutiveFailures: 4,
      connectionAlertedAt: null,
      connectionAlertDeliveryFailureCount: 2,
      connectionAlertDeliveryErrorCode: "alert_recipient_unavailable",
      connectionAlertDeliveryFailedAt: "2026-08-25T16:03:00.000Z",
    });
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning).toContain(source.id);
      expect(warning).toContain("alert_recipient_unavailable");
      expect(warning).not.toContain("Sensitive source label");
      expect(warning).not.toContain("secret-shaped");
    }

    db!.run(
      "UPDATE multiremi_workspace_members SET archived_at = NULL WHERE workspace_id = ?",
      ["local"],
    );
    store.recordFeishuConnectionFailure(source.id, "ingest_failed", "2026-08-25T16:04:00.000Z");
    expect(store.listInboxItems().filter((item) => item.type === "feishu_ingest_connection_alert"))
      .toHaveLength(1);
    expect(store.getFeishuSourceStatus(source.id)).toMatchObject({
      connectionAlertedAt: "2026-08-25T16:04:00.000Z",
      connectionAlertDeliveryFailureCount: 2,
      connectionAlertDeliveryErrorCode: null,
      connectionAlertDeliveryFailedAt: null,
    });
  });

  it("resumes a fixed multi-page window after max-pages and a persistent failure", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpointName: "local",
      pollIntervalSeconds: 3,
      allowlist: [{ chatId: "oc_pages001", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const adapter = new SequencedAdapter([
      {
        messages: [message("om_page", "oc_pages001", "2026-08-25T10:01:00.000Z", "page one")],
        cursor: { pageToken: "next" },
        done: false,
      },
      new Error("persistent outage"),
      { messages: [], cursor: null, done: true },
    ]);
    let current = new Date("2026-08-25T10:10:00.000Z");
    const scheduler = new FeishuIngestScheduler({
      store: feishuIngestionStore(store),
      adapters: [adapter],
      sidecarEndpoints,
      maxPagesPerSource: 1,
      now: () => current,
    });

    expect(await scheduler.runOnce(current)).toMatchObject({ inserted: 1, completed: 0, failed: 0 });
    expect(store.getFeishuSyncCursor(source.id, "messages")).toMatchObject({ watermark: null });
    current = new Date("2026-08-25T10:11:00.000Z");
    expect(await scheduler.runOnce(current)).toMatchObject({ failed: 1 });
    expect(store.getFeishuSyncCursor(source.id, "messages")).toMatchObject({ watermark: null });
    current = new Date("2026-08-25T10:12:00.000Z");
    expect(await scheduler.runOnce(current)).toMatchObject({ completed: 1, failed: 0 });
    expect(adapter.calls.slice(1).map((call) => call.cursor)).toEqual([
      { pageToken: "next" },
      { pageToken: "next" },
    ]);
    expect(adapter.calls.map((call) => call.end)).toEqual([
      "2026-08-25T10:10:00.000Z",
      "2026-08-25T10:10:00.000Z",
      "2026-08-25T10:10:00.000Z",
    ]);
    expect(store.getFeishuSyncCursor(source.id, "messages")?.watermark).toBe("2026-08-25T10:10:00.000Z");
  });

  it("fences concurrent schedulers and cascades retained message outcomes", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpointName: "local",
      retentionDays: 1,
      allowlist: [{ chatId: "oc_lease001", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    const blocking = new BlockingAdapter();
    const competing = new RecordingAdapter([]);
    const now = new Date("2026-08-25T10:10:00.000Z");
    const firstScheduler = new FeishuIngestScheduler({
      store: feishuIngestionStore(store),
      adapters: [blocking],
      sidecarEndpoints,
      leaseOwner: "first",
      now: () => now,
    });
    const secondScheduler = new FeishuIngestScheduler({
      store: feishuIngestionStore(store),
      adapters: [competing],
      sidecarEndpoints,
      leaseOwner: "second",
      now: () => now,
    });
    const firstRun = firstScheduler.runOnce(now);
    await blocking.started;
    expect(await secondScheduler.runOnce(now)).toMatchObject({ attempted: 0, skipped: 1 });
    expect(competing.calls).toHaveLength(0);
    blocking.release();
    await firstRun;

    store.ingestFeishuBatch(source.id, [
      message("om_expired", "oc_lease001", "2026-08-25T10:11:00.000Z", "old"),
    ]);
    store.resolveFeishuMessage("om_expired", {
      workspaceId: "local",
      outcome: "ignored",
      reason: "expired fixture",
    });
    db!.run(
      "UPDATE multiremi_feishu_messages SET ingested_at = ? WHERE message_id = ?",
      ["2026-08-20T10:00:00.000Z", "om_expired"],
    );
    expect(store.deleteExpiredFeishuMessages(new Date("2026-08-25T10:12:00.000Z"))).toBe(1);
    expect(store.getFeishuMessage("om_expired")).toBeNull();
    expect(store.listFeishuMessageOutcomes("om_expired")).toEqual([]);
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

class SequencedAdapter implements FeishuSourceAdapter {
  readonly type = "personal_automation" as const;
  readonly calls: Array<{ start: string; end: string; cursor: Record<string, unknown> | null }> = [];

  constructor(private readonly results: Array<FeishuPollPage | Error>) {}

  async poll(context: FeishuPollContext): Promise<FeishuPollPage> {
    this.calls.push({
      start: context.start.toISOString(),
      end: context.end.toISOString(),
      cursor: context.cursor,
    });
    const result = this.results.shift();
    if (!result) throw new Error("missing adapter fixture");
    if (result instanceof Error) throw result;
    return result;
  }
}

class BlockingAdapter implements FeishuSourceAdapter {
  readonly type = "personal_automation" as const;
  readonly started: Promise<void>;
  private readonly releasePromise: Promise<void>;
  private start!: () => void;
  private unblock!: () => void;

  constructor() {
    this.started = new Promise((resolve) => { this.start = resolve; });
    this.releasePromise = new Promise((resolve) => { this.unblock = resolve; });
  }

  release(): void {
    this.unblock();
  }

  async poll(): Promise<FeishuPollPage> {
    this.start();
    await this.releasePromise;
    return { messages: [], cursor: null, done: true };
  }
}

function message(
  messageId: string,
  chatId: string,
  createdAt: string,
  text: string,
  chatName?: string,
): IngestedFeishuMessageInput {
  return {
    messageId,
    chatId,
    ...(chatName === undefined ? {} : { chatName }),
    sender: { id: "ou_sender" },
    content: { message_id: messageId, chat_id: chatId, text, create_time: createdAt },
    searchableText: text,
    contentFingerprint: `fingerprint:${messageId}:${text}`,
    createdAt,
  };
}
