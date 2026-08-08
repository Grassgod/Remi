// Chat session/message routes, autopilot API + public webhook triggering,
// webhook rate limiting, and scheduler state sync.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — chat sessions and autopilot triggers", () => {
  it("serves chat session and message endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, title: "API chat" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const sent = await app.request(`/api/multiremi/chats/${createdBody.session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Hello" }),
    });
    expect(sent.status).toBe(201);
    const sentBody = await sent.json();
    expect(sentBody.task.chatSessionId).toBe(createdBody.session.id);

    const detail = await app.request(`/api/multiremi/chats/${createdBody.session.id}`);
    const detailBody = await detail.json();
    expect(detailBody.messages[0].body).toBe("Hello");

    expect(store.claimTask(runtime.id)?.id).toBe(sentBody.task.id);
    store.startTask(sentBody.task.id);
    store.completeTask(sentBody.task.id, { output: "Hi there", sessionId: "sess-chat" });
    const messages = await app.request(`/api/multiremi/chats/${createdBody.session.id}/messages`);
    expect((await messages.json()).messages.map((message: any) => message.role)).toEqual(["user", "assistant"]);
  });

  it("triggers autopilots through API and webhook endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({
      title: "Webhook triage",
      assigneeId: agent.id,
      triggerKind: "webhook",
    });
    const app = createMultiremiApp({ store });

    const apiTrigger = await app.request(`/api/multiremi/autopilots/${autopilot.id}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "API prompt", payload: { source: "suite" } }),
    });
    expect(apiTrigger.status).toBe(201);
    const apiBody = await apiTrigger.json();
    expect(apiBody.run.source).toBe("api");
    expect(store.getTask(apiBody.run.taskId)?.prompt).toBe("API prompt");

    const webhookTrigger = await app.request(`/api/multiremi/autopilots/${autopilot.id}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-delivery-1" },
      body: JSON.stringify({ prompt: "Webhook prompt", event: "opened" }),
    });
    expect(webhookTrigger.status).toBe(201);
    const webhookBody = await webhookTrigger.json();
    expect(webhookBody.status).toBe("accepted");
    expect(webhookBody.delivery.status).toBe("dispatched");
    expect(webhookBody.delivery.dedupeKey).toBe("api-delivery-1");
    expect(webhookBody.run.source).toBe("webhook");
    expect(webhookBody.run.payload.event).toBe("opened");
    expect(store.getIssue(webhookBody.run.issueId)?.title).toBe("Webhook prompt");

    const duplicate = await app.request(`/api/multiremi/autopilots/${autopilot.id}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "api-delivery-1" },
      body: JSON.stringify({ prompt: "Webhook duplicate" }),
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody.status).toBe("duplicate");
    expect(duplicateBody.deliveryId).toBe(webhookBody.deliveryId);

    const deliveries = await app.request(`/api/multiremi/autopilots/${autopilot.id}/deliveries`);
    const deliveriesBody = await deliveries.json();
    expect(deliveriesBody.total).toBe(1);
    expect(deliveriesBody.deliveries[0].attemptCount).toBe(2);

    const detail = await app.request(`/api/multiremi/autopilots/${autopilot.id}`);
    expect((await detail.json()).deliveries[0].id).toBe(webhookBody.deliveryId);

    const trigger = await app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "webhook",
        label: "Token webhook",
        event_filters: [{ event: "webhook", actions: ["received"] }],
      }),
    });
    const triggerBody = await trigger.json();
    expect(trigger.status).toBe(201);
    expect(triggerBody.webhook_token).toStartWith("awt_");
    expect(triggerBody.event_filters).toEqual([{ event: "webhook", actions: ["received"] }]);

    const emptyTokenWebhook = await app.request(triggerBody.webhook_path, { method: "POST" });
    expect(emptyTokenWebhook.status).toBe(400);
    expect(await emptyTokenWebhook.json()).toEqual({ error: "empty body" });

    const scalarTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("not an envelope"),
    });
    expect(scalarTokenWebhook.status).toBe(400);
    expect(await scalarTokenWebhook.json()).toEqual({ error: "body must be a JSON object or array" });

    const invalidTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidTokenWebhook.status).toBe(400);
    expect((await invalidTokenWebhook.json()).error).toStartWith("invalid json:");

    const largeTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(260 * 1024) }),
    });
    expect(largeTokenWebhook.status).toBe(413);
    expect(await largeTokenWebhook.json()).toEqual({ error: "payload too large" });

    const tokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-1" },
      body: JSON.stringify({ prompt: "Token webhook prompt", payload: { via: "token" } }),
    });
    const tokenWebhookBody = await tokenWebhook.json();
    expect(tokenWebhook.status).toBe(200);
    const tokenWebhookRunId = tokenWebhookBody.run_id;
    const tokenWebhookDeliveryId = tokenWebhookBody.delivery_id;
    expect(tokenWebhookBody).toMatchObject({
      status: "accepted",
      autopilot_id: autopilot.id,
      trigger_id: triggerBody.id,
      delivery_id: expect.any(String),
      run_id: expect.any(String),
    });
    expect(tokenWebhookBody.delivery).toBeUndefined();
    const tokenWebhookRun = store.getAutopilotRun(tokenWebhookRunId)!;
    expect(tokenWebhookRun.payload).toMatchObject({
      event: "webhook.received",
      eventPayload: { prompt: "Token webhook prompt", payload: { via: "token" } },
      request: { contentType: "application/json" },
    });

    const duplicateTokenWebhook = await app.request(triggerBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-1" },
      body: JSON.stringify({ prompt: "Token webhook duplicate" }),
    });
    expect(duplicateTokenWebhook.status).toBe(200);
    expect(await duplicateTokenWebhook.json()).toEqual({
      status: "duplicate",
      delivery_id: tokenWebhookDeliveryId,
      run_id: tokenWebhookRunId,
    });

    const githubTrigger = await app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "webhook",
        label: "GitHub webhook",
        provider: "github",
        event_filters: [{ event: "pull_request", actions: ["opened"] }],
      }),
    });
    expect(githubTrigger.status).toBe(201);
    const githubTriggerBody = await githubTrigger.json();
    const githubPayload = "\uFEFF" + JSON.stringify({ action: "opened", prompt: "GitHub token webhook", pull_request: { number: 42 } });
    const githubTokenWebhook = await app.request(githubTriggerBody.webhook_path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": "ignored-generic-key",
        "User-Agent": "GitHub-Hookshot/test",
        "X-GitHub-Delivery": "github-delivery-1",
        "X-GitHub-Event": "pull_request",
        "X-Hub-Signature-256": "sha256=not-used-without-secret",
      },
      body: githubPayload,
    });
    expect(githubTokenWebhook.status).toBe(200);
    const githubTokenWebhookBody = await githubTokenWebhook.json();
    const githubRunId = githubTokenWebhookBody.run_id;
    const githubDeliveryId = githubTokenWebhookBody.delivery_id;
    expect(githubTokenWebhookBody).toMatchObject({
      status: "accepted",
      autopilot_id: autopilot.id,
      trigger_id: githubTriggerBody.id,
      delivery_id: expect.any(String),
      run_id: expect.any(String),
    });
    const githubRun = store.getAutopilotRun(githubRunId)!;
    expect(githubRun.payload).toMatchObject({
      event: "github.pull_request.opened",
      eventPayload: { action: "opened", pull_request: { number: 42 } },
      request: { contentType: "application/json" },
    });
    const githubDelivery = store.getWebhookDelivery(githubDeliveryId)!;
    expect(githubDelivery.event).toBe("github.pull_request.opened");
    expect(githubDelivery.dedupeKey).toBe("github-delivery-1");
    expect(githubDelivery.dedupeSource).toBe("x-github-delivery");
    expect(githubDelivery.contentType).toBe("application/json");
    expect(githubDelivery.selectedHeaders).toEqual({
      "user-agent": "GitHub-Hookshot/test",
      "x-github-event": "pull_request",
      "x-github-delivery": "github-delivery-1",
      "idempotency-key": "ignored-generic-key",
      "x-hub-signature-256-present": true,
    });

    const rotated = await app.request(`/api/autopilots/${autopilot.id}/triggers/${triggerBody.id}/rotate-webhook-token`, { method: "POST" });
    const rotatedBody = await rotated.json();
    expect(rotatedBody.webhook_token).not.toBe(triggerBody.webhook_token);
    expect((await app.request(triggerBody.webhook_path, { method: "POST" })).status).toBe(404);

    const disabled = await app.request(`/api/autopilots/${autopilot.id}/triggers/${triggerBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((await disabled.json()).enabled).toBe(false);
    const ignored = await app.request(rotatedBody.webhook_path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-delivery-2" },
      body: JSON.stringify({ prompt: "Ignored token" }),
    });
    const ignoredBody = await ignored.json();
    expect(ignored.status).toBe(200);
    expect(ignoredBody.status).toBe("ignored");
    expect(ignoredBody.reason).toBe("trigger_disabled");

    const replay = await app.request(`/api/multiremi/autopilots/${autopilot.id}/deliveries/${webhookBody.deliveryId}/replay`, { method: "POST" });
    expect(replay.status).toBe(201);
    expect((await replay.json()).delivery.replayedFromDeliveryId).toBe(webhookBody.deliveryId);
  });

  it("rate limits public autopilot webhooks by token and source bucket", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const autopilot = store.createAutopilot({ title: "Webhook limited", assigneeId: agent.id, triggerKind: "webhook" });
    store.updateAutopilot(autopilot.id, { status: "paused" });
    const trigger = store.createAutopilotTrigger(autopilot.id, { kind: "webhook", label: "Limited webhook" });

    const tokenLimitedApp = createMultiremiApp({
      store,
      webhookRateLimit: { limit: 2, windowMs: 60_000 },
      webhookIpRateLimit: false,
    });
    for (const key of ["token-limit-1", "token-limit-2"]) {
      const allowed = await tokenLimitedApp.request(trigger.webhookPath!, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ prompt: key }),
      });
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).status).toBe("ignored");
    }
    const overTokenLimit = await tokenLimitedApp.request(trigger.webhookPath!, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "token-limit-3" },
      body: JSON.stringify({ prompt: "third" }),
    });
    expect(overTokenLimit.status).toBe(429);
    expect(await overTokenLimit.json()).toEqual({ error: "rate limit exceeded" });

    const ipLimitedApp = createMultiremiApp({
      store: createStore(),
      webhookRateLimit: false,
      webhookIpRateLimit: { limit: 2, windowMs: 60_000 },
    });
    for (const [token, spoofedIp] of [["awt_unknown_a", "1.1.1.1"], ["awt_unknown_b", "2.2.2.2"]] as const) {
      const allowedProbe = await ipLimitedApp.request(`/api/webhooks/autopilots/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": spoofedIp },
        body: JSON.stringify({ x: 1 }),
      });
      expect(allowedProbe.status).toBe(404);
    }
    const overIpLimit = await ipLimitedApp.request("/api/webhooks/autopilots/awt_unknown_c", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "3.3.3.3" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(overIpLimit.status).toBe(429);
    expect(await overIpLimit.json()).toEqual({ error: "rate limit exceeded" });
  });

  it("syncs scheduler state through autopilot API updates", async () => {
    const store = createStore();
    const scheduler = new MultiremiScheduler({ store });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const app = createMultiremiApp({ store, scheduler });

    const created = await app.request("/api/multiremi/autopilots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "API scheduled",
        assigneeId: agent.id,
        triggerKind: "schedule",
        cronExpression: "*/10 * * * * *",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(scheduler.scheduledIds()).toContain(createdBody.autopilot.id);

    const scheduled = await app.request(`/api/multiremi/autopilots/${createdBody.autopilot.id}/run-scheduled`, {
      method: "POST",
    });
    expect(scheduled.status).toBe(201);
    expect((await scheduled.json()).run.source).toBe("schedule");

    const paused = await app.request(`/api/multiremi/autopilots/${createdBody.autopilot.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    expect(paused.status).toBe(200);
    expect(scheduler.scheduledIds()).not.toContain(createdBody.autopilot.id);
    scheduler.stop();
  });
});
