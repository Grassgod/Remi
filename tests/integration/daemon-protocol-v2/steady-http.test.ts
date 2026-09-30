import { afterEach, expect, it, spyOn } from "bun:test";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

const conditionalHttp = [{ method: "GET", path: /^\/api\/daemon\/tasks\/[^/]+\/status$/ }];

it("Q418-http15: real v2 model and GC timers produce no idle HTTP in an accelerated 15-minute window", async () => {
  const intervalMs = 1_000; // One accelerated cycle represents the production 15-minute interval.
  let modelDiscoveries = 0;
  const h = await DaemonProtocolHarness.create({
    daemonOptions: { gcEnabled: true, gcIntervalMs: intervalMs,
      inProcessRuntimeModelDiscoveryEnabled: true, runtimeModelRefreshIntervalMs: intervalMs },
    beforeStart: harness => {
      (harness.daemon as unknown as { runtimeProfileSnapshotReceived: boolean }).runtimeProfileSnapshotReceived = true;
    },
    providerFactory: () => ({
      async *sendStream() { yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "fixture" }] } as any; },
      getLastResponse: () => ({ text: "fixture", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
      discoverModelCapabilities: async () => {
        modelDiscoveries++;
        return [{ id: "fixture-model", label: "Fixture Model", default: true }];
      },
      close: async () => {},
    }),
  });
  fixtures.push(h);
  const requests: Array<{ method: string; path: string }> = [];
  const originalFetch = globalThis.fetch.bind(globalThis);
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === h.url) {
      requests.push({ method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), path: url.pathname });
    }
    return originalFetch(input, init);
  }) as typeof fetch);
  const gc = spyOn(h.daemon as any, "runGcOnce");
  try {
    await h.startDaemon();
    await waitFor(() => modelDiscoveries > 0, "initial model discovery", 5_000);
    await h.settleHeartbeat();
    requests.length = 0;
    const gcBefore = gc.mock.calls.length;
    const discoveriesBefore = modelDiscoveries;
    const desiredBefore = h.ledger.filter(entry => entry.type === "plugin.desired").length;
    (h.daemon as unknown as { nextPluginDesiredAt: number }).nextPluginDesiredAt = Date.now() + intervalMs;
    h.daemon.wakeClaim();
    await Bun.sleep(intervalMs + 100);
    await waitFor(() => h.ledger.filter(entry => entry.type === "plugin.desired").length > desiredBefore,
      "ten-minute plugin desired RPC", 5_000);
    await h.layer.drain();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    const modelsPath = `/api/daemon/runtimes/${runtimeId}/models`;
    const models = requests.filter(request => request.method === "PUT" && request.path === modelsPath);
    expect(gc.mock.calls.length).toBeGreaterThan(gcBefore);
    expect(modelDiscoveries).toBeGreaterThan(discoveriesBefore);
    expect(h.ledger.filter(entry => entry.type === "plugin.desired").length).toBeGreaterThan(desiredBefore);
    expect(models.length).toBeLessThanOrEqual(1);
    expect(requests.filter(request => !conditionalHttp.some(route => route.method === request.method && route.path.test(request.path))),
      "only conditional Feishu task status GET may use HTTP after v2 connection").toEqual([]);
    expect(requests, "idle model reports and GC must use v2 frames, not HTTP").toEqual([]);
    for (const path of ["/api/daemon/heartbeat", `/api/daemon/runtimes/${runtimeId}/tasks/claim`,
      `/api/daemon/runtimes/${runtimeId}/agent-plugins/desired`, "/api/daemon/tasks/any/status"]) {
      expect(requests.some(request => request.path === path)).toBe(false);
    }
    console.info(`[Q418-http15] accelerated=${intervalMs}ms model_discoveries=${modelDiscoveries - discoveriesBefore} gc_rpc_cycles=${gc.mock.calls.length - gcBefore} desired_rpcs=${h.ledger.filter(entry => entry.type === "plugin.desired").length - desiredBefore} requests=${JSON.stringify(requests)}`);
  } finally {
    gc.mockRestore();
    fetchSpy.mockRestore();
  }
});
