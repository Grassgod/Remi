import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const originalEncryptionKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalEncryptionKey;
  resetMultiremiTestEnv();
});

type Provider = "codex" | "claude";
const migrate = () => runMigrations(db! as unknown as SqlDatabase);
const origin = (taskId: string) => (db!.query(
  "SELECT execution_runtime_id FROM multiremi_tasks WHERE id = ?",
).get(taskId) as { execution_runtime_id: string | null }).execution_runtime_id;

function legacyRetry(provider: Provider, mode: "env" | "api_key") {
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 71).toString("base64");
  const store = createLocalStore();
  const first = store.registerRuntime({ id: "provenance-first", name: "Original runtime", provider,
    workspaceId: "local", ownerId: "local", daemonId: "provenance-first-daemon",
    metadata: { [`${provider}_profiles`]: 1 } });
  const connection = { name: "original", base_url: "https://original.example/v1", model: "original-model",
    auth_mode: mode, env_key: mode === "env" ? `REMI_${provider.toUpperCase()}_KEY` : "" };
  const saved = provider === "codex"
    ? store.setRuntimeCodexProfile(first.id, connection, mode === "api_key" ? "fixture-original-key" : undefined)!
    : store.setRuntimeClaudeProfile(first.id, connection, mode === "api_key" ? "fixture-original-key" : undefined)!;
  const agent = store.createAgent({ name: "Historical worker", provider, model: saved.model });
  const issue = store.createIssue({ title: "Historical retry" });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "keep original connection" });
  expect(store.claimTask(first.id)?.id).toBe(task.id);
  store.startTask(task.id);
  store.failTask(task.id, { error: "stale session", failureReason: "agent_error.stale_session" });
  const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
  expect(retry).toBeDefined();
  const next = store.registerRuntime({ id: "provenance-next", name: "Later claimant", provider,
    workspaceId: "local", ownerId: "local", daemonId: "provenance-next-daemon",
    metadata: { [`${provider}_profiles`]: 1 } });
  // The old scheduler can assign R1's repooled snapshot to R2 before upgrade.
  db!.run("UPDATE multiremi_tasks SET execution_runtime_id = NULL, runtime_id = ? WHERE id = ?", [next.id, retry.id]);
  db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", ["20260918_task_execution_runtime"]);
  return { store, first, next, retry, saved, provider };
}

function expectUnknownAndUnclaimable(fixture: ReturnType<typeof legacyRetry>) {
  migrate();
  expect(origin(fixture.retry.id)).toBeNull();
  expect(fixture.store.claimTask(fixture.next.id)).toBeNull();
  fixture.store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
  expect(fixture.store.getTask(fixture.retry.id)).toMatchObject({ status: "queued",
    waitReason: expect.stringContaining("历史快照缺少来源 Runtime") });
}

