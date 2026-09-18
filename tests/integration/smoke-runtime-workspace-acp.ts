#!/usr/bin/env bun

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";

// Manual smoke: uses the host's existing provider login and sends two real prompts.
// All workspace files and daemon state are synthetic and owned by this script.
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: bun run tests/integration/smoke-runtime-workspace-acp.ts [--provider=codex|claude] [--model=MODEL]");
  process.exit(0);
}
for (const arg of args) assert.match(arg, /^--(?:provider|model)=.+$/, `Unknown argument: ${arg}`);
const provider = args.find(arg => arg.startsWith("--provider="))?.slice(11) ?? "codex";
assert(provider === "codex" || provider === "claude", "Unsupported provider");
const model = args.find(arg => arg.startsWith("--model="))?.slice(8) ?? null;
const timeoutMs = 120_000;
const root = mkdtempSync(join(tmpdir(), "remi-runtime-workspace-acp-"));
const workbench = join(root, "workbench");
const cwd = join(workbench, "app");
const state = join(root, "daemon-state");
const skill = join(workbench, ".agents", "skills", "runtime-workspace-smoke");
const expected = Object.fromEntries(["parent", "extra", "skill", "seed", "env"].map(key => [key, `${key}-${randomUUID()}`]));
const db = new Database(":memory:");
const store = new MultiremiStore(db);
store.ensureLocalWorkspace();
const server = startMultiremiServer({ store, scheduler: null, authToken: randomUUID(), hostname: "127.0.0.1", port: 0 });
const results: Array<Record<string, unknown>> = [];
let daemon: MultiremiDaemon | null = null;
let daemonRun: Promise<void> | null = null;
let failure: unknown = null;

