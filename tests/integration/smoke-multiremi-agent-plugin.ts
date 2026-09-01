#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";

const MARKER = "MULTIREMI_AGENT_PLUGIN_OK_7F3A";
const DAEMON_ID = "daemon-live-agent-plugin-smoke";
const PROVIDER = process.env.MULTIREMI_PLUGIN_SMOKE_PROVIDER === "codex" ? "codex" : "claude";
const root = mkdtempSync(join(tmpdir(), "multiremi-agent-plugin-live-"));
const cwd = join(root, "repo");
mkdirSync(cwd, { recursive: true });

const db = new Database(":memory:");
const store = new MultiremiStore(db);
const server = startMultiremiServer({
  store,
  scheduler: null,
  authToken: "root-live-agent-plugin-smoke",
  hostname: "127.0.0.1",
  port: 0,
});

try {
  const daemonToken = await store.createAccessToken({
    name: "Live Agent Plugin smoke daemon",
    type: "daemon",
    workspaceId: "local",
    daemonId: DAEMON_ID,
  });
  const agent = store.createAgent({
    name: `Live ${PROVIDER} Plugin Proof`,
    provider: PROVIDER,
  });
  const plugin = store.importAgentPlugin({
    provider: PROVIDER,
    name: "runtime-proof",
    version: "1.0.0",
    manifest: {
      name: "runtime-proof",
      version: "1.0.0",
      description: "Deterministic live proof that a Runtime-loaded plugin is available to Claude",
    },
    files: [
      {
        path: "skills/runtime-proof/SKILL.md",
        content: `---\nname: runtime-proof\ndescription: Use when the user asks to run the Runtime Plugin proof.\n---\n\nReply with exactly this token and nothing else: ${MARKER}\n`,
      },
      {
        path: "commands/runtime-proof.md",
        content: `Reply with exactly this token and nothing else: ${MARKER}\n`,
      },
    ],
  });
  store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
  const task = store.createTask({
    agentId: agent.id,
    workspaceId: "local",
    prompt: PROVIDER === "claude"
      ? "Invoke /runtime-proof from the loaded Runtime Plugin and follow its instructions exactly."
      : "Use the runtime-proof skill from the loaded Runtime Plugin and follow its instructions exactly.",
  });

  const cacheRoot = join(root, "plugin-cache");
  const daemon = new MultiremiDaemon({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: daemonToken.token,
    daemonId: DAEMON_ID,
    runtimeName: "live-agent-plugin-smoke",
    provider: PROVIDER,
    workspaceId: "local",
    once: true,
    taskTimeoutMs: 180_000,
    daemonPort: 0,
    workspacesRoot: join(root, "workspaces"),
    repoCacheRoot: join(root, "repo-cache"),
    pluginCacheRoot: cacheRoot,
  });
  await daemon.start();

  const completed = store.getTask(task.id);
  const runtime = store.listRuntimes()[0] ?? null;
  const runtimeState = runtime
    ? store.listAgentPluginRuntimeStates({ runtimeId: runtime.id })[0] ?? null
    : null;
  const cacheSkill = join(
    cacheRoot,
    plugin.activeVersion!.artifactDigest,
    "payload",
    "skills",
    "runtime-proof",
    "SKILL.md",
  );
  const output = String(completed?.result ?? completed?.error ?? "");
  const markerCount = output.split(MARKER).length - 1;
  const result = {
    ok: completed?.status === "completed"
      && markerCount === 1
      && runtimeState?.status === "ready"
      && runtimeState.observedDigest === plugin.activeVersion!.artifactDigest
      && existsSync(cacheSkill)
      && readFileSync(cacheSkill, "utf8").includes(MARKER),
    task: {
      provider: PROVIDER,
      id: task.id,
      status: completed?.status ?? null,
      output,
      markerCount,
      executionFingerprint: completed?.executionFingerprint ?? null,
      pluginSnapshot: completed?.pluginSnapshot ?? [],
    },
    runtime: runtime && {
      id: runtime.id,
      daemonId: runtime.daemonId,
      pluginState: runtimeState && {
        status: runtimeState.status,
        observedDigest: runtimeState.observedDigest,
      },
    },
    artifact: {
      digest: plugin.activeVersion!.artifactDigest,
      cached: existsSync(cacheSkill),
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  server.stop(true);
  db.close();
  rmSync(root, { recursive: true, force: true });
}
