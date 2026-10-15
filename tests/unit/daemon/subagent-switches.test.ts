// The two PR 5 production switches. `bun test` strips every `REMI_*` variable
// (tests/setup/hermetic-env.ts), so each case sets and restores its own.
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon, type MultiremiDaemonOptions } from "@multiremi/daemon.js";
import type { AcpProviderOptions } from "@acp/provider.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";

const SWITCHES = ["REMI_ACP_NATIVE_SUBAGENTS", "REMI_ACP_AUTONOMOUS_ROUNDS"] as const;
const roots: string[] = [];

afterEach(() => {
  for (const name of SWITCHES) delete process.env[name];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A daemon whose provider factory records its options and stops the run there. */
function daemon(extra: Partial<MultiremiDaemonOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pr5-switches-"));
  roots.push(root);
  let received: AcpProviderOptions | undefined;
  const sentinel = new Error("provider captured");
  const value = new MultiremiDaemon({
    sshMeshManager: disabledSshMeshRuntime(),
    serverUrl: "http://127.0.0.1:1", token: "fixture", runtimeId: "fixture", provider: "claude",
    daemonId: "fixture", workspaceId: "local", gcEnabled: false, workspacesRoot: root,
    providerFactory: (options) => { received = options; throw sentinel; },
    ...extra,
  });
  const state = value as any;
  return {
    options: state.options as { nativeSubagents: boolean; autonomousRounds: boolean },
    /** The options the task's provider was created with. */
    async providerOptions(): Promise<AcpProviderOptions> {
      state.assertWorkspaceRootOwner = () => {};
      state.registerTaskRepos = async () => [];
      state.prepareTaskWorkspace = async () => ({ checkouts: [], repos: [], warnings: [] });
      state.enqueueTaskReport = () => {};
      const task = {
        id: "switch-test", workspaceId: "local", repos: [], projectResources: [], holdsWorkspace: false,
        agent: { id: "agent", name: "Test", provider: "claude", model: null, instructions: "" },
      } as unknown as MultiremiTaskWithAgent;
      await expect(state.runAgent(task, new AbortController().signal, { workDir: root, ensureDir: false }))
        .rejects.toThrow(sentinel.message);
      return received!;
    },
  };
}

describe("PR 5 switches", () => {
  it("both default on and reach the task provider", async () => {
    const value = daemon();
    expect(value.options).toMatchObject({ nativeSubagents: true, autonomousRounds: true });
    expect(await value.providerOptions()).toMatchObject({ nativeSubagentSessions: true, captureAutonomousRounds: true });
  });

  it("REMI_ACP_AUTONOMOUS_ROUNDS=0 turns off only the late-answer capture and wait", async () => {
    process.env.REMI_ACP_AUTONOMOUS_ROUNDS = "0";
    const value = daemon();
    expect(value.options).toMatchObject({ nativeSubagents: true, autonomousRounds: false });
    expect(await value.providerOptions()).toMatchObject({ nativeSubagentSessions: true, captureAutonomousRounds: false });
  });

  it("REMI_ACP_NATIVE_SUBAGENTS=0 turns off only the child sessions", async () => {
    process.env.REMI_ACP_NATIVE_SUBAGENTS = "0";
    const value = daemon();
    expect(value.options).toMatchObject({ nativeSubagents: false, autonomousRounds: true });
    expect(await value.providerOptions()).toMatchObject({ nativeSubagentSessions: false, captureAutonomousRounds: true });
  });

  it("an explicit option wins over the environment; any other value keeps it on", () => {
    process.env.REMI_ACP_AUTONOMOUS_ROUNDS = "0";
    process.env.REMI_ACP_NATIVE_SUBAGENTS = "1";
    expect(daemon({ autonomousRounds: true }).options).toMatchObject({ nativeSubagents: true, autonomousRounds: true });
    expect(daemon({ nativeSubagents: false, autonomousRounds: false }).options)
      .toMatchObject({ nativeSubagents: false, autonomousRounds: false });
  });
});
