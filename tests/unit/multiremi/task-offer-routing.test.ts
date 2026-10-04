import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitTaskOfferToBudget } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { normalizeDaemonClaimTask } from "@multiremi/worker/client.js";
import { LocalPathLocker, resolveTaskWorkDir } from "@daemon/agent-runtime/workspace/ephemeral.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("large instructions preserve Project-bound Chat execution directory and provider resume identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "mul498-chat-route-")); roots.push(root);
  const path = join(root, "project"); mkdirSync(path);
  const payload: Record<string, any> = {
    id: "task", prompt: "continue", workspace_id: "local", runtime_id: "runtime", auth_token: "fixture-capability",
    chat_session_id: "chat", chat_project_id: "project", execution_scope: "delegation:bound-chat",
    session_id: "provider-current", prior_session_id: "provider-prior", work_dir: path, prior_work_dir: path,
    branch_name: "agent/MUL-498", execution_fingerprint: "chat-workspace:bound:local:hash",
    claude_profile: { name: "connection", base_url: "https://example.com", model: "model", env_key: "REMI_CLAUDE_TEST_KEY", credential_id: "rck_fixture" },
    plugin_snapshot: [{ pluginId: "plugin", bindingId: "binding", versionId: "version", name: "Plugin", provider: "codex",
      version: "1", digest: "a".repeat(64), artifactUrl: "/api/artifacts/plugin", config: { cwd: path } }],
    workspace_env: { WORKSPACE_HOME: path },
    agent: { id: "agent", name: "Agent", provider: "codex", instructions: "x".repeat(700_000) },
    project: { id: "project", title: "Bound project" }, repos: [],
    project_resources: [{ id: "resource", resource_type: "local_directory",
      resource_ref: { local_path: path, daemon_id: "owner", branch: "main" }, label: "Display label" }],
  };
  const before = normalizeDaemonClaimTask(structuredClone(payload))!;
  const binding = structuredClone(payload.project_resources);
  const fit = fitTaskOfferToBudget(payload, "runtime");
  expect(fit.report.steps).toContain("optional_context");
  expect(payload.project_resources).toEqual(binding);
  expect(payload).toMatchObject({ auth_token: "fixture-capability", chat_project_id: "project",
    session_id: "provider-current", prior_session_id: "provider-prior", work_dir: path, prior_work_dir: path,
    branch_name: "agent/MUL-498", execution_scope: "delegation:bound-chat", execution_fingerprint: "chat-workspace:bound:local:hash" });
  const after = normalizeDaemonClaimTask(payload)!;
  for (const key of ["projectResources", "chatProjectId", "sessionId", "priorSessionId", "workDir", "priorWorkDir", "branchName", "execution_scope", "claudeProfile", "pluginSnapshot", "workspaceEnv"] as const) {
    expect(after[key]).toEqual(before[key]);
  }
  const options = { daemonIds: ["owner"], workspacesRoot: root, locker: new LocalPathLocker(),
    signal: new AbortController().signal, onWaitLocalDirectory() {} };
  const resolvedBefore = await resolveTaskWorkDir(before, options);
  resolvedBefore.release?.();
  const resolvedAfter = await resolveTaskWorkDir(after, options);
  try {
    expect(resolvedAfter.workDir).toBe(resolvedBefore.workDir);
    expect(resolvedAfter.workDir).toBe(path);
    expect(resolvedAfter.localDirectory).toBeTrue();
    expect(resolvedAfter.resetSession).toBe(resolvedBefore.resetSession);
  } finally { resolvedAfter.release?.(); }
});

test("even an irreducible offer retains Runtime workspace, branch and resume bindings for failure diagnostics", () => {
  const workspace = { id: "workspace", daemonId: "owner", rootPath: "/tmp/root", cwd: "subdirectory",
    status: "active", hydration: "existing", branchName: "main", archivedAt: null };
  const payload: Record<string, any> = { id: "task", prompt: "run", runtime_workspace_id: "workspace",
    runtime_workspace: workspace, prior_session_id: "provider", prior_work_dir: "/tmp/root/subdirectory",
    execution_scope: "workspace:workspace", execution_fingerprint: "FINGERPRINT".repeat(20), plugin_snapshot: [],
    claude_profile: { name: "connection", env_key: "REMI_CLAUDE_" + "KEY".repeat(30), base_url: "https://example.com", model: "model" },
    workspace_env: { CUSTOM_SETTING: "SETTING".repeat(25) }, repos: new Array(600_000).fill(0) };
  const original = structuredClone(payload);
  const fit = fitTaskOfferToBudget(payload, "runtime", 16 * 1024);
  expect(fit.report.bytes).toBeGreaterThan(1_048_576);
  expect(payload.runtime_workspace).toEqual(workspace);
  expect(payload.prior_session_id).toBe("provider");
  expect(payload.prior_work_dir).toBe("/tmp/root/subdirectory");
  expect(payload.execution_scope).toBe("workspace:workspace");
  for (const key of ["execution_fingerprint", "plugin_snapshot", "claude_profile", "workspace_env"]) expect(payload[key]).toEqual(original[key]);
});
