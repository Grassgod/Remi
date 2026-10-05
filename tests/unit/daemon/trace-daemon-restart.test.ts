import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { TraceFileStore } from "@multiremi/worker/trace-file-store.js";
import { releaseDaemonTrace, type DaemonTraceTransport } from "@multiremi/worker/trace-transport.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

it("a fresh daemon process reads the previous process's trace and runtime ACL", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-daemon-process-restart-"));
  const code = String.raw`
    import { MultiremiDaemon } from "./packages/server/src/worker/daemon.ts";
    import { releaseDaemonTrace } from "./packages/server/src/worker/trace-transport.ts";
    import { disabledSshMeshRuntime } from "./tests/helpers/ssh-mesh-isolation.ts";
    const daemon = new MultiremiDaemon({ serverUrl: "http://127.0.0.1:1", runtimeId: "rt_process",
      daemonId: "daemon_process", workspacesRoot: process.env.MULTIREMI_TEST_TRACE_ROOT,
      sshMeshManager: disabledSshMeshRuntime(), gcEnabled: false });
    const trace = daemon.ensureTrace();
    if (process.env.MULTIREMI_TEST_TRACE_MODE === "write") {
      trace.store.registerTask("tsk_process", { sessionId: "ises_process", agentId: "agt_process", provider: "codex",
        runtimeId: "rt_process", startedAt: "2026-10-05T00:00:00Z" });
      trace.append("tsk_process", "rt_process", [{ type: "tool_use", tool: "Bash", toolCallId: "call_process", input: { command: "pwd" } }]);
      trace.close("tsk_process", "completed");
    }
    console.log(JSON.stringify({ head: trace.store.head("tsk_process"), owner: trace.ownership().get("tsk_process"),
      events: trace.store.read("tsk_process").events }));
    daemon.stop(); await releaseDaemonTrace(daemon.protocolClient);
  `;
  const run = (mode: string) => {
    const result = spawnSync(process.execPath, ["-e", code], { cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, MULTIREMI_TEST_TRACE_ROOT: root, MULTIREMI_TEST_TRACE_MODE: mode }, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout.trim());
  };
  try {
    const written = run("write");
    expect(run("read")).toEqual(written);
    expect(written).toMatchObject({ head: { head: 1, closed: true }, owner: "rt_process",
      events: [{ tool: "Bash", tool_call_id: "call_process", input: { command: "pwd" } }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("production daemon construction recovers normalized trace rows after process replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-daemon-restart-"));
  const make = () => new MultiremiDaemon({ serverUrl: "http://127.0.0.1:1", runtimeId: "rt_restart",
    daemonId: "daemon_restart", workspacesRoot: root, sshMeshManager: disabledSshMeshRuntime(), gcEnabled: false });
  type Internal = { ensureTrace(): DaemonTraceTransport; protocolClient: DaemonProtocolClient };
  const first = make();
  const trace = (first as unknown as Internal).ensureTrace();
  expect(trace.store).toBeInstanceOf(TraceFileStore);
  (trace.store as TraceFileStore).registerTask("tsk_restart", { sessionId: "ises_restart", agentId: "agt_restart",
    provider: "codex", runtimeId: "rt_restart", startedAt: "2026-10-05T00:00:00Z" });
  trace.append("tsk_restart", "rt_restart", [{ type: "tool_use", tool: "Read", input: { path: "README.md" }, toolCallId: "tool_1" },
    { type: "text", content: "Recovered answer", meta: { phase: "final" } }]);
  trace.close("tsk_restart", "completed");
  first.stop();
  await releaseDaemonTrace((first as unknown as Internal).protocolClient);
  const second = make();
  const recovered = (second as unknown as Internal).ensureTrace();
  try {
    expect(recovered.ownership().get("tsk_restart")).toBe("rt_restart");
    expect(second.traceStore().head("tsk_restart")).toEqual({ head: 2, closed: true });
    expect(second.traceStore().read("tsk_restart", 0, 1).events[0]).toMatchObject({ tool: "Read", input: { path: "README.md" }, tool_call_id: "tool_1" });
    expect(recovered.completion("tsk_restart")).toMatchObject({ final_reply_md: "Recovered answer", trace: { tool_call_count: 1 } });
  } finally {
    second.stop(); await releaseDaemonTrace((second as unknown as Internal).protocolClient);
    rmSync(root, { recursive: true, force: true });
  }
});
