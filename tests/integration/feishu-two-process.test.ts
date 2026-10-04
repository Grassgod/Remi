import { describe, expect, it } from "bun:test";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { FEISHU_CONCIERGE_PROTOCOL_VERSION } from "@multiremi/contracts/types.js";
import { normalizeDaemonRuntimeInput } from "@multiremi/worker/client.js";
import { pollUntil, TwoProcessResources } from "../helpers/two-process.js";

const configured = Boolean(process.env.MULTIREMI_TEST_POSTGRES_URL);
const BunSocket = WebSocket as unknown as { new(url: string, options?: Bun.WebSocketOptions): WebSocket };

describe.skipIf(!configured)("Feishu split API PostgreSQL delivery", () => {
  it("drains a deferred completed reply over the runtime socket with both process schedulers disabled", async () => {
    const resources = new TwoProcessResources();
    let socket: WebSocket | undefined;
    try {
      const database = await resources.freshDatabase();
      const pair = await resources.spawnPair(database.url);
      const seed = await pair[0].call<{ runtimeId: string; revision: number }>("feishu-seed");
      const taskId = await pair[1].call<string>("feishu-completed-inbound", seed);
      const before = await pair[1].call<any>("feishu-delivery-state", { taskId });
      expect(before.jobs).toBe("0");
      expect(before.deliveries).toEqual([]);
      expect(before.operations.some((row: any) => row.status === "pending")).toBe(true);

      const frames: any[] = [];
      socket = new BunSocket(`${pair[1].url.replace("http:", "ws:")}/api/daemon/ws?protocol=2`,
        { headers: { Authorization: `Bearer ${resources.authToken}` } });
      socket.addEventListener("error", () => {});
      socket.addEventListener("message", event => {
        const frame = JSON.parse(String(event.data));
        frames.push(frame);
        if (typeof frame.seq === "number") socket!.send(JSON.stringify({ v: 2, t: "ack", ack: frame.seq, p: {} }));
      });
      expect(await pollUntil(() => socket!.readyState === WebSocket.OPEN)).toBe(true);
      socket.send(JSON.stringify({ v: 2, t: "hello", p: {
        protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION, daemon_id: `daemon_${seed.runtimeId}`,
        runtimes: [{ runtime_id: seed.runtimeId, provider: "codex", max_concurrency: 1, active_task_ids: [],
          capabilities: { feishu_concierge_protocol: FEISHU_CONCIERGE_PROTOCOL_VERSION } }],
      } }));
      const delivered = new Set<string>();
      for (const kinds of [["cot", "receipt"], ["result_card"], ["receipt"]]) {
        expect(await pollUntil(() => frames.filter(frame => frame.t === "feishu.outbound" && !delivered.has(frame.p.id)).length >= kinds.length)).toBe(true);
        const offered = frames.filter(frame => frame.t === "feishu.outbound" && !delivered.has(frame.p.id));
        expect(offered.map(frame => frame.p.kind).sort()).toEqual([...kinds].sort());
        for (const frame of offered) {
          const delivery = normalizeDaemonRuntimeInput(seed.runtimeId, { pending_feishu_outbound: frame.p }).pending_feishu_outbound!;
          if (delivery.kind === "result_card") expect(JSON.parse(delivery.body).text).toBe("Reply completed on runtime API");
          expect(await pollUntil(async () => pair[1].call<boolean>("feishu-report", { runtimeId: seed.runtimeId,
            id: delivery.id, claimToken: delivery.claimToken }))).toBe(true);
          delivered.add(delivery.id);
        }
      }
      const after = await pair[0].call<any>("feishu-delivery-state", { taskId });
      expect(after.jobs).toBe("0");
      expect(after.operations.every((row: any) => row.status === "done")).toBe(true);
      expect(after.deliveries).toEqual([{ kind: "cot", status: "sent" }, { kind: "receipt", status: "sent" },
        { kind: "receipt", status: "sent" }, { kind: "result_card", status: "sent" }]);
      expect(delivered.size).toBe(4);
    } finally {
      socket?.close();
      await resources.cleanup();
    }
  }, 30_000);
});
