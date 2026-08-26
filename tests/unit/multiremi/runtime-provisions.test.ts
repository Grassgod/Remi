import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import {
  MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS,
  RUNTIME_COMMAND_RUNNING_TIMEOUT_MS,
} from "@multiremi/runtime-command-policy.js";
import { buildNpmGlobalProvisionCommand } from "@multiremi/store/repos/runtime-provisions-repo.js";
import { executeRuntimeCommand } from "@multiremi/worker/runtime-command.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  resetMultiremiTestEnv();
});

describe("workspace Runtime provisions", () => {
  it("keeps the queue running deadline above the npm-global maximum", () => {
    expect(RUNTIME_COMMAND_RUNNING_TIMEOUT_MS).toBeGreaterThan(MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS);
  });

  it("does not reinstall an npm-global package whose expected version is already present", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const provision = store.createWorkspaceRuntimeProvision("local", {
      kind: "npm-global",
      package: "example-tool",
      version: "1.2.3",
      bin: "example-tool",
      enabled: false,
      triggerKinds: [],
    });
    const dir = makeTempDir();
    executable(join(dir, "example-tool"), "#!/bin/sh\necho 1.2.3\n");
    executable(join(dir, "npm"), `#!/bin/sh\ntouch ${shellQuote(join(dir, "npm-called"))}\n`);

    const result = await executeRuntimeCommand({
      command: `export PATH=${shellQuote(`${dir}:/usr/bin:/bin`)}\n${buildNpmGlobalProvisionCommand(provision)}`,
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.stdout).toContain("provision:already:1.2.3");
    expect(existsSync(join(dir, "npm-called"))).toBeFalse();
  });

  it("marks npm-global convergence failed when post-install binary verification fails", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_verify", name: "Verify", provider: "codex", workspaceId: "local" });
    const provision = store.createWorkspaceRuntimeProvision("local", {
      kind: "npm-global",
      package: "missing-tool",
      version: "1.0.0",
      bin: "missing-tool",
      enabled: false,
      triggerKinds: [],
    });
    store.updateWorkspaceRuntimeProvision(provision.id, { enabled: true });
    store.enqueueWorkspaceRuntimeProvision(provision.id);
    const request = store.claimRuntimeCommandRequest(runtime.id)!;
    const dir = makeTempDir();
    executable(join(dir, "npm"), "#!/bin/sh\nexit 0\n");

    const result = await executeRuntimeCommand({
      command: `export PATH=${shellQuote(`${dir}:/usr/bin:/bin`)}\n${request.command}`,
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({ status: "completed", exitCode: 1 });
    expect(result.stdout).toContain("provision:verify-failed");

    store.reportRuntimeCommandResult(runtime.id, request.id, result);
    expect(store.listRuntimeProvisionStates(provision.id)).toEqual([
      expect.objectContaining({ runtimeId: runtime.id, status: "failed" }),
    ]);
  });

  it("claims a due cron declaration once and recovers a NULL next_run_at orphan", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const provision = store.createWorkspaceRuntimeProvision("local", {
      kind: "command",
      command: "printf refresh",
      enabled: true,
      triggerKinds: ["cron"],
      cronExpression: "*/5 * * * * *",
    });
    const due = new Date("2026-08-26T08:00:00.000Z");
    db!.run("UPDATE multiremi_workspace_runtime_provisions SET next_run_at = ? WHERE id = ?", [due.toISOString(), provision.id]);

    expect(store.claimDueRuntimeProvisions(due).map((entry) => entry.id)).toEqual([provision.id]);
    expect(store.claimDueRuntimeProvisions(due)).toEqual([]);
    expect(store.recoverLostRuntimeProvisionSchedules(due)).toBe(1);
    expect(store.getWorkspaceRuntimeProvision(provision.id)?.nextRunAt).not.toBeNull();
  });

  it("dispatches due cron declarations through the scheduler and advances them", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_cron", name: "Cron", provider: "codex", workspaceId: "local" });
    const provision = store.createWorkspaceRuntimeProvision("local", {
      kind: "command",
      command: "printf refresh",
      triggerKinds: ["cron"],
      cronExpression: "*/5 * * * * *",
    });
    const due = new Date("2026-08-26T08:00:00.000Z");
    db!.run("UPDATE multiremi_workspace_runtime_provisions SET next_run_at = ? WHERE id = ?", [due.toISOString(), provision.id]);

    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 60_000 });
    expect(scheduler.tickRuntimeProvisions(due)).toBe(1);
    expect(store.claimRuntimeCommandRequest(runtime.id)?.provisionId).toBe(provision.id);
    expect(store.getWorkspaceRuntimeProvision(provision.id)?.nextRunAt).not.toBeNull();
  });

  it("enqueues on_register declarations when a Runtime first registers or reconnects", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const provision = store.createWorkspaceRuntimeProvision("local", {
      kind: "command",
      command: "printf register",
      triggerKinds: ["on_register"],
    });
    const runtime = store.registerRuntime({ id: "rt_register", name: "Register", provider: "codex", workspaceId: "local" });

    expect(store.listRuntimeProvisionStates(provision.id)).toEqual([
      expect.objectContaining({ runtimeId: runtime.id, status: "pending", lastCommandRequestId: expect.any(String) }),
    ]);
    const first = store.claimRuntimeCommandRequest(runtime.id)!;
    store.reportRuntimeCommandResult(runtime.id, first.id, { status: "completed", exitCode: 0 });
    store.registerRuntime({ id: runtime.id, name: "Register", provider: "codex", workspaceId: "local" });
    expect(store.claimRuntimeCommandRequest(runtime.id)?.id).not.toBe(first.id);
  });

  it("leaves offline Runtimes pending without failing the workspace batch", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_offline_provision", name: "Offline", provider: "codex", workspaceId: "local" });
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", runtime.id]);

    const provision = store.createWorkspaceRuntimeProvision("local", {
      kind: "command",
      command: "printf later",
      triggerKinds: ["on_change"],
    });

    expect(store.listRuntimeProvisionStates(provision.id)).toEqual([
      expect.objectContaining({ runtimeId: runtime.id, status: "pending", lastCommandRequestId: null }),
    ]);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_command_requests WHERE provision_id = ?").get(provision.id))
      .toEqual({ count: 0 });
  });
});

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "multiremi-provision-"));
  tempDirs.push(path);
  return path;
}

function executable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