describe("historical frozen connection provenance", () => {
  for (const provider of ["codex", "claude"] as const) {
    it(`${provider}: never attributes an env-auth snapshot to a later claimant`, () => {
      const fixture = legacyRetry(provider, "env");
      expectUnknownAndUnclaimable(fixture);
      expect(fixture.store.getTask(fixture.retry.id)?.[provider === "codex" ? "codexProfile" : "claudeProfile"])
        .toEqual(fixture.saved);
    });

    it(`${provider}: infers API-key provenance from its retained credential owner, never the claimant`, () => {
      const { store, first, next, retry, saved } = legacyRetry(provider, "api_key");
      migrate();
      expect(origin(retry.id)).toBe(first.id);
      expect(store.claimTask(next.id)).toBeNull();
      // Restore scheduling eligibility without changing frozen provenance.
      db!.run("UPDATE multiremi_tasks SET runtime_id = NULL WHERE id = ?", [retry.id]);
      expect(store.claimTask(first.id)?.id).toBe(retry.id);
      expect(store.getTask(retry.id)?.[provider === "codex" ? "codexProfile" : "claudeProfile"])
        .toEqual(saved);
    });

    it(`${provider}: a deleted API-key version has no provable origin and fails closed`, () => {
      const fixture = legacyRetry(provider, "api_key");
      db!.run("DELETE FROM multiremi_runtime_provider_credentials WHERE id = ?", [fixture.saved.credential_id!]);
      expectUnknownAndUnclaimable(fixture);
    });

    it(`${provider}: credential ownership in another workspace is not provenance`, () => {
      const fixture = legacyRetry(provider, "api_key");
      db!.run("UPDATE multiremi_runtimes SET workspace_id = 'other-workspace' WHERE id = ?", [fixture.first.id]);
      expectUnknownAndUnclaimable(fixture);
    });

    it(`${provider}: credential ownership on another provider is not provenance`, () => {
      const fixture = legacyRetry(provider, "api_key");
      db!.run("UPDATE multiremi_runtimes SET provider = ? WHERE id = ?", [provider === "codex" ? "claude" : "codex", fixture.first.id]);
      expectUnknownAndUnclaimable(fixture);
    });

    it(`${provider}: conflicting stored provider and profile do not establish provenance`, () => {
      const fixture = legacyRetry(provider, "api_key");
      db!.run("UPDATE multiremi_tasks SET provider = ? WHERE id = ?", [provider === "codex" ? "claude" : "codex", fixture.retry.id]);
      migrate();
      expect(origin(fixture.retry.id)).toBeNull();
      expect(fixture.store.claimTask(fixture.next.id)).toBeNull();
    });

    it(`${provider}: ambiguous dual-provider snapshots do not establish provenance`, () => {
      const fixture = legacyRetry(provider, "api_key");
      const otherColumn = provider === "codex" ? "claude_profile" : "codex_profile";
      db!.run(`UPDATE multiremi_tasks SET ${otherColumn} = ? WHERE id = ?`, [JSON.stringify(fixture.saved), fixture.retry.id]);
      migrate();
      expect(origin(fixture.retry.id)).toBeNull();
    });

    it(`${provider}: legacy null provider can use the unambiguous profile's credential owner`, () => {
      const fixture = legacyRetry(provider, "api_key");
      db!.run("UPDATE multiremi_tasks SET provider = NULL, runtime_id = NULL WHERE id = ?", [fixture.retry.id]);
      migrate();
      expect(origin(fixture.retry.id)).toBe(fixture.first.id);
    });
  }

  it("honors explicitly encoded transition provenance even after its source disappeared", () => {
    const fixture = legacyRetry("codex", "env");
    db!.run("UPDATE multiremi_tasks SET execution_fingerprint = ? WHERE id = ?",
      ["chat-workspace-transition-retired%3Asource:frozen", fixture.retry.id]);
    migrate();
    expect(origin(fixture.retry.id)).toBe("retired:source");
  });

  for (const fingerprint of ["chat-workspace-transition-:frozen", "chat-workspace-transition-%E0%A4:frozen",
    "chat-workspace-transition-missing-separator"]) {
    it(`does not replace explicit unknown or malformed transition provenance: ${fingerprint}`, () => {
      const fixture = legacyRetry("codex", "api_key");
      db!.run("UPDATE multiremi_tasks SET execution_fingerprint = ? WHERE id = ?", [fingerprint, fixture.retry.id]);
      migrate();
      expect(origin(fixture.retry.id)).toBeNull();
    });
  }

  it("recovers new snapshots written by a rolled-back binary even when the migration ledger is already stamped", () => {
    const fixture = legacyRetry("codex", "api_key");
    migrate();
    db!.run("INSERT INTO multiremi_schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
      ["20260918_task_execution_runtime", new Date().toISOString()]);
    // The older binary still creates tasks but never writes the new origin
    // column. Recovery must see these rows on the next forward upgrade.
    const later = fixture.store.createTask({ agentId: fixture.retry.agentId, prompt: "created during rollback" });
    db!.run(`UPDATE multiremi_tasks SET provider = 'codex', execution_fingerprint = 'legacy-frozen',
      codex_profile = ?, runtime_id = ? WHERE id = ?`, [JSON.stringify(fixture.saved), fixture.next.id, later.id]);
    migrate();
    expect(origin(later.id)).toBe(fixture.first.id);
    db!.run("UPDATE multiremi_tasks SET runtime_id = NULL WHERE id = ?", [later.id]);
    migrate();
    expect(origin(later.id)).toBe(fixture.first.id);
  });

  it("never rewrites recorded provenance even if credential ownership or claimant later differs", () => {
    const fixture = legacyRetry("codex", "api_key");
    db!.run("UPDATE multiremi_tasks SET execution_runtime_id = ? WHERE id = ?", [fixture.first.id, fixture.retry.id]);
    db!.run("UPDATE multiremi_runtime_provider_credentials SET runtime_id = ? WHERE id = ?", [fixture.next.id, fixture.saved.credential_id!]);
    migrate();
    expect(origin(fixture.retry.id)).toBe(fixture.first.id);
  });
});
