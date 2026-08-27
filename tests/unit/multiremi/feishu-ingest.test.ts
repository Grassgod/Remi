import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
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

  it("runs API ingest, task-scoped list, and transactional resolve end to end", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const unconfiguredApp = createMultiremiApp({
      store,
      authToken: "root-secret",
      feishuSidecarEndpoints: feishuSidecarEndpointsFromEnv(""),
    });
    const rejected = await unconfiguredApp.request("/api/workspaces/local/feishu/sources", {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint_name: "local" }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "Feishu sidecar endpoint_name is not configured by the server" });

    const app = createMultiremiApp({ store, authToken: "root-secret", feishuSidecarEndpoints: sidecarEndpoints });
    const create = await app.request("/api/workspaces/local/feishu/sources", {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint_name: "local",
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
    const status = await app.request(`/api/workspaces/local/feishu/sources/${source.id}/status`, { headers });
    expect(status.status).toBe(200);
    expect((await status.json()).status).toMatchObject({
      sourceId: source.id,
      unprocessedCount: 1,
      connectionAlertDeliveryFailureCount: 0,
      connectionAlertDeliveryErrorCode: null,
      connectionAlertDeliveryFailedAt: null,
    });

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

  it("creates real Inbox reminders and drafts while rejecting forged outcome references", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    // Legacy preference JSON has no feishu_messages key. Muting the old
    // catch-all group must not mute Feishu deliveries.
    store.updateNotificationPreferences({ preferences: { updates: "muted" } });
    const source = store.createFeishuSource({
      endpointName: "local",
      allowlist: [{ chatId: "oc_inbox01", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    store.ingestFeishuBatch(source.id, [
      message("om_notify", "oc_inbox01", "2026-08-25T10:01:00.000Z", "notice"),
      message("om_draft", "oc_inbox01", "2026-08-25T10:02:00.000Z", "question"),
      message("om_issue", "oc_inbox01", "2026-08-25T10:03:00.000Z", "work"),
      message("om_no_recipient", "oc_inbox01", "2026-08-25T10:04:00.000Z", "orphan"),
    ]);
    const agent = store.createAgent({ name: "Inbox watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "process messages" });
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
    const humanHeaders = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
    const app = createMultiremiApp({ store, authToken: "root-secret", feishuSidecarEndpoints: sidecarEndpoints });

    const notification = await app.request("/api/workspaces/local/feishu/messages/om_notify/notify", {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "Deployment window changed" }),
    });
    expect(notification.status).toBe(201);
    const notificationBody = await notification.json();
    expect(notificationBody.delivered).toBe(true);
    expect(notificationBody.outcome).toMatchObject({
      outcomeKind: "notified",
      ref: `inbox:${notificationBody.inboxItem.id}`,
      taskId: task.id,
    });
    expect(notificationBody.inboxItem).toMatchObject({
      type: "feishu_message_notification",
      body: "Deployment window changed",
      details: { message_id: "om_notify", outcome_kind: "notified" },
    });

    const draft = await app.request("/api/workspaces/local/feishu/messages/om_draft/draft-reply", {
      method: "POST",
      headers,
      body: JSON.stringify({ draft_text: "I will check and reply today." }),
    });
    expect(draft.status).toBe(201);
    const draftBody = await draft.json();
    expect(draftBody.delivered).toBe(true);
    expect(draftBody.outcome).toMatchObject({
      outcomeKind: "reply_drafted",
      ref: `inbox:${draftBody.inboxItem.id}`,
    });
    expect(draftBody.inboxItem).toMatchObject({ type: "feishu_reply_draft", severity: "attention" });

    const forgedNotification = await app.request("/api/workspaces/local/feishu/messages/om_issue/resolve", {
      method: "POST",
      headers,
      body: JSON.stringify({ outcome: "notified", ref: "inbox:fake" }),
    });
    expect(forgedNotification.status).toBe(400);
    const forgedIssue = await app.request("/api/workspaces/local/feishu/messages/om_issue/resolve", {
      method: "POST",
      headers,
      body: JSON.stringify({ outcome: "issue_created", ref: "issue:MUL-404" }),
    });
    expect(forgedIssue.status).toBe(400);
    expect(store.listFeishuMessageOutcomes("om_issue")).toEqual([]);

    const linkedIssue = await app.request("/api/workspaces/local/feishu/messages/om_issue/create-issue", {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ title: "Real Feishu follow-up", description: "Created atomically" }),
    });
    expect(linkedIssue.status).toBe(201);
    const linkedIssueBody = await linkedIssue.json();
    expect(linkedIssueBody.outcome.ref).toBe(`issue:${linkedIssueBody.issue.id}`);
    expect(linkedIssueBody.issue.contextRefs).toEqual([
      expect.objectContaining({ type: "feishu_message", message_id: "om_issue" }),
    ]);
    const replayedIssue = await app.request("/api/workspaces/local/feishu/messages/om_issue/create-issue", {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ title: "This retry must not create a duplicate" }),
    });
    expect(replayedIssue.status).toBe(200);
    expect((await replayedIssue.json()).issue.id).toBe(linkedIssueBody.issue.id);
    expect(store.listIssues({ workspaceId: "local" }).filter((entry) => entry.title.includes("Feishu"))).toHaveLength(1);

    const inboxCountBefore = store.listInboxItems().length;
    expect(() => store.createFeishuInboxOutcome("om_no_recipient", "notified", {
      workspaceId: "local",
      recipientId: "missing-user",
      taskId: task.id,
      actorType: "agent",
      actorId: agent.id,
      text: "must roll back",
    })).toThrow("Inbox recipient is unavailable");
    expect(store.listFeishuMessageOutcomes("om_no_recipient")).toEqual([]);
    expect(store.listInboxItems()).toHaveLength(inboxCountBefore);
  });

  it("requires human approval for proposed Issues and keeps proposals auditable after Inbox removal", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const source = store.createFeishuSource({
      endpointName: "local",
      enabled: false,
      unprocessedRetrySeconds: 60,
      allowlist: [{ chatId: "oc_proposals", addedAt: "2026-08-26T08:00:00.000Z" }],
    });
    store.ingestFeishuBatch(source.id, [
      message("om_proposal_approve", "oc_proposals", "2026-08-26T08:01:00.000Z", "approve"),
      message("om_proposal_reject", "oc_proposals", "2026-08-26T08:02:00.000Z", "reject"),
      message("om_proposal_muted", "oc_proposals", "2026-08-26T08:03:00.000Z", "muted"),
    ]);
    const agent = store.createAgent({
      name: "Proposal watcher",
      provider: "codex",
      issueCreationRequiresProposal: true,
    });
    const task = store.createTask({ agentId: agent.id, prompt: "propose issues" });
    const credential = await store.createTaskAccessToken(task, "local");
    const taskHeaders = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
    const humanHeaders = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };
    const app = createMultiremiApp({ store, authToken: "root-secret", feishuSidecarEndpoints: sidecarEndpoints });

    const directCreate = await app.request(
      "/api/workspaces/local/feishu/messages/om_proposal_approve/create-issue",
      { method: "POST", headers: taskHeaders, body: JSON.stringify({ title: "Bypass approval" }) },
    );
    expect(directCreate.status).toBe(403);
    expect(await directCreate.json()).toMatchObject({ code: "human_approval_required" });
    const generalCreate = await app.request("/api/issues", {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ title: "Bypass through the general Issue API" }),
    });
    expect(generalCreate.status).toBe(403);
    expect(await generalCreate.json()).toMatchObject({ code: "issue_creation_requires_proposal" });
    const forgedProposal = await app.request(
      "/api/workspaces/local/feishu/messages/om_proposal_approve/resolve",
      {
        method: "POST",
        headers: taskHeaders,
        body: JSON.stringify({ outcome: "issue_proposed" }),
      },
    );
    expect(forgedProposal.status).toBe(400);

    const capturedLogs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };
    let proposed: Response;
    try {
      proposed = await app.request(
        "/api/workspaces/local/feishu/messages/om_proposal_approve/propose-issue",
        {
          method: "POST",
          headers: taskHeaders,
          body: JSON.stringify({
            title: "Human-reviewed follow-up",
            description: "SENSITIVE_PROPOSAL_BODY must never enter logs",
            priority: "high",
          }),
        },
      );
    } finally {
      console.log = originalLog;
    }
    expect(capturedLogs.join("\n")).not.toContain("SENSITIVE_PROPOSAL_BODY");
    expect(proposed.status).toBe(201);
    const proposedBody = await proposed.json();
    expect(proposedBody).toMatchObject({
      delivered: true,
      proposal: {
        messageId: "om_proposal_approve",
        status: "pending",
        issue: { title: "Human-reviewed follow-up", priority: "high" },
      },
      outcome: { outcomeKind: "issue_proposed", ref: `inbox:${proposedBody.inboxItem.id}` },
      inboxItem: {
        type: "feishu_issue_proposal",
        severity: "attention",
        details: { proposal_id: proposedBody.proposal.id, message_id: "om_proposal_approve" },
      },
    });
    expect(store.getFeishuMessage("om_proposal_approve")?.processedAt).toBeString();
    expect(store.getFeishuMessage("om_proposal_approve")?.retryCount).toBe(0);
    expect(store.getFeishuSourceStatus(source.id).pendingIssueProposalCount).toBe(1);
    expect(store.reconcileUnprocessedFeishuMessages(source.id, new Date("2030-08-26T10:00:00.000Z"))).toMatchObject({
      retried: 2,
      dismissed: 0,
    });

    store.archiveInboxItem(proposedBody.inboxItem.id);
    expect(store.getFeishuSourceStatus(source.id).pendingIssueProposalCount).toBe(1);
    db!.run("DELETE FROM multiremi_inbox_items WHERE id = ?", [proposedBody.inboxItem.id]);
    expect(store.getFeishuSourceStatus(source.id).pendingIssueProposalCount).toBe(1);

    for (const action of ["approve", "reject"]) {
      const denied = await app.request(
        `/api/workspaces/local/feishu/proposals/${proposedBody.proposal.id}/${action}`,
        { method: "POST", headers: taskHeaders },
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "human_approval_required" });
    }

    const approved = await app.request(
      `/api/workspaces/local/feishu/proposals/${proposedBody.proposal.id}/approve`,
      { method: "POST", headers: humanHeaders },
    );
    expect(approved.status).toBe(201);
    const approvedBody = await approved.json();
    expect(approvedBody).toMatchObject({
      created: true,
      proposal: { status: "approved" },
      outcome: { outcomeKind: "issue_created", ref: `issue:${approvedBody.issue.id}` },
      issue: { title: "Human-reviewed follow-up" },
    });
    const approvedAgain = await app.request(
      `/api/workspaces/local/feishu/proposals/${proposedBody.proposal.id}/approve`,
      { method: "POST", headers: humanHeaders },
    );
    expect(approvedAgain.status).toBe(200);
    expect(await approvedAgain.json()).toMatchObject({ created: false, issue: { id: approvedBody.issue.id } });
    expect(store.listIssues({ workspaceId: "local" }).filter((issue) => issue.id === approvedBody.issue.id)).toHaveLength(1);
    expect(store.getFeishuSourceStatus(source.id).pendingIssueProposalCount).toBe(0);

    const rejectedProposal = await app.request(
      "/api/workspaces/local/feishu/messages/om_proposal_reject/propose-issue",
      { method: "POST", headers: taskHeaders, body: JSON.stringify({ title: "Do not create this" }) },
    );
    expect(rejectedProposal.status).toBe(201);
    const rejectedProposalBody = await rejectedProposal.json();
    const rejected = await app.request(
      `/api/workspaces/local/feishu/proposals/${rejectedProposalBody.proposal.id}/reject`,
      { method: "POST", headers: humanHeaders },
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      created: true,
      issue: null,
      proposal: { status: "rejected" },
      outcome: { outcomeKind: "dismissed", reason: "proposal_rejected" },
    });
    const rejectedAgain = await app.request(
      `/api/workspaces/local/feishu/proposals/${rejectedProposalBody.proposal.id}/reject`,
      { method: "POST", headers: humanHeaders },
    );
    expect(await rejectedAgain.json()).toMatchObject({ created: false, proposal: { status: "rejected" } });
    expect(store.getFeishuSourceStatus(source.id).pendingIssueProposalCount).toBe(0);

    store.updateNotificationPreferences({ preferences: { feishu_messages: "muted" } });
    const muted = await app.request(
      "/api/workspaces/local/feishu/messages/om_proposal_muted/propose-issue",
      { method: "POST", headers: taskHeaders, body: JSON.stringify({ title: "Muted proposal" }) },
    );
    expect(muted.status).toBe(200);
    expect(await muted.json()).toMatchObject({
      delivered: false,
      proposal: null,
      inboxItem: null,
      outcome: { outcomeKind: "dismissed", reason: "recipient_muted" },
    });
    expect(store.getFeishuMessage("om_proposal_muted")?.processedAt).toBeString();
    expect(store.getFeishuSourceStatus(source.id)).toMatchObject({
      pendingIssueProposalCount: 0,
      mutedDeliveryCount: 1,
      timedOutCount: 0,
      unprocessedCount: 0,
    });
  });

  it("audits muted Feishu deliveries without suppressing connection alerts", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateNotificationPreferences({ preferences: { feishu_messages: "muted" } });
    const source = store.createFeishuSource({
      endpointName: "local",
      enabled: false,
      unprocessedRetrySeconds: 60,
      allowlist: [{ chatId: "oc_muted001", addedAt: "2026-08-25T10:00:00.000Z" }],
    });
    store.ingestFeishuBatch(source.id, [
      message("om_muted_notify", "oc_muted001", "2026-08-25T10:01:00.000Z", "notice"),
      message("om_muted_draft", "oc_muted001", "2026-08-25T10:02:00.000Z", "question"),
    ]);
    const agent = store.createAgent({ name: "Muted Inbox watcher", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "process muted messages" });
    const credential = await store.createTaskAccessToken(task, "local");
    const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
    const app = createMultiremiApp({ store, authToken: "root-secret", feishuSidecarEndpoints: sidecarEndpoints });

    const notification = await app.request("/api/workspaces/local/feishu/messages/om_muted_notify/notify", {
      method: "POST",
      headers,
      body: JSON.stringify({ summary: "This reminder is muted" }),
    });
    expect(notification.status).toBe(200);
    expect(await notification.json()).toMatchObject({
      delivered: false,
      inboxItem: null,
      outcome: { outcomeKind: "dismissed", reason: "recipient_muted", ref: null },
    });

    const draft = await app.request("/api/workspaces/local/feishu/messages/om_muted_draft/draft-reply", {
      method: "POST",
      headers,
      body: JSON.stringify({ draft_text: "This draft is muted" }),
    });
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({
      delivered: false,
      inboxItem: null,
      outcome: { outcomeKind: "dismissed", reason: "recipient_muted", ref: null },
    });

    expect(store.listInboxItems().filter((item) =>
      item.type === "feishu_message_notification" || item.type === "feishu_reply_draft"
    )).toEqual([]);
    expect(store.listFeishuMessages({ workspaceId: "local", unprocessed: true })).toEqual([]);
    expect(store.reconcileUnprocessedFeishuMessages(source.id, new Date("2026-08-25T12:00:00.000Z"))).toMatchObject({
      retried: 0,
      dismissed: 0,
    });
    expect(store.getFeishuSourceStatus(source.id)).toMatchObject({
      unprocessedCount: 0,
      timedOutCount: 0,
      mutedDeliveryCount: 2,
    });

    for (let failure = 0; failure < 3; failure += 1) {
      store.recordFeishuConnectionFailure(
        source.id,
        "ingest_failed",
        new Date(Date.UTC(2026, 7, 25, 12, failure)).toISOString(),
      );
    }
    expect(store.listInboxItems().filter((item) => item.type === "feishu_ingest_connection_alert")).toHaveLength(1);
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