try {
  mkdirSync(join(cwd, ".local-context"), { recursive: true });
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(workbench, "AGENT.md"), `For runtime-workspace-smoke proofs, set the parent field to ${expected.parent}.\n`);
  writeFileSync(join(workbench, "extra-context.md"), `For runtime-workspace-smoke proofs, set the extra field to ${expected.extra}.\n`);
  writeFileSync(join(cwd, ".env.local"), `LOCAL_DEPENDENCY_FLAG=${expected.env}\n`);
  writeFileSync(join(cwd, ".gitignore"), ".local-context/\n.env.local\nproof-*.json\n");
  writeFileSync(join(cwd, ".local-context", "seed.txt"), expected.seed!);
  writeFileSync(join(skill, "support.txt"), expected.skill!);
  writeFileSync(join(skill, "SKILL.md"), [
    "---", "name: runtime-workspace-smoke", "description: Use when asked to verify a runtime workspace and write a proof JSON file.", "---",
    "Write the requested proof JSON in the current directory with these string fields:",
    "- parent: the marker from your local parent instructions.",
    "- extra: the marker from your explicitly added local context.",
    "- skill: read support.txt beside this SKILL.md, using this skill's original absolute path.",
    "- seed: read .local-context/seed.txt in your working directory.",
    "- env: read LOCAL_DEPENDENCY_FLAG from the process environment using a shell command.",
    "- cwd: obtain the real current directory from a shell command.",
    "Do not modify the source files. When asked to reuse a previous proof, read it and include its seed field as previousSeed.",
  ].join("\n"));
  const originalFiles = ["AGENT.md", "extra-context.md", "app/.env.local", "app/.gitignore", "app/.local-context/seed.txt", ".agents/skills/runtime-workspace-smoke/SKILL.md", ".agents/skills/runtime-workspace-smoke/support.txt"];
  const originals = new Map(originalFiles.map(path => [path, readFileSync(join(workbench, path), "utf8")]));
  const daemonId = `workspace-smoke-${randomUUID()}`;
  const token = await store.createAccessToken({ name: "Runtime workspace native smoke", type: "daemon", workspaceId: "local", daemonId });
  const agent = store.createAgent({ name: "Runtime workspace native smoke", provider, model });
  let workspaceId: string | null = null;

  for (const surface of ["chat", "issue"] as const) {
    // Restart the worker between tasks; persistence must not depend on its memory.
    daemon = new MultiremiDaemon({
      serverUrl: `http://127.0.0.1:${server.port}`, token: token.token, daemonId,
      provider, runtimeName: `workspace-${provider}-smoke`, workspaceId: "local",
      daemonPort: 0, pollIntervalMs: 50, gcEnabled: false, taskTimeoutMs: timeoutMs,
      humanRequestTimeoutMs: 15_000, workspacesRoot: state, repoCacheRoot: join(root, "repo-cache"),
    });
    let daemonError: unknown = null;
    daemonRun = daemon.start().catch(error => { daemonError = error; });
    await waitFor(() => store.listRuntimes().some(runtime => runtime.status === "online"), 15_000, () => daemonError);
    if (!workspaceId) {
      const runtime = store.listRuntimes().find(runtime => runtime.status === "online")!;
      assert.equal(runtime.metadata.runtime_workspaces, 1);
      workspaceId = store.runtimeWorkspaces.create(runtime.id, {
        name: "Synthetic private workbench", root_path: workbench, cwd: "app",
        context_paths: ["extra-context.md"], env_file: "app/.env.local",
      }).id;
    }
    const prompt = `Use the runtime-workspace-smoke skill from your local catalog and follow the local parent and extra instructions. Write proof-${surface}.json in your current directory.${surface === "issue" ? " Read proof-chat.json from the previous task and include previousSeed as the skill describes." : ""} Reply with RUNTIME_WORKSPACE_SMOKE_OK after verification.`;
    for (const value of Object.values(expected)) assert(!prompt.includes(value));
    const task: MultiremiTask = surface === "chat"
      ? store.sendChatMessage(store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspaceId }).id, { body: prompt }).task
      : store.createTask({ agentId: agent.id, issueId: store.createIssue({ title: "Reuse native local context", runtime_workspace_id: workspaceId }).id, prompt });
    await waitFor(() => ["completed", "failed", "cancelled"].includes(store.getTask(task.id)?.status ?? ""), timeoutMs + 10_000, () => daemonError);
    const completed: MultiremiTask = store.getTask(task.id)!;
    assert.equal(completed.status, "completed", completed.error ?? completed.failureReason ?? "Task did not complete");
    assert.equal(realpathSync(completed.workDir!), realpathSync(cwd));
    assert.match(completed.result ?? "", /RUNTIME_WORKSPACE_SMOKE_OK/);
    const proof = JSON.parse(readFileSync(join(cwd, `proof-${surface}.json`), "utf8"));
    for (const [key, value] of Object.entries(expected)) assert.equal(proof[key], value, `${surface}: ${key}`);
    assert.equal(realpathSync(proof.cwd), realpathSync(cwd));
    if (surface === "issue") assert.equal(proof.previousSeed, expected.seed);
    const messages = store.listTaskMessages(task.id);
    assert(messages.some(message => message.type === "assistant" || message.type === "text"), "Missing assistant transcript");
    assert(completed.usage.length > 0, "Missing provider usage");
    for (const [path, original] of originals) assert.equal(readFileSync(join(workbench, path), "utf8"), original, path);
    results.push({ surface, taskId: task.id, status: completed.status, contextFieldsVerified: Object.keys(expected), usageCount: completed.usage.length });
    daemon.stop();
    await daemonRun;
    daemon = null;
    daemonRun = null;
  }
  assert(!existsSync(join(cwd, ".git")), "Unexpected Git initialization");
  assert(!existsSync(join(cwd, ".multiremi")), "Unexpected task metadata in user directory");
  assert(!existsSync(join(cwd, "wiki")), "Unexpected Wiki directory");
  assert(!existsSync(join(root, "repo-cache")), "Unexpected repository cache");
  store.runtimeWorkspaces.archive(workspaceId!);
  assert(existsSync(join(cwd, "proof-chat.json")) && existsSync(join(cwd, "proof-issue.json")), "Archive removed user files");
} catch (error) {
  failure = error;
} finally {
  daemon?.stop();
  await daemonRun?.catch(() => {});
  server.stop(true);
  db.close();
  // This root was created exclusively for the smoke, including read/write fixtures.
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(JSON.stringify({ ok: failure === null, provider, platform: process.platform, arch: process.arch, results, error: failure instanceof Error ? failure.message : failure }, null, 2));
process.exit(failure === null ? 0 : 1);

async function waitFor(condition: () => boolean, timeout: number, getError: () => unknown): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    const error = getError();
    if (error) throw error;
    assert(Date.now() < deadline, `Timed out after ${timeout}ms`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
