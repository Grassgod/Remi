// Runtime metadata/usage, console scoping, delete cascade, and the async request
// queues (model list, update, local skill list/import) plus register/deregister.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, metricValue, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — runtimes and runtime request queues", () => {
  it("serves runtime metadata updates and usage endpoints", async () => {
    const store = createStore();
    const member = store.createWorkspaceMember({ name: "Ada", workspaceId: "local" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "usage" });
    const app = createMultiremiApp({ store });

    const unsupportedProvider = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "rt_gemini", name: "Gemini runtime", provider: "gemini", workspace_id: "local" }),
    });
    expect(unsupportedProvider.status).toBe(400);
    expect(await unsupportedProvider.json()).toEqual({ error: "Unsupported Multiremi runtime provider: gemini" });
    expect(store.getRuntime("rt_gemini")).toBeNull();

    const created = await app.request("/api/multiremi/runtimes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "rt_api",
        name: "API runtime",
        provider: "codex",
        workspace_id: "local",
        owner_id: member.id,
        visibility: "public",
        max_concurrency: 2,
        runtime_mode: "local",
        device_info: "API Laptop · 1.0.0",
        metadata: { version: "1.0.0", cli_version: "0.2.0", launched_by: "api" },
        models: [{ id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true }],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.runtime.ownerId).toBe(member.id);
    expect(createdBody.runtime.runtimeMode).toBe("local");
    expect(createdBody.runtime.deviceInfo).toBe("API Laptop · 1.0.0");
    expect(createdBody.runtime.metadata).toMatchObject({ version: "1.0.0", cli_version: "0.2.0", launched_by: "api" });
    expect(createdBody.runtime.visibility).toBe("public");
    expect(createdBody.runtime.maxConcurrency).toBe(2);
    expect(createdBody.runtime.models[0].default).toBeTrue();

    const models = await app.request("/api/runtimes/rt_api/models");
    expect((await models.json()).models[0].id).toBe("gpt-5.5");

    const updatedModels = await app.request("/api/multiremi/runtimes/rt_api/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: [{ id: "gpt-5.4", label: "GPT-5.4", provider: "openai", default: true }] }),
    });
    expect((await updatedModels.json()).models[0].id).toBe("gpt-5.4");

    const claim = await app.request("/api/daemon/runtimes/rt_api/tasks/claim", { method: "POST" });
    expect((await claim.json()).task.id).toBe(task.id);
    await app.request(`/api/daemon/tasks/${task.id}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usage: [{ provider: "codex", model: "gpt-5", input_tokens: 11, output_tokens: 5, cache_read_tokens: 2 }],
      }),
    });

    const detail = await app.request("/api/multiremi/runtimes/rt_api");
    const detailBody = await detail.json();
    expect(detailBody.runtime.taskCount).toBe(1);
    expect(detailBody.runtime.inputTokens).toBe(11);
    expect(detailBody.usage[0].model).toBe("gpt-5");

    const usage = await app.request("/api/runtimes/rt_api/usage");
    const usageBody = await usage.json();
    expect(usageBody[0]).toEqual({
      runtime_id: "rt_api",
      date: expect.any(String),
      provider: "codex",
      model: "gpt-5",
      input_tokens: 11,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
    });
    expect(usageBody[0].runtimeId).toBeUndefined();
    expect(usageBody[0].cacheReadTokens).toBeUndefined();

    const byAgent = await app.request("/api/runtimes/rt_api/usage/by-agent");
    const byAgentBody = await byAgent.json();
    expect(byAgentBody[0]).toEqual({
      agent_id: agent.id,
      model: "gpt-5",
      input_tokens: 11,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      task_count: 1,
    });
    expect(byAgentBody[0].agentId).toBeUndefined();

    const byHour = await app.request("/api/multiremi/runtimes/rt_api/usage/by-hour");
    const byHourBody = await byHour.json();
    expect(byHourBody.usage[0].model).toBe("gpt-5");

    const compatibilityByHour = await app.request("/api/runtimes/rt_api/usage/by-hour");
    const compatibilityByHourBody = await compatibilityByHour.json();
    expect(compatibilityByHourBody[0]).toEqual({
      hour: expect.any(Number),
      model: "gpt-5",
      input_tokens: 11,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      task_count: 1,
    });
    expect(compatibilityByHourBody[0].inputTokens).toBeUndefined();

    const activity = await app.request("/api/runtimes/rt_api/task-activity");
    expect((await activity.json())[0].count).toBe(1);
    const compatibilityActivity = await app.request("/api/runtimes/rt_api/activity");
    expect((await compatibilityActivity.json())[0]).toEqual({ hour: expect.any(Number), count: 1 });

    const dashboardUsage = await app.request("/api/dashboard/usage/daily");
    expect((await dashboardUsage.json())[0].model).toBe("gpt-5");

    const invalidNativePatch = await app.request("/api/multiremi/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidNativePatch.status).toBe(400);
    expect(await invalidNativePatch.json()).toEqual({ error: "invalid request body" });

    const updated = await app.request("/api/multiremi/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_id: null,
        visibility: "private",
        max_concurrency: 4,
        device_info: "API Laptop · 1.0.1",
        metadata: { version: "1.0.1", cli_version: "0.2.1", launched_by: "patch" },
      }),
    });
    const updatedBody = await updated.json();
    expect(updatedBody.runtime.ownerId).toBeNull();
    expect(updatedBody.runtime.deviceInfo).toBe("API Laptop · 1.0.1");
    expect(updatedBody.runtime.metadata).toMatchObject({ version: "1.0.1", cli_version: "0.2.1", launched_by: "patch" });
    expect(updatedBody.runtime.visibility).toBe("private");
    expect(updatedBody.runtime.maxConcurrency).toBe(4);

    const invalidJsonCompatibilityPatch = await app.request("/api/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonCompatibilityPatch.status).toBe(400);
    expect(await invalidJsonCompatibilityPatch.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntime("rt_api")?.visibility).toBe("private");

    const compatibilityPatch = await app.request("/api/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "public", max_concurrency: 9 }),
    });
    const compatibilityPatchBody = await compatibilityPatch.json();
    expect(compatibilityPatch.status).toBe(200);
    expect(compatibilityPatchBody.visibility).toBe("public");
    expect(compatibilityPatchBody.launch_header).toBe("codex app-server");
    expect(compatibilityPatchBody.runtime_mode).toBe("local");
    expect(compatibilityPatchBody.max_concurrency).toBeUndefined();
    expect(store.getRuntime("rt_api")?.maxConcurrency).toBe(4);

    const invalidCompatibilityPatch = await app.request("/api/runtimes/rt_api", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "workspace" }),
    });
    expect(invalidCompatibilityPatch.status).toBe(400);
    expect(await invalidCompatibilityPatch.json()).toEqual({ error: "visibility must be 'private' or 'public'" });
  });

  it("scopes runtime console APIs by workspace and owner permissions", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ id: "bob", name: "Bob", role: "member" });
    store.createWorkspaceMember({ id: "admin", name: "Admin", role: "admin" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "admin" });
    const alicePrivate = store.registerRuntime({
      id: "rt_scope_alice",
      name: "Alice private",
      provider: "codex",
      workspaceId: "local",
      ownerId: "alice",
      visibility: "private",
    });
    const bobPublic = store.registerRuntime({
      id: "rt_scope_bob",
      name: "Bob public",
      provider: "claude",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
    });
    const remoteRuntime = store.registerRuntime({
      id: "rt_scope_remote",
      name: "Remote runtime",
      provider: "codex",
      workspaceId: "remote",
      ownerId: "alice",
      visibility: "public",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

    const bobList = await app.request("/api/runtimes", { headers: authHeaders(bobToken.token) });
    const bobRuntimes = await bobList.json();
    const bobRuntimeIds = bobRuntimes.map((runtime: any) => runtime.id);
    expect(bobRuntimeIds).toContain(alicePrivate.id);
    expect(bobRuntimeIds).toContain(bobPublic.id);
    expect(bobRuntimeIds).not.toContain(remoteRuntime.id);
    expect(bobRuntimes.find((runtime: any) => runtime.id === alicePrivate.id)).toMatchObject({
      workspace_id: "local",
      owner_id: "alice",
      launch_header: "codex app-server",
      runtime_mode: "local",
    });

    const bobOwnedList = await app.request("/api/runtimes?owner=me", { headers: authHeaders(bobToken.token) });
    expect((await bobOwnedList.json()).map((runtime: any) => runtime.id)).toEqual([bobPublic.id]);
    const bobOwnedNativeList = await app.request("/api/multiremi/runtimes?owner=me", { headers: authHeaders(bobToken.token) });
    expect((await bobOwnedNativeList.json()).runtimes.map((runtime: any) => runtime.id)).toEqual([bobPublic.id]);

    const bobDetail = await app.request(`/api/runtimes/${alicePrivate.id}`, { headers: authHeaders(bobToken.token) });
    expect(bobDetail.status).toBe(200);
    expect((await bobDetail.json()).runtime.id).toBe(alicePrivate.id);

    const remoteDetail = await app.request(`/api/runtimes/${remoteRuntime.id}`, { headers: authHeaders(aliceToken.token) });
    expect(remoteDetail.status).toBe(404);
    expect(await remoteDetail.json()).toEqual({ error: "runtime not found" });

    const bobUsage = await app.request(`/api/runtimes/${alicePrivate.id}/usage`, { headers: authHeaders(bobToken.token) });
    expect(bobUsage.status).toBe(200);

    const bobModelRequest = await app.request(`/api/runtimes/${alicePrivate.id}/models`, {
      method: "POST",
      headers: authHeaders(bobToken.token),
    });
    expect(bobModelRequest.status).toBe(200);
    expect((await bobModelRequest.json()).status).toBe("pending");

    const bobModelCatalogWrite = await app.request(`/api/runtimes/${alicePrivate.id}/models`, {
      method: "PUT",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ models: [{ id: "blocked", label: "Blocked" }] }),
    });
    expect(bobModelCatalogWrite.status).toBe(403);
    expect(await bobModelCatalogWrite.json()).toEqual({ error: "you can only edit your own runtimes" });

    const bobPatch = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "PATCH",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(bobPatch.status).toBe(403);
    expect(await bobPatch.json()).toEqual({ error: "you can only edit your own runtimes" });

    const bobDelete = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "DELETE",
      headers: authHeaders(bobToken.token),
    });
    expect(bobDelete.status).toBe(403);
    expect(await bobDelete.json()).toEqual({ error: "you can only delete your own runtimes" });

    const alicePatch = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "PATCH",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(alicePatch.status).toBe(200);
    expect((await alicePatch.json()).visibility).toBe("public");

    const adminPatch = await app.request(`/api/runtimes/${alicePrivate.id}`, {
      method: "PATCH",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ visibility: "private", max_concurrency: 4 }),
    });
    expect(adminPatch.status).toBe(200);
    const adminPatchBody = await adminPatch.json();
    expect(adminPatchBody.visibility).toBe("private");
    expect(adminPatchBody.max_concurrency).toBeUndefined();
    expect(store.getRuntime(alicePrivate.id)?.maxConcurrency).toBe(1);

    const adminLocalSkills = await app.request(`/api/runtimes/${alicePrivate.id}/local-skills`, {
      method: "POST",
      headers: authHeaders(adminToken.token),
    });
    expect(adminLocalSkills.status).toBe(403);
    expect(await adminLocalSkills.json()).toEqual({ error: "you can only access local skills from your own runtimes" });

    const aliceLocalSkills = await app.request(`/api/runtimes/${alicePrivate.id}/local-skills`, {
      method: "POST",
      headers: authHeaders(aliceToken.token),
    });
    expect(aliceLocalSkills.status).toBe(200);
    expect((await aliceLocalSkills.json()).status).toBe("pending");
  });

  it("matches Go runtime delete cascade contracts", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_delete_contract", name: "Delete contract", provider: "codex" });
    const agent = store.createAgent({
      id: "agt_delete_contract",
      name: "Delete Contract Agent",
      provider: "codex",
      runtimeId: runtime.id,
    });
    const helper = store.createAgent({
      id: "agt_delete_helper",
      name: "Delete Helper",
      provider: "codex",
    });
    const agentTask = store.createTask({ agentId: agent.id, prompt: "agent-bound active task" });
    const runtimeTask = store.createTask({ agentId: helper.id, runtimeId: runtime.id, prompt: "runtime-bound active task" });
    const app = createMultiremiApp({ store });

    const strictDelete = await app.request(`/api/runtimes/${runtime.id}`, { method: "DELETE" });
    expect(strictDelete.status).toBe(409);
    const strictBody = await strictDelete.json();
    expect(strictBody.code).toBe("runtime_has_active_agents");
    expect(strictBody.error).toContain("cannot delete runtime");
    expect(strictBody.active_agents.map((item: any) => item.id)).toEqual([agent.id]);
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const invalidBody = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const badExpected = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [agent.id, 42] }),
    });
    expect(badExpected.status).toBe(400);
    expect(await badExpected.json()).toEqual({ error: "expected_active_agent_ids must be a list of valid UUIDs" });

    const camelExpected = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedActiveAgentIds: [agent.id] }),
    });
    expect(camelExpected.status).toBe(409);
    const camelExpectedBody = await camelExpected.json();
    expect(camelExpectedBody.code).toBe("runtime_delete_plan_changed");
    expect(camelExpectedBody.active_agents.map((item: any) => item.id)).toEqual([agent.id]);
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const planChanged = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [] }),
    });
    expect(planChanged.status).toBe(409);
    const planChangedBody = await planChanged.json();
    expect(planChangedBody.code).toBe("runtime_delete_plan_changed");
    expect(planChangedBody.error).toBe("the active agent set changed; please review and confirm again.");
    expect(planChangedBody.active_agents.map((item: any) => item.id)).toEqual([agent.id]);
    expect(store.getRuntime(runtime.id)).not.toBeNull();

    const cascade = await app.request(`/api/runtimes/${runtime.id}/archive-agents-and-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_active_agent_ids: [agent.id] }),
    });
    expect(cascade.status).toBe(200);
    expect(await cascade.json()).toEqual({ status: "ok", agents_archived: 1, tasks_cancelled: 2 });
    expect(store.getRuntime(runtime.id)).toBeNull();
    expect(store.getAgent(agent.id)).toBeNull();
    expect(store.getTask(agentTask.id)?.status).toBe("cancelled");
    expect(store.getTask(runtimeTask.id)?.status).toBe("cancelled");
  });

  it("serves runtime model list request flow", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_models_flow", name: "Models runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    const nativeInvalidCatalogWrite = await app.request("/api/multiremi/runtimes/rt_models_flow/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(nativeInvalidCatalogWrite.status).toBe(400);
    expect(await nativeInvalidCatalogWrite.json()).toEqual({ error: "invalid request body" });

    const invalidCatalogWrite = await app.request("/api/runtimes/rt_models_flow/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCatalogWrite.status).toBe(400);
    expect(await invalidCatalogWrite.json()).toEqual({ error: "invalid request body" });

    const created = await app.request("/api/runtimes/rt_models_flow/models", { method: "POST" });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("rml_");
    expect(createdBody.status).toBe("pending");

    const claimed = await app.request("/api/daemon/runtimes/rt_models_flow/models/claim", { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.request.id).toBe(createdBody.id);
    expect(claimedBody.request.status).toBe("running");

    const reported = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        supported: true,
        models: [{
          id: "gpt-5.1-codex",
          label: "GPT-5.1 Codex",
          provider: "openai",
          default: true,
          thinking: {
            supported_levels: [{ value: "high", label: "High", description: "More reasoning" }],
            default_level: "high",
          },
        }],
      }),
    });
    expect(reported.status).toBe(200);

    const detail = await app.request(`/api/runtimes/rt_models_flow/models/${createdBody.id}`);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("completed");
    expect(detailBody.runtime_id).toBe("rt_models_flow");
    expect(detailBody.runtimeId).toBeUndefined();
    expect(detailBody.created_at).toBeString();
    expect(detailBody.createdAt).toBeUndefined();
    expect(detailBody.models[0].default).toBe(true);
    expect(detailBody.models[0].thinking.supported_levels[0].value).toBe("high");
    expect(detailBody.models[0].thinking.default_level).toBe("high");
    expect(detailBody.models[0].thinking.supportedLevels).toBeUndefined();

    const models = await app.request("/api/runtimes/rt_models_flow/models");
    const modelsBody = await models.json();
    expect(modelsBody.runtime_id).toBe("rt_models_flow");
    expect(modelsBody.runtimeId).toBeUndefined();
    expect(modelsBody.models[0].id).toBe("gpt-5.1-codex");
    expect(modelsBody.models[0].thinking.supported_levels[0].label).toBe("High");
    expect(modelsBody.models[0].createdAt).toBeUndefined();

    const failed = await app.request("/api/multiremi/runtimes/rt_models_flow/models", { method: "POST" });
    const failedBody = await failed.json();
    await app.request(`/api/daemon/runtimes/rt_models_flow/models/${failedBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "provider not available" }),
    });
    const failedDetail = await app.request(`/api/multiremi/runtimes/rt_models_flow/models/${failedBody.id}`);
    const failedDetailBody = await failedDetail.json();
    expect(failedDetailBody.status).toBe("failed");
    expect(failedDetailBody.error).toBe("provider not available");

    const missingModelReport = await app.request("/api/daemon/runtimes/rt_models_flow/models/rml_missing/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingModelReport.status).toBe(404);
    expect(await missingModelReport.json()).toEqual({ error: "request not found" });

    const invalidJsonModelRequest = store.createRuntimeModelListRequest("rt_models_flow");
    const invalidJsonModelReport = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${invalidJsonModelRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonModelReport.status).toBe(400);
    expect(await invalidJsonModelReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeModelListRequest("rt_models_flow", invalidJsonModelRequest.id)?.status).toBe("pending");
    const cleanupInvalidJsonModelRequest = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${invalidJsonModelRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "invalid json test cleanup" }),
    });
    expect(cleanupInvalidJsonModelRequest.status).toBe(200);

    const stalePending = store.createRuntimeModelListRequest("rt_models_flow");
    const oldPendingAt = new Date(Date.now() - 31_000).toISOString();
    db!.run("UPDATE multiremi_runtime_model_list_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldPendingAt,
      oldPendingAt,
      stalePending.id,
    ]);
    const stalePendingPoll = await app.request(`/api/runtimes/rt_models_flow/models/${stalePending.id}`);
    const stalePendingBody = await stalePendingPoll.json();
    expect(stalePendingBody.status).toBe("timeout");
    expect(stalePendingBody.error).toBe("daemon did not respond within 30 seconds");
    expect(stalePendingBody.created_at).toBe(oldPendingAt);
    expect(stalePendingBody.createdAt).toBeUndefined();
    expect((await (await app.request("/api/daemon/runtimes/rt_models_flow/models/claim", { method: "POST" })).json()).request).toBeNull();

    const staleRunning = store.createRuntimeModelListRequest("rt_models_flow");
    await app.request("/api/daemon/runtimes/rt_models_flow/models/claim", { method: "POST" });
    const oldRunningAt = new Date(Date.now() - 61_000).toISOString();
    db!.run("UPDATE multiremi_runtime_model_list_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldRunningAt,
      oldRunningAt,
      staleRunning.id,
    ]);
    const staleRunningPoll = await app.request(`/api/multiremi/runtimes/rt_models_flow/models/${staleRunning.id}`);
    const staleRunningBody = await staleRunningPoll.json();
    expect(staleRunningBody.status).toBe("timeout");
    expect(staleRunningBody.error).toBe("daemon did not finish within 60 seconds");

    const lateModelReport = await app.request(`/api/daemon/runtimes/rt_models_flow/models/${staleRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", models: [{ id: "late-model", label: "Late Model" }] }),
    });
    expect(lateModelReport.status).toBe(200);
    expect(store.getRuntimeModelListRequest("rt_models_flow", staleRunning.id)?.status).toBe("timeout");
  });

  it("serves runtime update request flow", async () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_update_flow", name: "Update runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    const nativeInvalidCreated = await app.request("/api/multiremi/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(nativeInvalidCreated.status).toBe(400);
    expect(await nativeInvalidCreated.json()).toEqual({ error: "invalid request body" });

    const invalidCreated = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCreated.status).toBe(400);
    expect(await invalidCreated.json()).toEqual({ error: "invalid request body" });

    const camelCreated = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "v1.2.3" }),
    });
    expect(camelCreated.status).toBe(400);
    expect(await camelCreated.json()).toEqual({ error: "target_version is required" });

    const created = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_version: "v1.2.3" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.id).toStartWith("rup_");
    expect(createdBody.target_version).toBe("v1.2.3");
    expect(createdBody.targetVersion).toBeUndefined();
    expect(createdBody.runtime_id).toBe("rt_update_flow");
    expect(createdBody.runtimeId).toBeUndefined();
    expect(createdBody.created_at).toBeString();
    expect(createdBody.createdAt).toBeUndefined();
    expect(createdBody.status).toBe("pending");

    const duplicate = await app.request("/api/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_version: "v1.2.4" }),
    });
    expect(duplicate.status).toBe(409);

    const missingUpdateReport = await app.request("/api/daemon/runtimes/rt_update_flow/update/rup_missing/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingUpdateReport.status).toBe(404);
    expect(await missingUpdateReport.json()).toEqual({ error: "update not found" });

    const invalidJsonUpdateReport = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonUpdateReport.status).toBe(400);
    expect(await invalidJsonUpdateReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeUpdateRequest("rt_update_flow", createdBody.id)?.status).toBe("pending");

    const invalidStatusUpdateReport = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(invalidStatusUpdateReport.status).toBe(400);
    expect(await invalidStatusUpdateReport.json()).toEqual({ error: "invalid status: bogus" });
    expect(store.getRuntimeUpdateRequest("rt_update_flow", createdBody.id)?.status).toBe("pending");

    const claimed = await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    const claimedBody = await claimed.json();
    expect(claimedBody.request.id).toBe(createdBody.id);
    expect(claimedBody.request.status).toBe("running");

    const running = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    expect(running.status).toBe(200);

    const completed = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${createdBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", output: "updated ok" }),
    });
    expect(completed.status).toBe(200);

    const detail = await app.request(`/api/runtimes/rt_update_flow/update/${createdBody.id}`);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("completed");
    expect(detailBody.output).toBe("updated ok");
    expect(detailBody.target_version).toBe("v1.2.3");
    expect(detailBody.targetVersion).toBeUndefined();

    const next = await app.request("/api/multiremi/runtimes/rt_update_flow/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "v1.2.4" }),
    });
    expect(next.status).toBe(200);
    const nextBody = await next.json();
    await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    await app.request(`/api/daemon/runtimes/rt_update_flow/update/${nextBody.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "download failed" }),
    });
    const failedDetail = await app.request(`/api/multiremi/runtimes/rt_update_flow/update/${nextBody.id}`);
    const failedDetailBody = await failedDetail.json();
    expect(failedDetailBody.status).toBe("failed");
    expect(failedDetailBody.error).toBe("download failed");

    const stalePending = store.createRuntimeUpdateRequest("rt_update_flow", { target_version: "v2.0.0" });
    const oldPendingAt = new Date(Date.now() - 121_000).toISOString();
    db!.run("UPDATE multiremi_runtime_update_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldPendingAt,
      oldPendingAt,
      stalePending.id,
    ]);
    const stalePendingPoll = await app.request(`/api/runtimes/rt_update_flow/update/${stalePending.id}`);
    const stalePendingBody = await stalePendingPoll.json();
    expect(stalePendingBody.status).toBe("timeout");
    expect(stalePendingBody.error).toBe("daemon did not respond within 120 seconds");
    expect(stalePendingBody.created_at).toBe(oldPendingAt);
    expect(stalePendingBody.createdAt).toBeUndefined();
    expect((await (await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" })).json()).request).toBeNull();

    const staleRunning = store.createRuntimeUpdateRequest("rt_update_flow", { target_version: "v2.1.0" });
    await app.request("/api/daemon/runtimes/rt_update_flow/update/claim", { method: "POST" });
    const oldRunningAt = new Date(Date.now() - 151_000).toISOString();
    db!.run("UPDATE multiremi_runtime_update_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldRunningAt,
      oldRunningAt,
      staleRunning.id,
    ]);
    const staleRunningPoll = await app.request(`/api/multiremi/runtimes/rt_update_flow/update/${staleRunning.id}`);
    const staleRunningBody = await staleRunningPoll.json();
    expect(staleRunningBody.status).toBe("timeout");
    expect(staleRunningBody.error).toBe("update did not complete within 150 seconds");

    const lateUpdateReport = await app.request(`/api/daemon/runtimes/rt_update_flow/update/${staleRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", output: "late ok" }),
    });
    expect(lateUpdateReport.status).toBe(200);
    expect(store.getRuntimeUpdateRequest("rt_update_flow", staleRunning.id)?.status).toBe("timeout");
  });

  it("supports ACP-scope update requests (no target version, defaults to latest)", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_acp_update", name: "ACP update runtime", provider: "codex" });
    const app = createMultiremiApp({ store });

    // ACP-bridge updates always pull @latest, so no target_version is required.
    const created = await app.request(`/api/runtimes/${runtime.id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "acp" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.scope).toBe("acp");
    expect(createdBody.target_version).toBe("latest");
    expect(createdBody.status).toBe("pending");

    // The heartbeat ack carries the scope so the daemon reinstalls bridges (not the CLI).
    const ack = store.heartbeatRuntime(runtime.id, { supportsBatchImport: true });
    expect(ack.pending_update).toMatchObject({ id: createdBody.id, scope: "acp", target_version: "latest" });
    expect(store.getRuntimeUpdateRequest(runtime.id, createdBody.id)?.scope).toBe("acp");
  });

  it("supports agent-scope update requests (runs the agent CLI updater)", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_agent_update", name: "Agent update runtime", provider: "claude" });
    const app = createMultiremiApp({ store });

    const created = await app.request(`/api/runtimes/${runtime.id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "agent" }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.scope).toBe("agent");
    expect(createdBody.target_version).toBe("latest");

    const ack = store.heartbeatRuntime(runtime.id, { supportsBatchImport: true });
    expect(ack.pending_update).toMatchObject({ id: createdBody.id, scope: "agent" });
    expect(store.getRuntimeUpdateRequest(runtime.id, createdBody.id)?.scope).toBe("agent");
  });

  it("serves runtime local skill list and import request flows", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "skill-runtime", provider: "claude", workspaceId: "local" });
    const app = createMultiremiApp({ store });

    const listInit = await app.request(`/api/runtimes/${runtime.id}/local-skills`, { method: "POST" });
    expect(listInit.status).toBe(200);
    const listRequest = await listInit.json();
    expect(listRequest.status).toBe("pending");

    const listClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" });
    const listClaimBody = await listClaim.json();
    expect(listClaimBody.request.id).toBe(listRequest.id);
    expect(listClaimBody.request.status).toBe("running");

    const missingListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/rls_missing/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingListReport.status).toBe(404);
    expect(await missingListReport.json()).toEqual({ error: "request not found" });

    const invalidJsonListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${listRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonListReport.status).toBe(400);
    expect(await invalidJsonListReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, listRequest.id)?.status).toBe("running");

    const listReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${listRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skills: [{
          key: "review-helper",
          name: "Review Helper",
          description: "Review local files",
          source_path: "/home/me/.claude/skills/review-helper",
          provider: "claude",
          file_count: 2,
        }],
      }),
    });
    expect(listReport.status).toBe(200);

    const listPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/${listRequest.id}`);
    const listPollBody = await listPoll.json();
    expect(listPollBody.status).toBe("completed");
    expect(listPollBody.runtime_id).toBe(runtime.id);
    expect(listPollBody.runtimeId).toBeUndefined();
    expect(listPollBody.created_at).toBeString();
    expect(listPollBody.createdAt).toBeUndefined();
    expect(listPollBody.skills[0].source_path).toBe("/home/me/.claude/skills/review-helper");
    expect(listPollBody.skills[0].file_count).toBe(2);
    expect(listPollBody.skills[0].sourcePath).toBeUndefined();
    expect(listPollBody.skills[0].fileCount).toBeUndefined();

    const camelListRequest = store.createRuntimeLocalSkillListRequest(runtime.id);
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" })).json()).request.id).toBe(camelListRequest.id);
    const camelListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${camelListRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skills: [{
          key: "camel-helper",
          name: "Camel Helper",
          description: "Camel aliases should be ignored",
          sourcePath: "/home/me/.claude/skills/camel-helper",
          provider: "claude",
          fileCount: 7,
        }],
      }),
    });
    expect(camelListReport.status).toBe(200);
    const camelListBody = await (await app.request(`/api/runtimes/${runtime.id}/local-skills/${camelListRequest.id}`)).json();
    expect(camelListBody.skills[0]).toMatchObject({
      key: "camel-helper",
      source_path: "",
      file_count: 0,
    });

    const nativeInvalidImportInit = await app.request(`/api/multiremi/runtimes/${runtime.id}/local-skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(nativeInvalidImportInit.status).toBe(400);
    expect(await nativeInvalidImportInit.json()).toEqual({ error: "invalid request body" });

    const invalidImportInit = await app.request(`/api/runtimes/${runtime.id}/local-skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidImportInit.status).toBe(400);
    expect(await invalidImportInit.json()).toEqual({ error: "invalid request body" });

    const importInit = await app.request(`/api/runtimes/${runtime.id}/local-skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_key: "review-helper", name: "Imported Local Review" }),
    });
    expect(importInit.status).toBe(200);
    const importRequest = await importInit.json();
    expect(importRequest.status).toBe("pending");
    expect(importRequest.skill_key).toBe("review-helper");
    expect(importRequest.skillKey).toBeUndefined();
    expect(importRequest.created_at).toBeString();
    expect(importRequest.createdAt).toBeUndefined();

    const importClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" });
    const importClaimBody = await importClaim.json();
    expect(importClaimBody.requests[0].id).toBe(importRequest.id);
    expect(importClaimBody.requests[0].skillKey).toBe("review-helper");

    const missingImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/rli_missing/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(missingImportReport.status).toBe(404);
    expect(await missingImportReport.json()).toEqual({ error: "request not found" });

    const invalidJsonImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${importRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJsonImportReport.status).toBe(400);
    expect(await invalidJsonImportReport.json()).toEqual({ error: "invalid request body" });
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, importRequest.id)?.status).toBe("running");

    const importReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${importRequest.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skill: {
          name: "Review Helper",
          description: "Daemon description",
          content: "# Review Helper",
          provider: "claude",
          source_path: "/home/me/.claude/skills/review-helper",
          files: [{ path: "notes/check.md", content: "Check" }],
        },
      }),
    });
    expect(importReport.status).toBe(200);

    const importPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${importRequest.id}`);
    const importPollBody = await importPoll.json();
    expect(importPollBody.status).toBe("completed");
    expect(importPollBody.skill_key).toBe("review-helper");
    expect(importPollBody.skillKey).toBeUndefined();
    expect(importPollBody.skill.name).toBe("Imported Local Review");
    expect(importPollBody.skill.workspace_id).toBe("local");
    expect(importPollBody.skill.workspaceId).toBeUndefined();
    expect(importPollBody.skill.config.origin.type).toBe("runtime_local");
    expect(importPollBody.skill.files[0].skill_id).toBe(importPollBody.skill.id);
    expect(importPollBody.skill.files[0].path).toBe("notes/check.md");

    const camelImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "camel-import", name: "Camel Import" });
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" })).json()).requests[0].id).toBe(camelImport.id);
    const camelImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${camelImport.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skill: {
          name: "Camel Import",
          description: "Camel sourcePath should be ignored",
          content: "# Camel Import",
          provider: "claude",
          sourcePath: "/home/me/.claude/skills/camel-import",
        },
      }),
    });
    expect(camelImportReport.status).toBe(200);
    const camelImportBody = await (await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${camelImport.id}`)).json();
    expect(camelImportBody.skill.config.origin).toMatchObject({
      type: "runtime_local",
      runtime_id: runtime.id,
      provider: "claude",
      source_path: "",
    });

    const emptyImport = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "empty-bundle", name: "Empty Bundle" });
    const emptyImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${emptyImport.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(emptyImportReport.status).toBe(200);
    expect(await emptyImportReport.json()).toEqual({ status: "ok" });
    const emptyImportDetail = store.getRuntimeLocalSkillImportRequest(runtime.id, emptyImport.id);
    expect(emptyImportDetail?.status).toBe("failed");
    expect(emptyImportDetail?.error).toBe("daemon returned an empty skill bundle");

    const staleListPending = store.createRuntimeLocalSkillListRequest(runtime.id);
    const oldLocalSkillPendingAt = new Date(Date.now() - 181_000).toISOString();
    db!.run("UPDATE multiremi_runtime_local_skill_list_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillPendingAt,
      oldLocalSkillPendingAt,
      staleListPending.id,
    ]);
    const staleListPendingPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/${staleListPending.id}`);
    const staleListPendingBody = await staleListPendingPoll.json();
    expect(staleListPendingBody.status).toBe("timeout");
    expect(staleListPendingBody.error).toBe("daemon did not respond within 3 minutes");
    expect(staleListPendingBody.created_at).toBe(oldLocalSkillPendingAt);
    expect(staleListPendingBody.createdAt).toBeUndefined();
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" })).json()).request).toBeNull();

    const staleListRunning = store.createRuntimeLocalSkillListRequest(runtime.id);
    await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/claim`, { method: "POST" });
    const oldLocalSkillRunningAt = new Date(Date.now() - 61_000).toISOString();
    db!.run("UPDATE multiremi_runtime_local_skill_list_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillRunningAt,
      oldLocalSkillRunningAt,
      staleListRunning.id,
    ]);
    const staleListRunningPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/${staleListRunning.id}`);
    const staleListRunningBody = await staleListRunningPoll.json();
    expect(staleListRunningBody.status).toBe("timeout");
    expect(staleListRunningBody.error).toBe("daemon did not finish within 60 seconds");

    const lateListReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/${staleListRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", skills: [] }),
    });
    expect(lateListReport.status).toBe(200);
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, staleListRunning.id)?.status).toBe("timeout");

    const staleImportPending = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "stale-pending" });
    db!.run("UPDATE multiremi_runtime_local_skill_import_requests SET created_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillPendingAt,
      oldLocalSkillPendingAt,
      staleImportPending.id,
    ]);
    const staleImportPendingPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${staleImportPending.id}`);
    const staleImportPendingBody = await staleImportPendingPoll.json();
    expect(staleImportPendingBody.status).toBe("timeout");
    expect(staleImportPendingBody.error).toBe("daemon did not respond within 3 minutes");
    expect(staleImportPendingBody.skill_key).toBe("stale-pending");
    expect(staleImportPendingBody.skillKey).toBeUndefined();
    expect((await (await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" })).json()).requests).toEqual([]);

    const staleImportRunning = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "stale-running", name: "Late Import" });
    await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/claim?limit=5`, { method: "POST" });
    db!.run("UPDATE multiremi_runtime_local_skill_import_requests SET run_started_at = ?, updated_at = ? WHERE id = ?", [
      oldLocalSkillRunningAt,
      oldLocalSkillRunningAt,
      staleImportRunning.id,
    ]);
    const staleImportRunningPoll = await app.request(`/api/runtimes/${runtime.id}/local-skills/import/${staleImportRunning.id}`);
    const staleImportRunningBody = await staleImportRunningPoll.json();
    expect(staleImportRunningBody.status).toBe("timeout");
    expect(staleImportRunningBody.error).toBe("daemon did not finish within 60 seconds");

    const lateImportReport = await app.request(`/api/daemon/runtimes/${runtime.id}/local-skills/import/${staleImportRunning.id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        skill: {
          name: "Late Import",
          description: "Should not be created",
          content: "# Late",
          provider: "claude",
          source_path: "/tmp/late",
        },
      }),
    });
    expect(lateImportReport.status).toBe(200);
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, staleImportRunning.id)?.status).toBe("timeout");
    expect(store.listSkills("local").some((skill) => skill.name === "Late Import")).toBe(false);
  });

  it("serves original daemon heartbeat pending request protocol", async () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_heartbeat_flow", name: "Heartbeat runtime", provider: "codex" });
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const issue = store.createIssue({ title: "Do not steal heartbeat requests" });
    store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Claim task" });
    const app = createMultiremiApp({ store });

    const modelRequest = store.createRuntimeModelListRequest(runtime.id);
    const updateRequest = store.createRuntimeUpdateRequest(runtime.id, { target_version: "v9.9.9" });
    const localSkillRequest = store.createRuntimeLocalSkillListRequest(runtime.id);
    const importOne = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "review-helper" });
    const importTwo = store.createRuntimeLocalSkillImportRequest(runtime.id, { skill_key: "test-helper" });

    const invalidHeartbeatJson = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidHeartbeatJson.status).toBe(400);
    expect(await invalidHeartbeatJson.json()).toEqual({ error: "invalid request body" });

    const camelRuntimeHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: runtime.id }),
    });
    expect(camelRuntimeHeartbeat.status).toBe(400);
    expect(await camelRuntimeHeartbeat.json()).toEqual({ error: "runtime_id is required" });

    const camelBatchRuntime = store.registerRuntime({ id: "rt_heartbeat_camel_batch", name: "Camel batch heartbeat", provider: "codex" });
    const camelBatchImportOne = store.createRuntimeLocalSkillImportRequest(camelBatchRuntime.id, { skill_key: "camel-one" });
    const camelBatchImportTwo = store.createRuntimeLocalSkillImportRequest(camelBatchRuntime.id, { skill_key: "camel-two" });
    const camelBatchHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: camelBatchRuntime.id, supportsBatchImport: true }),
    });
    const camelBatchBody = await camelBatchHeartbeat.json();
    expect(camelBatchHeartbeat.status).toBe(200);
    expect(camelBatchBody.pending_local_skill_import).toMatchObject({ id: camelBatchImportOne.id, skill_key: "camel-one" });
    expect(camelBatchBody.pending_local_skill_imports).toBeUndefined();
    expect(store.getRuntimeLocalSkillImportRequest(camelBatchRuntime.id, camelBatchImportOne.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillImportRequest(camelBatchRuntime.id, camelBatchImportTwo.id)?.status).toBe("pending");

    const taskClaim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(taskClaim.status).toBe(200);
    expect(store.getRuntimeModelListRequest(runtime.id, modelRequest.id)?.status).toBe("pending");
    expect(store.getRuntimeUpdateRequest(runtime.id, updateRequest.id)?.status).toBe("pending");

    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtime.id, supports_batch_import: true }),
    });
    const heartbeatBody = await heartbeat.json();

    expect(heartbeat.status).toBe(200);
    expect(heartbeatBody).toMatchObject({
      status: "ok",
      pending_update: { id: updateRequest.id, target_version: "v9.9.9" },
      pending_model_list: { id: modelRequest.id },
      pending_local_skills: { id: localSkillRequest.id },
      pending_local_skill_import: { id: importOne.id, skill_key: "review-helper" },
    });
    expect(heartbeatBody.runtime_id).toBeUndefined();
    expect(heartbeatBody.pending_local_skill_imports.map((item: any) => item.id)).toEqual([importOne.id, importTwo.id]);
    expect(store.getRuntimeModelListRequest(runtime.id, modelRequest.id)?.status).toBe("running");
    expect(store.getRuntimeUpdateRequest(runtime.id, updateRequest.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillListRequest(runtime.id, localSkillRequest.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillImportRequest(runtime.id, importOne.id)?.status).toBe("running");

    const legacyRuntime = store.registerRuntime({ id: "rt_heartbeat_legacy", name: "Legacy heartbeat", provider: "codex" });
    const legacyImportOne = store.createRuntimeLocalSkillImportRequest(legacyRuntime.id, { skill_key: "legacy-one" });
    const legacyImportTwo = store.createRuntimeLocalSkillImportRequest(legacyRuntime.id, { skill_key: "legacy-two" });
    const legacyHeartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: legacyRuntime.id }),
    });
    const legacyHeartbeatBody = await legacyHeartbeat.json();
    expect(legacyHeartbeat.status).toBe(200);
    expect(legacyHeartbeatBody).toMatchObject({
      status: "ok",
      pending_local_skill_import: { id: legacyImportOne.id, skill_key: "legacy-one" },
    });
    expect(legacyHeartbeatBody.pending_local_skill_imports).toBeUndefined();
    expect(store.getRuntimeLocalSkillImportRequest(legacyRuntime.id, legacyImportOne.id)?.status).toBe("running");
    expect(store.getRuntimeLocalSkillImportRequest(legacyRuntime.id, legacyImportTwo.id)?.status).toBe("pending");

    const emptyHeartbeat = await app.request(`/api/multiremi/runtimes/${runtime.id}/heartbeat`, { method: "POST" });
    const emptyHeartbeatBody = await emptyHeartbeat.json();
    expect(emptyHeartbeat.status).toBe(200);
    expect(emptyHeartbeatBody.pending_update).toBeUndefined();
  });

  it("records Go-style runtime_failed telemetry when daemon register persistence fails", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const app = createMultiremiApp({ store });
    store.registerRuntime = (() => {
      throw new Error("database is locked");
    }) as typeof store.registerRuntime;

    const failed = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "local",
        daemon_id: "daemon-failed-register",
        runtimes: [{ type: "codex", version: "1.2.3" }],
      }),
    });

    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "failed to register runtime: database is locked" });
    const event = store.listAnalyticsEvents({ name: "runtime_failed" })[0]!;
    expect(event.metricsOnly).toBe(true);
    expect(event.distinctId).toBe("workspace:local");
    expect(event.workspaceId).toBe("local");
    expect(event.properties).toMatchObject({
      daemon_id: "daemon-failed-register",
      provider: "codex",
      runtime_mode: "local",
      failure_reason: "registration_failed",
      error_type: "db_error",
      recoverable: true,
      source: "manual",
      is_demo: false,
    });
    expect(event.properties).not.toHaveProperty("user_id");
    expect(metricValue(store, "multiremi_runtime_failed_total", {
      runtime_mode: "local",
      provider: "codex",
      failure_reason: "registration_failed",
      recoverable: "true",
    })).toBe(1);
    expect(store.listAnalyticsEvents({ includeMetricsOnly: false }).some((analyticsEvent) => analyticsEvent.name === "runtime_failed")).toBe(false);
  });
});
