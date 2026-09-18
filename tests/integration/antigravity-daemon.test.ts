import { expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { isolateProcessTmp, PrivateTmpIsolationUnavailableError } from "@acp/index.js";

it("runs native Antigravity through API, daemon, Chat resume and an Issue in a retained directory", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remi-agy-daemon-")));
  const database = new Database(":memory:");
  const store = new MultiremiStore(database);
  store.ensureLocalWorkspace();
  const local = join(root, "user-project");
  const capture = join(root, "capture.json");
  const isolationProbe = join(root, "isolation-probe");
  mkdirSync(local);
  mkdirSync(isolationProbe);
  writeFileSync(capture, "");
  let isolationUnavailable: PrivateTmpIsolationUnavailableError | null = null;
  try {
    isolateProcessTmp({ executable: Bun.which("true") ?? "true", args: [] }, isolationProbe);
  } catch (error) {
    if (!(error instanceof PrivateTmpIsolationUnavailableError)) throw error;
    isolationUnavailable = error;
  }
  writeFileSync(join(local, "AGENTS.md"), "AGY_LOCAL_CONTEXT_SENTINEL");
  writeFileSync(join(local, "user-file.txt"), "retained");
  const agent = store.createAgent({ name: "AGY", provider: "antigravity", executable: Bun.which("node") ?? process.execPath,
    customArgs: [resolve("tests/fixtures/antigravity-cli.mjs")],
    customEnv: { FAKE_AGY_CAPTURE: capture, FAKE_AGY_MODE: "tool" },
  });
  const token = await store.createAccessToken({ name: "AGY test daemon", type: "daemon", workspaceId: "local", daemonId: "agy-test-machine" });
  const server = startMultiremiServer({ store, scheduler: null, authToken: "agy-test-root", hostname: "127.0.0.1", port: 0 });
  const daemon = new MultiremiDaemon({
    serverUrl: `http://127.0.0.1:${server.port}`, token: token.token, daemonId: "agy-test-machine", runtimeName: "AGY integration",
    provider: "antigravity", workspaceId: "local", daemonPort: 0, pollIntervalMs: 20, gcEnabled: false,
    workspacesRoot: join(root, "state"), repoCacheRoot: join(root, "repo-cache"),
  });
  // Do not load the developer's global instructions or installed skills.
  const homeSpy = spyOn(os, "homedir").mockReturnValue(join(root, "user-home"));
  const run = daemon.start();
  try {
    await poll(() => store.listRuntimes().length > 0);
    const runtime = store.listRuntimes()[0]!;
    expect(runtime.provider).toBe("antigravity");
    const directory = store.runtimeWorkspaces.create(runtime.id, { name: "User project", root_path: local });
    const chat = store.createChatSession({ agentId: agent.id, runtime_workspace_id: directory.id });
    for (const action of ["chat", "resume", "issue"]) {
      const task = action === "issue"
        ? store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Use agy", runtime_workspace_id: directory.id }).id, prompt: "Inspect project" })
        : store.sendChatMessage(chat.id, { body: "Inspect project" }).task;
      await poll(() => ["completed", "failed"].includes(store.getTask(task.id)?.status ?? ""));
      const complete = store.getTask(task.id)!;
      if (isolationUnavailable) {
        expect(complete.status).toBe("failed");
        expect(complete.error).toContain("[private_tmp_isolation_unavailable]");
        expect(complete.error).toContain("runtime cannot create a private /tmp mount");
        break;
      }
      expect(complete.error).toBeNull();
      expect(complete.status).toBe("completed");
      expect(complete.sessionId).toBe("12345678-1234-1234-1234-123456789abc");
      const invocation = JSON.parse(readFileSync(capture, "utf8"));
      expect(invocation.cwd).toBe(local);
      expect(invocation.prompt).toContain("AGY_LOCAL_CONTEXT_SENTINEL");
      expect(invocation.contextDir).toContain(join(root, "state"));
      expect(invocation.token).toBeTruthy();
      expect(invocation.token).not.toBe(token.token);
      if (action === "resume") expect(invocation.args).toContain("--conversation");
    }
    expect(readFileSync(join(local, "user-file.txt"), "utf8")).toBe("retained");
    expect(readFileSync(join(local, "AGENTS.md"), "utf8")).toBe("AGY_LOCAL_CONTEXT_SENTINEL");
    expect(existsSync(join(local, ".multiremi"))).toBe(false);
    expect(existsSync(join(local, ".agents"))).toBe(false);
    expect(existsSync(join(root, "repo-cache"))).toBe(false);
  } finally {
    daemon.stop();
    await run.catch(() => {});
    homeSpy.mockRestore();
    server.stop(true);
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60_000);

async function poll(check: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Antigravity daemon test timed out");
    await Bun.sleep(30);
  }
}
