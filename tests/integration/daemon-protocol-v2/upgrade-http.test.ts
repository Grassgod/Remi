import { describe, expect, it } from "bun:test";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { DaemonProtocolClient, type DaemonProtocolLane } from "@multiremi/worker/daemon-protocol-client.js";
import { waitFor } from "./harness.js";

describe("native Bun websocket HTTP upgrade rejection", () => {
  for (const [status, code, state, close] of [
    [421, "misdirected_request", "disconnected", null],
    [502, "server_error", "disconnected", null],
    [503, "server_error", "disconnected", null],
    [403, "daemon_token_required", "terminal", 4403],
    [401, "unauthorized", "terminal", 4401],
    [410, "daemon_retired", "terminal", 4410],
    [426, "daemon_protocol_upgrade_required", "upgrade_wait", null],
  ] as const) {
    it(`reads the real HTTP ${status} response hidden by Bun's error event`, async () => {
      let requests = 0;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
        requests++;
        return Response.json({ code, min_version: 3 }, { status });
      } });
      const clock = new ManualDaemonProtocolClock();
      const terminal: number[] = [];
      const lane: DaemonProtocolLane = {
        runtime: () => ({ runtime_id: "rt_http", provider: "claude", max_concurrency: 1, active_task_ids: [] }),
        heartbeat: () => ({ active_task_count: 0 }), onHeartbeatAck: async () => {},
        probeUpgrade: async () => {}, onTerminal: async code => { terminal.push(code); },
      };
      const client = new DaemonProtocolClient({ serverUrl: `http://127.0.0.1:${server.port}`, daemonId: "dmn_http", cliVersion: "0.2.83", clock, random: () => 0.5 });
      client.addLane(lane);
      try {
        client.startLane(lane);
        await waitFor(() => client.connectionState() === state, `HTTP ${status} policy`);
        await client.drain();
        expect(terminal).toEqual(close === null ? [] : [close]);
        expect(requests).toBe(2);
        if (status === 426) expect(client.health()).toMatchObject({ state: "rejected", server_min: 3 });
        if (state === "disconnected") {
          clock.advance(1000);
          await waitFor(() => requests === 4 && client.connectionState() === "disconnected", "HTTP retry");
        } else {
          clock.advance(30_000);
          expect(requests).toBe(2);
        }
      } finally {
        client.close();
        await client.drain();
        server.stop(true);
      }
    });
  }
});
