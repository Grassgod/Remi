import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { normalizeTaskRuntimeProfile, runtimeProfileCapabilityIdentity } from "@multiremi/store/task-execution-requirements.js";
import { parseRuntimeCodexProfile } from "@multiremi/contracts/codex-profile.js";
import { parseRuntimeClaudeProfile } from "@multiremi/contracts/claude-profile.js";

const profile = { name: "original", base_url: "https://models.example/v1", model: "model-a", env_key: "REMI_CODEX_KEY" };

describe("historical frozen profile dispatch normalization", () => {
  it("preserves the exact frozen credential and upstream while stripping unsupported metadata", () => {
    const frozen = { ...profile, auth_mode: "api_key", credential_id: "rck_frozen", future_field: "default" };
    const before = JSON.stringify(frozen);
    const wire = normalizeTaskRuntimeProfile("codex", frozen);
    expect(wire).toEqual({ ...profile, auth_mode: "api_key", env_key: "", credential_id: "rck_frozen" });
    expect(parseRuntimeCodexProfile(wire)).toEqual(wire);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(wire).not.toBe(frozen);
  });

  it("applies historical Claude defaults in a profile accepted by the daemon parser", () => {
    const frozen = { ...profile, env_key: "REMI_CLAUDE_KEY", future_field: null };
    const wire = normalizeTaskRuntimeProfile("claude", frozen);
    expect(wire).toEqual({ ...profile, env_key: "REMI_CLAUDE_KEY", auth_mode: "env", auth_header: "bearer" });
    expect(parseRuntimeClaudeProfile(wire)).toEqual(wire);
    expect(normalizeTaskRuntimeProfile("claude", { ...frozen, auth_header: "x-api-key" })?.auth_mode).toBe("env");
  });

  it("does not repair invalid execution or credential fields into an executable profile", () => {
    expect(normalizeTaskRuntimeProfile("codex", { ...profile, auth_mode: "api_key", credential_id: "invalid" })).toBeNull();
    expect(normalizeTaskRuntimeProfile("codex", { ...profile, model: "" })).toBeNull();
    expect(normalizeTaskRuntimeProfile("claude", { ...profile, env_key: "REMI_CLAUDE_KEY", auth_header: "invalid" })).toBeNull();
    expect(normalizeTaskRuntimeProfile("codex", { ...profile, base_url: "https://user:password@models.example" })).toBeNull();
  });
});

describe("frozen profile capability identity", () => {
  it("ignores credential rotation, presentation fields and schema metadata", () => {
    const frozen = { ...profile, auth_mode: "api_key", credential_id: "rck_old" };
    const live = { ...frozen, name: "renamed", credential_id: "rck_new", future_field: "default", env_key: "" };
    const identity = runtimeProfileCapabilityIdentity("codex", frozen);
    expect(identity).not.toBeNull();
    expect(runtimeProfileCapabilityIdentity("codex", live)).toBe(identity);
  });

  it("uses contract defaults and URL normalization for historical snapshots", () => {
    const old = { ...profile, base_url: "https://MODELS.example:443/v1/", env_key: "REMI_CLAUDE_KEY" };
    const current = { ...old, base_url: profile.base_url, auth_mode: "env", auth_header: "bearer" };
    expect(runtimeProfileCapabilityIdentity("claude", old)).toBe(runtimeProfileCapabilityIdentity("claude", current));
    expect(runtimeProfileCapabilityIdentity("claude", old)).not.toBeNull();
  });

  it("checks the frozen selected model independently of the live default", () => {
    const live = { ...profile, model: "model-b" };
    expect(runtimeProfileCapabilityIdentity("codex", live)).not.toBe(runtimeProfileCapabilityIdentity("codex", profile));
    expect(runtimeProfileCapabilityIdentity("codex", live, profile.model)).toBe(runtimeProfileCapabilityIdentity("codex", profile));
  });

  it("does not equate different endpoints, authentication modes or environment references", () => {
    const identity = runtimeProfileCapabilityIdentity("codex", profile);
    for (const change of [
      { base_url: "https://other.example/v1" },
      { base_url: "https://models.example/other" },
      { auth_mode: "api_key" },
      { env_key: "REMI_CODEX_OTHER_KEY" },
    ]) expect(runtimeProfileCapabilityIdentity("codex", { ...profile, ...change })).not.toBe(identity);
    const claude = { ...profile, env_key: "REMI_CLAUDE_KEY" };
    expect(runtimeProfileCapabilityIdentity("claude", { ...claude, auth_header: "x-api-key" }))
      .not.toBe(runtimeProfileCapabilityIdentity("claude", claude));
  });

  it("rejects unknown providers and invalid capability fields", () => {
    expect(runtimeProfileCapabilityIdentity("other", profile)).toBeNull();
    for (const invalid of [null, [], {}, { ...profile, base_url: "file:///tmp/provider" },
      { ...profile, env_key: "UNRELATED_SECRET" }, { ...profile, model: "" }]) {
      expect(runtimeProfileCapabilityIdentity("codex", invalid)).toBeNull();
    }
  });
});

