import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { startMultiremiServer } from "../../fixtures/daemon-protocol.js";
import { openRuntimeDownlinks } from "../../fixtures/runtime-downlinks.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DaemonTaskOffers } from "@multiremi/api/daemon-protocol/task-offers.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error("Downlink did not arrive"); await Bun.sleep(1); }
}

type Family = {
  kind: string;
  create(store: MultiremiStore): { id: string };
  read(store: MultiremiStore, id: string): { status: string; error: string | null } | null;
  report(store: MultiremiStore, id: string, status: "completed" | "failed"): unknown;
};
const rt = "rt_downlinks";
const families: Family[] = [
  { kind: "update", create: store => store.createRuntimeUpdateRequest(rt, { targetVersion: "9.9.9" }),
    read: (store, id) => store.getRuntimeUpdateRequest(rt, id),
    report: (store, id, status) => store.reportRuntimeUpdateResult(rt, id, { status, error: "duplicate must not win" }) },
  { kind: "model_list", create: store => store.createRuntimeModelListRequest(rt),
    read: (store, id) => store.getRuntimeModelListRequest(rt, id),
    report: (store, id, status) => store.reportRuntimeModelListResult(rt, id, { status, models: [], error: "duplicate must not win" }) },
  { kind: "command", create: store => store.createRuntimeCommandRequest(rt, { command: "printf stable", args: [] }),
    read: (store, id) => store.getRuntimeCommandRequest(rt, id),
    report: (store, id, status) => store.reportRuntimeCommandResult(rt, id, { status, exitCode: 0, stdout: "stable", error: "duplicate must not win" }) },
  { kind: "local_skills", create: store => store.createRuntimeLocalSkillListRequest(rt, {}),
    read: (store, id) => store.getRuntimeLocalSkillListRequest(rt, id),
    report: (store, id, status) => store.reportRuntimeLocalSkillListResult(rt, id, { status, supported: true, skills: [], error: "duplicate must not win" }) },
  { kind: "directory_scan", create: store => store.createRuntimeDirectoryScanRequest(rt, { root: "/tmp" }),
    read: (store, id) => store.getRuntimeDirectoryScanRequest(rt, id),
    report: (store, id, status) => store.reportRuntimeDirectoryScanResult(rt, id, { status, supported: true, candidates: [], error: "duplicate must not win" }) },
  { kind: "local_skill_import", create: store => store.createRuntimeLocalSkillImportRequest(rt, { skillKey: "test-skill" }),
    read: (store, id) => store.getRuntimeLocalSkillImportRequest(rt, id),
    report: (store, id, status) => store.reportRuntimeLocalSkillImportResult(rt, id, { status,
      skill: { name: "Test skill", content: "# Test skill", files: [{ path: "notes.md", content: "Test notes" }] },
      error: "duplicate must not win" }) },
  { kind: "bot_menu", create: store => store.createBotMenuPublishRequest(rt, { workspaceId: "local", config: { default: [] }, dryRun: true }),
    read: (store, id) => store.getBotMenuPublishRequest(rt, id),
    report: (store, id, status) => store.reportBotMenuPublishResult(rt, id, { status,
      result: { dryRun: true, defaultPublished: false, userMenuCount: 0 }, error: "duplicate must not win" }) },
];

