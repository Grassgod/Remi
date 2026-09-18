import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseRuntimeCodexProfile } from "@multiremi/contracts/codex-profile.js";
import { parseRuntimeClaudeProfile } from "@multiremi/contracts/claude-profile.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const originalEncryptionKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalEncryptionKey;
  resetMultiremiTestEnv();
});

type Provider = "codex" | "claude";
type Store = ReturnType<typeof createLocalStore>;
const MODEL = "frozen-model";
const NEXT_MODEL = "new-agent-model";
const WAIT_PREFIX = "等待冻结执行连接恢复：";
const thinking = { status: "supported" as const, supportedLevels: [{ value: "high", label: "high" }], defaultLevel: "high" };
const profile = {
  name: "original", base_url: "https://original.example/v1", model: MODEL,
  env_key: "", auth_mode: "api_key" as const,
};
const models = (provider: Provider, model = MODEL): MultiremiRuntimeModel[] => [{
  id: model, label: model, provider, default: true, thinking,
}];

function configure(store: Store, runtimeId: string, provider: Provider, key = "original-fixture-key", patch = {}) {
  const saved = provider === "codex"
    ? store.setRuntimeCodexProfile(runtimeId, { ...profile, ...patch }, key)!
    : store.setRuntimeClaudeProfile(runtimeId, { ...profile, ...patch }, key)!;
  store.updateRuntimeModels(runtimeId, models(provider, saved.model), saved);
  return saved;
}

function fixture(provider: Provider = "codex", effort: string | null = "high") {
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    id: "frozen-origin", name: "Original host", provider, daemonId: "frozen-origin-daemon",
    workspaceId: "local", ownerId: "local", metadata: { [`${provider}_profiles`]: 1 },
  });
  const saved = configure(store, runtime.id, provider);
  const agent = store.createAgent({ name: "Frozen worker", provider, model: MODEL, thinkingLevel: effort });
  const issue = store.createIssue({ title: "Frozen execution" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "retain my upstream" });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  const retry = () => {
    store.failTask(task.id, { error: "stale provider session", failureReason: "agent_error.stale_session" });
    const retried = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
    expect(retried).toBeDefined();
    return retried;
  };
  return { store, runtime, saved, agent, task, retry };
}

function credential(store: Store, runtimeId: string, credentialId: string, provider: Provider) {
  return provider === "codex" ? store.getRuntimeCodexProfileKey(runtimeId, credentialId)
    : store.getRuntimeClaudeProfileKey(runtimeId, credentialId);
}

function taskProfile(store: Store, taskId: string, provider: Provider) {
  const task = store.getTask(taskId)!;
  return provider === "codex" ? task.codexProfile : task.claudeProfile;
}

function expectFrozenWait(store: Store, taskId: string) {
  expect(store.getTask(taskId)).toMatchObject({
    status: "queued", waitReason: expect.stringContaining(WAIT_PREFIX),
  });
}

