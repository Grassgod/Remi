import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import type { AcpProviderOptions } from "@acp/provider.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";

describe("daemon gateway context declarations", () => {
  it.each([false, true])("forwards declarations to the task provider (runtime profile=%s)", async custom => {
    const root = mkdtempSync(join(tmpdir(), "mul479-daemon-"));
    let received: AcpProviderOptions | undefined;
    const sentinel = new Error("provider captured");
    const daemon = new MultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: "http://127.0.0.1:1", token: "fixture", runtimeId: "fixture", provider: "claude",
      daemonId: "fixture", workspaceId: "local", gcEnabled: false, workspacesRoot: root,
      providerFactory: options => { received = options; throw sentinel; },
    });
    const state = daemon as any;
    state.workspaceRelays.set("local", {
      claude: { fragment: "{}", auth_token: "fixture-key", revision: 1, one_million_models: ["claude-opus-5"] },
      codex: null,
    });
    const profile = custom ? {
      name: "custom", base_url: "https://custom.example", model: "claude-opus-5",
      auth_mode: "api_key", auth_header: "x-api-key", env_key: "",
    } : null;
    state.runtimeProfileKey = async () => "fixture-key";
    state.assertWorkspaceRootOwner = () => {};
    state.registerTaskRepos = async () => [];
    state.prepareTaskWorkspace = async () => ({});
    state.enqueueTaskReport = () => {};
    const task = {
      id: "context-test", workspaceId: "local", repos: [], projectResources: [], holdsWorkspace: false,
      agent: { id: "test-agent", name: "Test", provider: "claude", model: "claude-opus-5", instructions: "" },
      claudeProfile: profile,
    } as unknown as MultiremiTaskWithAgent;
    try {
      const relay = await state.effectiveWorkspaceRelay("local", null, profile);
      const declarations = relay.claude?.one_million_models ?? [];
      await expect(state.runAgent(
        task, new AbortController().signal, { workDir: root, ensureDir: false },
        undefined, undefined, undefined, undefined, undefined, declarations,
      )).rejects.toThrow(sentinel.message);
      expect(received?.claudeOneMillionModels).toEqual(custom ? [] : ["claude-opus-5"]);
      expect(received?.model).toBe("claude-opus-5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