let db: Database | null = null;
afterEach(() => { db?.close(); db = null; });

describe("frozen execution Runtime migration", () => {
  it("backfills known origins, honors transition provenance, and leaves ambiguous snapshots unknown", () => {
    db = new Database(":memory:");
    const migrate = () => runMigrations(db! as unknown as SqlDatabase);
    migrate();
    // Real task writes follow workspace resolution (which ensures "local").
    // This raw-SQL fixture also needs that lifecycle-lock owner; orphaned rows
    // must not be recovered without a row that serializes Runtime identity edits.
    db.run(`INSERT INTO multiremi_workspaces (id, name, slug, created_at, updated_at)
      VALUES ('local', 'Local Workspace', 'local', '2026-09-18', '2026-09-18')`);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", ["20260918_task_execution_runtime"]);
    const insert = (id: string, runtime: string | null, fingerprint: string | null, frozen: boolean, origin: string | null = null) => {
      db!.run(`INSERT INTO multiremi_tasks (id, agent_id, prompt, status, created_at, updated_at,
        runtime_id, execution_fingerprint, codex_profile, execution_runtime_id)
        VALUES (?, 'agent', 'test', 'queued', '2026-09-18', '2026-09-18', ?, ?, ?, ?)`,
      [id, runtime, fingerprint, frozen ? JSON.stringify(profile) : null, origin]);
    };
    insert("known", "rt_original", "frozen", true);
    // A mutable dispatch pin is not provenance. This known API-key snapshot
    // has immutable credential ownership; the retired env source has an
    // explicitly encoded transition source. Keep the same migration outcomes
    // while requiring evidence that remains valid after repool/reassignment.
    db.run(`INSERT INTO multiremi_runtimes (id, name, provider, status, workspace_id, created_at, updated_at)
      VALUES ('rt_original', 'Origin', 'codex', 'online', 'local', '2026-09-18', '2026-09-18')`);
    db.run(`INSERT INTO multiremi_runtime_provider_credentials (id, runtime_id, ciphertext)
      VALUES ('rck_known', 'rt_original', 'unused-fixture-ciphertext')`);
    db.run("UPDATE multiremi_tasks SET workspace_id = 'local', provider = 'codex', codex_profile = ? WHERE id = 'known'",
      [JSON.stringify({ ...profile, auth_mode: "api_key", env_key: "", credential_id: "rck_known" })]);
    insert("retired", "rt_already_deleted", "chat-workspace-transition-rt_already_deleted:frozen", true);
    insert("ambiguous", null, "frozen", true);
    insert("fresh", "rt_selected", null, true);
    insert("native", "rt_selected", "native-fingerprint", false);
    insert("transition", "rt_destination", "chat-workspace-transition-rt_source%3Aencoded:frozen", true);
    insert("unknown-transition", "rt_destination", "chat-workspace-transition-:frozen", true);
    insert("invalid-transition", "rt_destination", "chat-workspace-transition-%E0%A4:frozen", true);
    insert("incomplete-transition", "rt_destination", "chat-workspace-transition-rt_unproven", true);
    insert("already-recorded", "rt_destination", "frozen", true, "rt_original");
    migrate();
    const origins = Object.fromEntries((db.query("SELECT id, execution_runtime_id FROM multiremi_tasks").all() as
      Array<{ id: string; execution_runtime_id: string | null }>).map(row => [row.id, row.execution_runtime_id]));
    expect(origins).toEqual({
      known: "rt_original", retired: "rt_already_deleted", ambiguous: null, fresh: null, native: null,
      transition: "rt_source:encoded", "unknown-transition": null, "invalid-transition": null,
      "incomplete-transition": null, "already-recorded": "rt_original",
    });
    // Re-running startup after a claim/re-pool must never infer new provenance.
    db.run("UPDATE multiremi_tasks SET runtime_id = 'rt_later_claimant'");
    migrate();
    expect(db.query("SELECT execution_runtime_id FROM multiremi_tasks WHERE id = 'known'").get())
      .toEqual({ execution_runtime_id: "rt_original" });
    expect(db.query("SELECT execution_runtime_id FROM multiremi_tasks WHERE id = 'ambiguous'").get())
      .toEqual({ execution_runtime_id: null });
  });
});