describe("frozen task routing", () => {
  for (const provider of ["codex", "claude"] as const) {
    it(`${provider}: selects a frozen retry independently from the same Agent's newer model`, () => {
      const { store, runtime, saved, agent, retry } = fixture(provider);
      const retried = retry();
      store.updateAgent(agent.id, { model: NEXT_MODEL });
      const current = store.createTask({ agentId: agent.id, prompt: "use the new selection", priority: 100 });
      expect(store.runtimeCanRunAgent(store.getRuntime(runtime.id)!, store.getAgent(agent.id)!)).toBe(false);

      const claimed = store.claimTask(runtime.id);
      expect(claimed?.id).toBe(retried.id);
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
      expect(store.getTask(current.id)?.status).toBe("queued");
      store.startTask(retried.id);
      store.completeTask(retried.id, { output: "old model completed" });
      store.updateRuntimeModels(runtime.id, models(provider, NEXT_MODEL), saved);
      expect(store.claimTask(runtime.id)?.id).toBe(current.id);
      expect(taskProfile(store, current.id, provider)?.model).toBe(NEXT_MODEL);
    });

    it(`${provider}: preserves the frozen model when the Agent changes before the failure is reported`, () => {
      const { store, runtime, saved, agent, retry } = fixture(provider);
      store.updateAgent(agent.id, { model: NEXT_MODEL });
      const retried = retry();
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
      expect(store.claimTask(runtime.id)?.id).toBe(retried.id);
    });

    it(`${provider}: retains the original connection when its credential disappears before failure creates a retry`, () => {
      const { store, runtime, saved, task, retry } = fixture(provider);
      const fingerprint = store.getTask(task.id)!.executionFingerprint;
      const replacement = configure(store, runtime.id, provider, "replacement-fixture-key", {
        base_url: "https://replacement.example/v1",
      });
      expect(replacement.credential_id).not.toBe(saved.credential_id);
      db!.run("DELETE FROM multiremi_runtime_provider_credentials WHERE id = ?", [saved.credential_id!]);
      const retried = retry();
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
      expect(retried.executionFingerprint).toBe(fingerprint);
      expect(retried.runtimeId).toBe(runtime.id);
      expect(store.claimTask(runtime.id)).toBeNull();
      expectFrozenWait(store, retried.id);
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
    });

    it(`${provider}: retains the original connection when thinking evidence changes before failure creates a retry`, () => {
      const { store, runtime, saved, task, retry } = fixture(provider);
      const fingerprint = store.getTask(task.id)!.executionFingerprint;
      configure(store, runtime.id, provider, "replacement-fixture-key", {
        base_url: "https://different-upstream.example/v1",
      });
      expect(credential(store, runtime.id, saved.credential_id!, provider)).toBe("original-fixture-key");
      const retried = retry();
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
      expect(retried.executionFingerprint).toBe(fingerprint);
      expect(retried.runtimeId).toBe(runtime.id);
      expect(store.claimTask(runtime.id)).toBeNull();
      expectFrozenWait(store, retried.id);
      // Restoring matching capability evidence permits the retained old
      // credential, without replacing the frozen execution connection.
      configure(store, runtime.id, provider, "third-fixture-key");
      expect(store.claimTask(runtime.id)?.id).toBe(retried.id);
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
    });

    for (const effort of [null, "high"] as const) {
      it(`${provider}: retirement after retry creation never delivers the original credential to a replacement (thinking=${effort})`, () => {
        const { store, runtime, saved, retry } = fixture(provider, effort);
        const retried = retry();
        const replacement = store.registerRuntime({
          id: "replacement", name: "Replacement", provider, daemonId: "replacement-daemon",
          workspaceId: "local", ownerId: "local", metadata: { [`${provider}_profiles`]: 1 },
        });
        configure(store, replacement.id, provider, "replacement-fixture-key");
        const plan = store.getDaemonRetirementPlan("local", runtime.daemonId!);
        expect(plan.canRetire).toBe(true);
        expect(store.retireDaemon("local", runtime.daemonId!, plan.snapshot, "local").status).toBe("retired");
        expect(store.getRuntime(runtime.id)).toBeNull();
        expect(credential(store, replacement.id, saved.credential_id!, provider)).toBeNull();

        expect(store.claimTask(replacement.id)).toBeNull();
        expectFrozenWait(store, retried.id);
        expect(taskProfile(store, retried.id, provider)).toEqual(saved);
        store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
        expectFrozenWait(store, retried.id);
      });
    }

    it(`${provider}: credential-only rotation keeps a runnable retry on its original credential`, () => {
      const { store, runtime, saved, retry } = fixture(provider);
      const retried = retry();
      const rotated = configure(store, runtime.id, provider, "replacement-fixture-key", { name: "renamed" });
      expect(rotated.credential_id).not.toBe(saved.credential_id);
      expect(credential(store, runtime.id, saved.credential_id!, provider)).toBe("original-fixture-key");
      expect(store.claimTask(runtime.id)?.id).toBe(retried.id);
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
    });

    it(`${provider}: missing historical credential waits explicitly instead of selecting the new key`, () => {
      const { store, runtime, saved, retry } = fixture(provider);
      const retried = retry();
      configure(store, runtime.id, provider, "replacement-fixture-key");
      // Simulate a removed historical secret. Production exposes no per-version
      // deletion API; never weaken the credential identity just to make it run.
      db!.run("DELETE FROM multiremi_runtime_provider_credentials WHERE id = ?", [saved.credential_id!]);
      expect(store.claimTask(runtime.id)).toBeNull();
      expectFrozenWait(store, retried.id);
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
    });

    it(`${provider}: normalizes historical profile defaults without requiring whole-object equality`, () => {
      const store = createLocalStore();
      const runtime = store.registerRuntime({
        name: "Legacy connection", provider, metadata: { [`${provider}_profiles`]: 1 },
      });
      const envProfile = { ...profile, auth_mode: "env" as const,
        env_key: provider === "codex" ? "REMI_CODEX_FROZEN_KEY" : "REMI_CLAUDE_FROZEN_KEY" };
      const saved = provider === "codex" ? store.setRuntimeCodexProfile(runtime.id, envProfile)!
        : store.setRuntimeClaudeProfile(runtime.id, envProfile)!;
      store.updateRuntimeModels(runtime.id, models(provider), saved);
      const agent = store.createAgent({ name: "Legacy retry", provider, model: MODEL, thinkingLevel: "high" });
      const task = store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Legacy schema" }).id, prompt: "work" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      store.failTask(task.id, { error: "stale session", failureReason: "agent_error.stale_session" });
      const retried = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
      const historical = { ...saved } as Record<string, unknown>;
      // These fields were optional and the daemon parser supplies these exact
      // defaults. Do not invent unknown fields the daemon would reject.
      delete historical.auth_mode;
      delete historical.auth_header;
      db!.run(`UPDATE multiremi_tasks SET ${provider}_profile = ? WHERE id = ?`, [JSON.stringify(historical), retried.id]);
      const claimed = store.claimTask(runtime.id);
      expect(claimed?.id).toBe(retried.id);
      const wireProfile = provider === "codex" ? claimed!.codexProfile : claimed!.claudeProfile;
      expect(wireProfile).toEqual(saved);
      expect(taskProfile(store, retried.id, provider)?.env_key).toBe(saved.env_key);
      expect(taskProfile(store, retried.id, provider)?.base_url).toBe(saved.base_url);
    });

    it(`${provider}: sends a normalized legacy profile without rewriting the stored snapshot or fingerprint`, () => {
      const { store, runtime, saved, retry } = fixture(provider);
      const retried = retry();
      const historical = { ...saved, display_metadata: { label: "historical schema" } };
      const serialized = JSON.stringify(historical);
      db!.run(`UPDATE multiremi_tasks SET ${provider}_profile = ? WHERE id = ?`, [serialized, retried.id]);
      const claimed = store.claimTask(runtime.id);
      expect(claimed?.id).toBe(retried.id);
      const wireProfile = provider === "codex" ? claimed!.codexProfile : claimed!.claudeProfile;
      expect(wireProfile).toEqual(saved);
      const parse = provider === "codex" ? parseRuntimeCodexProfile : parseRuntimeClaudeProfile;
      expect(parse(wireProfile)).toEqual(saved);
      expect(claimed!.executionFingerprint).toBe(retried.executionFingerprint);
      const stored = db!.query(`SELECT ${provider}_profile AS profile, execution_fingerprint FROM multiremi_tasks WHERE id = ?`)
        .get(retried.id) as { profile: string; execution_fingerprint: string };
      expect(stored.profile).toBe(serialized);
      expect(stored.execution_fingerprint).toBe(retried.executionFingerprint!);
    });

    it(`${provider}: does not borrow thinking capabilities from a different upstream`, () => {
      const { store, runtime, saved, retry } = fixture(provider);
      const retried = retry();
      configure(store, runtime.id, provider, "replacement-fixture-key", { base_url: "https://different.example/v1" });
      expect(store.claimTask(runtime.id)).toBeNull();
      expectFrozenWait(store, retried.id);
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
      // The original credential was retained: restoring the connection identity
      // provides valid capability evidence without swapping the frozen secret.
      configure(store, runtime.id, provider, "third-fixture-key");
      expect(store.claimTask(runtime.id)?.id).toBe(retried.id);
      expect(store.getTask(retried.id)?.waitReason).toBeNull();
      expect(taskProfile(store, retried.id, provider)).toEqual(saved);
    });
  }

  it("explains a legacy frozen profile whose original Runtime cannot be established", () => {
    const { store, runtime, saved, retry } = fixture();
    const retried = retry();
    // Simulate a pre-migration repooled snapshot, where no trusted origin was
    // recorded. The check lets this same regression run on the old schema.
    const hasOrigin = (db!.query("PRAGMA table_info(multiremi_tasks)").all() as { name: string }[])
      .some(column => column.name === "execution_runtime_id");
    db!.run(`UPDATE multiremi_tasks SET runtime_id = NULL${hasOrigin ? ", execution_runtime_id = NULL" : ""} WHERE id = ?`, [retried.id]);
    expect(store.claimTask(runtime.id)).toBeNull();
    expectFrozenWait(store, retried.id);
    expect(taskProfile(store, retried.id, "codex")).toEqual(saved);
  });

  it("explains a frozen retry immediately even when retirement leaves no Runtime to poll the queue", () => {
    const { store, runtime, retry } = fixture();
    const retried = retry();
    const plan = store.getDaemonRetirementPlan("local", runtime.daemonId!);
    expect(plan.canRetire).toBe(true);
    store.retireDaemon("local", runtime.daemonId!, plan.snapshot, "local");
    expect(store.listRuntimes()).toHaveLength(0);
    store.refreshQueuedCapabilityWaitReasons(Date.now());
    expectFrozenWait(store, retried.id);
  });

  for (const provider of ["codex", "claude"] as const) {
    it(`${provider}: native retries keep using the current Agent model and current capability rules`, () => {
      const store = createLocalStore();
      const runtime = store.registerRuntime({ name: "Native", provider, models: models(provider) });
      const agent = store.createAgent({ name: "Native retry", provider, model: MODEL, thinkingLevel: "high" });
      const task = store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Native retry" }).id, prompt: "work" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      store.failTask(task.id, { error: "stale session", failureReason: "agent_error.stale_session" });
      const retried = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
      store.updateAgent(agent.id, { model: NEXT_MODEL });
      expect(store.claimTask(runtime.id)).toBeNull();
      expect(store.getTask(retried.id)?.status).toBe("queued");
      store.updateRuntimeModels(runtime.id, models(provider, NEXT_MODEL));
      expect(store.claimTask(runtime.id)?.id).toBe(retried.id);
      expect(taskProfile(store, retried.id, provider)).toBeNull();
    });
  }

  it("finds runnable work beyond a page of rejected tasks without bypassing runtime capacity", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ name: "One slot", provider: "codex", models: models("codex"), maxConcurrency: 1 });
    const blocked = store.createAgent({ name: "Rejected queue", provider: "codex", model: NEXT_MODEL, thinkingLevel: "high" });
    for (let index = 0; index < 257; index++) store.createTask({ agentId: blocked.id, prompt: `blocked ${index}`, priority: 100 });
    const runnable = store.createAgent({ name: "Runnable", provider: "codex", model: MODEL, thinkingLevel: "high" });
    const first = store.createTask({ agentId: runnable.id, prompt: "first runnable", priority: 10 });
    const second = store.createTask({ agentId: runnable.id, prompt: "second runnable" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.startTask(first.id);
    store.completeTask(first.id, { output: "done" });
    expect(store.claimTask(runtime.id)?.id).toBe(second.id);
  });

  for (const change of ["runtime pin", "owner", "workspace", "execution group"] as const) {
    it(`frozen retry never bypasses ${change} routing restrictions`, () => {
      const { store, runtime, agent, retry } = fixture();
      const retried = retry();
      let claimantId = runtime.id;
      if (change === "runtime pin") {
        const other = store.registerRuntime({ name: "Pinned elsewhere", provider: "codex" });
        store.updateAgent(agent.id, { runtimeId: other.id });
      } else if (change === "owner") {
        store.updateRuntime(runtime.id, { ownerId: "another-owner" });
      } else if (change === "workspace") {
        store.createWorkspace({ id: "other-workspace", name: "Other" });
        const foreign = store.registerRuntime({
          name: "Foreign workspace", provider: "codex", workspaceId: "other-workspace",
          daemonId: "foreign-daemon", ownerId: "local", metadata: runtime.metadata,
        });
        configure(store, foreign.id, "codex");
        claimantId = foreign.id;
      } else {
        store.updateRuntime(runtime.id, { executionGroupId: "original-group" });
        store.registerRuntime({ name: "Other group", provider: "codex", executionGroupId: "other-group" });
        store.updateAgent(agent.id, { executionGroupId: "other-group" });
      }
      expect(store.claimTask(claimantId)).toBeNull();
      expect(store.getTask(retried.id)?.status).not.toBe("dispatched");
    });
  }

  it("stale dispatched retry uses its frozen requirements after the Agent model changes", () => {
    const { store, runtime, agent, saved, retry } = fixture();
    const retried = retry();
    expect(store.claimTask(runtime.id)?.id).toBe(retried.id);
    store.updateAgent(agent.id, { model: NEXT_MODEL });
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", retried.id]);
    expect(store.claimTask(runtime.id)?.id).toBe(retried.id);
    expect(taskProfile(store, retried.id, "codex")).toEqual(saved);
  });

  it("keeps claim query and placeholder counts bounded as one incompatible Agent's queue grows", () => {
    const samples: { tasks: number; statements: number; placeholders: number }[] = [];
    for (const count of [1, 10, 100]) {
      const store = createLocalStore();
      const runtime = store.registerRuntime({ name: "Measured", provider: "codex", models: models("codex") });
      const agent = store.createAgent({ name: "Unavailable model", provider: "codex", model: NEXT_MODEL, thinkingLevel: "high" });
      for (let index = 0; index < count; index++) store.createTask({ agentId: agent.id, prompt: `queued ${index}` });
      const query = spyOn(db!, "query");
      const run = spyOn(db!, "run");
      try {
        expect(store.claimTask(runtime.id)).toBeNull();
        const calls = [...query.mock.calls, ...run.mock.calls];
        samples.push({ tasks: count, statements: calls.length,
          placeholders: Math.max(...calls.map(([sql]) => (sql.match(/\?/g) ?? []).length)) });
      } finally {
        query.mockRestore(); run.mockRestore();
        resetMultiremiTestEnv();
      }
    }
    console.info("frozen-task-routing claim budget", JSON.stringify(samples));
    expect(samples[2]!.statements).toBeLessThanOrEqual(samples[0]!.statements + 10);
    expect(samples[2]!.placeholders).toBeLessThanOrEqual(Math.max(samples[0]!.placeholders, 64));
  });
});