describe("A-4 native pending delivery", () => {
  it("retains a ready reconciliation cancellation until a full window is acknowledged", async () => {
    const store = createLocalStore();
    store.registerRuntime({ id: rt, name: rt, provider: "claude" });
    const agent = store.createAgent({ name: "Ready cancel", provider: "claude", runtimeId: rt });
    const task = store.createTask({ agentId: agent.id, prompt: "Already done" });
    store.claimTask(rt); store.startTask(task.id); store.completeTask(task.id, { output: "done" });
    const connection = await openRuntimeDownlinks(store, rt);
    new DaemonTaskOffers({ store, layer: connection.layer, prepare: async () => null,
      onRuntimeReady: (runtimeId, ids) => connection.downlinks.runtimeReady(runtimeId, ids) });
    try {
      await connection.ack();
      for (let i = 0; i < 64; i++) expect(connection.session.sendEvent({ t: "plugin.desired_revision", p: { revision: String(i) } }).ok).toBe(true);
      const windowHead = connection.session.lastSentSeq;
      await connection.session.handleMessage(JSON.stringify({ v: 2, t: "runtime.ready", rt,
        p: { active_task_ids: [task.id] } }));
      await connection.layer.drain();
      expect(connection.frames.filter(frame => frame.t === "task.cancelled")).toEqual([]);
      await connection.ack(windowHead);
      expect(connection.frames.filter(frame => frame.t === "task.cancelled").map(frame => frame.p))
        .toEqual([{ task_id: task.id, status: "completed" }]);
      await connection.ack(); await connection.kick();
      expect(connection.frames.filter(frame => frame.t === "task.cancelled")).toHaveLength(1);
    } finally { await connection.close(); }
  });

  for (const family of families) it(`${family.kind}: create pushes, pre-ACK disconnect replays, result is idempotent`, async () => {
    const store = createLocalStore();
    store.registerRuntime({ id: rt, name: rt, provider: "claude", workspaceId: "local", daemonId: "dmn_downlinks",
      ownerId: "local", metadata: { feishu_bot_menu: true, agent_plugin_protocol: 1 } });
    let layer!: DaemonProtocolLayer;
    const server = startMultiremiServer({ port: 0, hostname: "127.0.0.1", store, authToken: "test-downlink-authority",
      onDaemonProtocol: value => { layer = value; } });
    const sockets = new Set<WebSocket>();
    const connect = async () => {
      const frames: Record<string, any>[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
        { headers: { Authorization: "Bearer test-downlink-authority" } } as never);
      sockets.add(socket);
      socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
      await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Socket failed")), { once: true }); });
      socket.send(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: "dmn_downlinks",
        cli_version: DAEMON_MIN_CLI_VERSION, caps: [], runtimes: [{ runtime_id: rt, provider: "claude",
          max_concurrency: 1, active_task_ids: [],
          capabilities: { supports_bot_menu: true, agent_plugin_protocol: 1 } }] } }));
      await waitFor(() => frames.some(frame => frame.t === "welcome"));
      return { socket, frames };
    };
    const close = async (socket: WebSocket) => {
      if (socket.readyState !== WebSocket.CLOSED) await new Promise<void>(resolve => {
        socket.addEventListener("close", () => resolve(), { once: true }); socket.close();
      });
      sockets.delete(socket);
      await waitFor(() => layer.registry.sessionForRuntime(rt) === null);
      await layer.drain();
    };
    try {
      const first = await connect();
      const request = family.create(store);
      const pushed = () => first.frames.filter(frame => frame.t === `runtime.${family.kind}` && frame.p.id === request.id);
      await waitFor(() => pushed().length === 1);
      expect(family.read(store, request.id)?.status).toBe("pending");
      await close(first.socket);
      expect(family.read(store, request.id)?.status).toBe("pending");
      const second = await connect();
      await waitFor(() => second.frames.some(frame => frame.t === `runtime.${family.kind}` && frame.p.id === request.id));
      const replay = second.frames.find(frame => frame.t === `runtime.${family.kind}` && frame.p.id === request.id)!;
      expect(replay.p).toEqual(pushed()[0]!.p);
      second.socket.send(JSON.stringify({ v: 2, t: "ack", ack: replay.seq, p: {} }));
      await waitFor(() => family.read(store, request.id)?.status === "running");
      family.report(store, request.id, "completed");
      const settled = family.read(store, request.id);
      expect(settled?.status).toBe("completed");
      family.report(store, request.id, "failed");
      expect(family.read(store, request.id)).toEqual(settled);
      await close(second.socket);
    } finally {
      for (const socket of sockets) await close(socket);
      layer.closeAll(); await layer.drain(); server.stop(true);
    }
  });

  it("discards a >1 MiB pending command and delivers the next entity", async () => {
    const store = createLocalStore();
    store.registerRuntime({ id: rt, name: rt, provider: "claude", metadata: { feishu_bot_menu: true } });
    const command = store.createRuntimeCommandRequest(rt, { command: "printf stable", args: [] });
    const internal = store as unknown as { db: { run(sql: string, args: unknown[]): unknown } };
    internal.db.run("UPDATE multiremi_runtime_command_requests SET args = ? WHERE id = ?", [JSON.stringify(["x".repeat(1_048_576)]), command.id]);
    const menu = store.createBotMenuPublishRequest(rt, { workspaceId: "local", config: { default: [] }, dryRun: true });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const connection = await openRuntimeDownlinks(store, rt);
    try {
      expect(store.getRuntimeCommandRequest(rt, command.id)?.status).toBe("failed");
      expect(store.getRuntimeCommandRequest(rt, command.id)?.error).toContain("1 MiB");
      expect(connection.frames.some(frame => frame.t === "runtime.command")).toBe(false);
      expect(connection.frames.find(frame => frame.t === "runtime.bot_menu")?.p.id).toBe(menu.id);
      expect(warn.mock.calls.some(args => String(args[0]).includes("daemon_downlink_too_large"))).toBe(true);
      await connection.ack();
      expect(store.getBotMenuPublishRequest(rt, menu.id)?.status).toBe("running");
    } finally { await connection.close(); warn.mockRestore(); }
  });
});
