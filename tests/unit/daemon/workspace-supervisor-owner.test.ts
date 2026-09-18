import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireWorkspaceSupervisorLease,
  type WorkspaceSupervisorProcessProbe,
} from "@daemon/agent-runtime/workspace/process-owner.js";

describe("workspace supervisor process ownership", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects another live process across daemon ports and timezones", () => {
    const { root, stateRoot } = fixture("live");
    const lease = acquireWorkspaceSupervisorLease(root, { basePort: 6131, stateRoot });
    const moduleUrl = pathToFileURL(join(
      process.cwd(),
      "packages/daemon/src/agent-runtime/workspace/process-owner.ts",
    )).href;
    const child = spawnSync(process.execPath, ["-e", `
      import { acquireWorkspaceSupervisorLease } from ${JSON.stringify(moduleUrl)};
      try {
        acquireWorkspaceSupervisorLease(${JSON.stringify(root)}, {
          basePort: 7131,
          stateRoot: ${JSON.stringify(stateRoot)},
        });
        process.exit(2);
      } catch (error) {
        if (error?.code === "multiremi_workspace_supervisor_owned") process.exit(0);
        console.error(error);
        process.exit(3);
      }
    `], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    });

    expect(child.status).toBe(0);
    lease.assertOwner();
    lease.release();
  }, 15_000);

  it("recovers ownership after a process exits without releasing its generation", () => {
    const { root, stateRoot } = fixture("crash");
    const moduleUrl = pathToFileURL(join(
      process.cwd(),
      "packages/daemon/src/agent-runtime/workspace/process-owner.ts",
    )).href;
    const child = spawnSync(process.execPath, ["-e", `
      import { acquireWorkspaceSupervisorLease } from ${JSON.stringify(moduleUrl)};
      acquireWorkspaceSupervisorLease(${JSON.stringify(root)}, {
        basePort: 6131,
        stateRoot: ${JSON.stringify(stateRoot)},
      });
      process.exit(0);
    `], { cwd: process.cwd(), encoding: "utf8" });
    expect(child.status).toBe(0);

    const replacement = acquireWorkspaceSupervisorLease(root, { basePort: 7131, stateRoot });
    replacement.assertOwner();
    replacement.release();
  });

  it("uses the process start id to distinguish PID reuse", () => {
    const { root, stateRoot } = fixture("pid-reuse");
    const firstProbe = fakeProbe(4242, "old-process");
    const first = acquireWorkspaceSupervisorLease(root, { processProbe: firstProbe, stateRoot });
    const replacement = acquireWorkspaceSupervisorLease(root, {
      processProbe: fakeProbe(4242, "new-process"),
      stateRoot,
    });

    expect(() => first.assertOwner()).toThrow("lease was lost");
    replacement.assertOwner();
    replacement.release();
  });

  it("canonicalizes symlink aliases onto the same ownership root", () => {
    const parent = mkdtempSync(join(tmpdir(), "multiremi-supervisor-alias-"));
    roots.push(parent);
    const root = join(parent, "root");
    const alias = join(parent, "alias");
    const stateRoot = join(parent, "state");
    const lease = acquireWorkspaceSupervisorLease(root, { stateRoot });
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");

    expect(() => acquireWorkspaceSupervisorLease(alias, { stateRoot })).toThrow("already owns workspace root");
    lease.release();
  });

  it("pins a canonical root when the configured symlink is retargeted", () => {
    const parent = mkdtempSync(join(tmpdir(), "multiremi-supervisor-retarget-"));
    roots.push(parent);
    const firstRoot = join(parent, "first");
    const secondRoot = join(parent, "second");
    const alias = join(parent, "alias");
    const stateRoot = join(parent, "state");
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    symlinkSync(firstRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const first = acquireWorkspaceSupervisorLease(alias, { stateRoot });

    unlinkSync(alias);
    symlinkSync(secondRoot, alias, process.platform === "win32" ? "junction" : "dir");
    const second = acquireWorkspaceSupervisorLease(alias, { stateRoot });

    expect(first.workspaceRoot).toBe(realpathSync(firstRoot));
    expect(second.workspaceRoot).toBe(realpathSync(secondRoot));
    first.assertOwner();
    second.assertOwner();
    first.release();
    second.release();
  });

  it("keeps the external owner while a root is renamed and recreated", () => {
    const { parent, root, stateRoot } = fixture("root-replaced");
    const moved = join(parent, "moved");
    const lease = acquireWorkspaceSupervisorLease(root, { stateRoot });

    renameSync(root, moved);
    mkdirSync(root);

    expect(() => lease.assertOwner()).toThrow("root identity changed");
    expect(() => acquireWorkspaceSupervisorLease(root, { stateRoot })).toThrow("already owns workspace root");
    lease.release();

    const replacement = acquireWorkspaceSupervisorLease(root, { stateRoot });
    replacement.assertOwner();
    replacement.release();
  });

  it("preserves the prior owner if atomic release is interrupted", () => {
    const { root, stateRoot } = fixture("release-interrupted");
    let interrupt = true;
    const lease = acquireWorkspaceSupervisorLease(root, {
      stateRoot,
      beforeReleaseCommit: () => {
        if (interrupt) throw new Error("simulated release interruption");
      },
    });

    expect(() => lease.release()).toThrow("simulated release interruption");
    lease.assertOwner();
    expect(() => acquireWorkspaceSupervisorLease(root, { stateRoot })).toThrow("already owns workspace root");

    interrupt = false;
    lease.release();
    const replacement = acquireWorkspaceSupervisorLease(root, { stateRoot });
    replacement.assertOwner();
    replacement.release();
  });

  function fixture(label: string): { parent: string; root: string; stateRoot: string } {
    const parent = mkdtempSync(join(tmpdir(), `multiremi-supervisor-${label}-`));
    roots.push(parent);
    return {
      parent,
      root: join(parent, "workspaces"),
      stateRoot: join(parent, "state"),
    };
  }
});

function fakeProbe(pid: number, startId: string): WorkspaceSupervisorProcessProbe {
  return {
    pid,
    isAlive: () => true,
    startId: () => startId,
    now: () => new Date("2026-08-19T00:00:00.000Z"),
  };
}
