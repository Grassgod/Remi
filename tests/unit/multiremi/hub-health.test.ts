/**
 * What the API reports about its hub (MUL-403 §1 item 9).
 *
 * `/health` carries the fan-out numbers (`streams`, ring occupancy, lagging
 * subscribers, flush p95); `/readyz` carries the routing facts a deploy reads
 * (`hub.role`, `hub.transport`, `hub.peer_link`, `hub.fill_count`,
 * `hub_hole_wait_ms`).
 *
 * The compatibility half matters as much as the new fields: both bodies are
 * consumed by probes that only look at `ok`, and `scripts/api-routes.golden.json`
 * is byte-compared in CI. So an app built without a hub keeps the exact `{ok: true}`
 * body it had, and the new fields are additive where a hub exists.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createHub } from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { hubHealthPayload, hubReadyzPayload, isObservableHub } from "@multiremi/api/hub/hub-health.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function appWith(hub: unknown) {
  return createMultiremiApp({ store: createStore(), hub: hub as never, realtimeState: { enabled: true, connections: 0 } });
}

describe("hub health payloads", () => {
  it("reports the hub's own counters under /health", async () => {
    const hub = createHub({ transport: createLocalHubTransport(), role: "ui" });
    hub.onEntry("ises_1", { session_id: "ises_1", seq: 1, kind: "message", visibility: "shown", revision: 1 });

    const body = await (await appWith(hub).request("/health")).json() as Record<string, any>;
    expect(body.ok).toBe(true);
    const snapshot = body.hub;
    expect(snapshot.role).toBe("ui");
    expect(snapshot.transport).toBe("local");
    expect(snapshot.streams).toBe(1);
    expect(snapshot.frames).toBe(1);
    expect(snapshot.ring_bytes).toBeGreaterThan(0);
    expect(snapshot.lagging_subscribers).toBe(0);
    expect(typeof snapshot.flush_p95_ms).toBe("number");
  });

  it("reports the routing facts under /readyz", async () => {
    const hub = createHub({ transport: createLocalHubTransport(), role: "runtime" });
    const body = await (await appWith(hub).request("/readyz")).json() as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.hub).toEqual({
      role: "runtime",
      transport: "local",
      // No `MULTIREMI_PEER_URL` in the hermetic test environment: single process.
      peer_link: false,
      fill_count: 0,
      hub_hole_wait_ms: 0,
    });
  });

  it("reads the peer link from the environment rather than probing it", () => {
    const hub = createHub({ transport: createLocalHubTransport(), role: "all" });
    expect(hubReadyzPayload(hub, {} as NodeJS.ProcessEnv).hub?.peer_link).toBe(false);
    expect(hubReadyzPayload(hub, { MULTIREMI_PEER_URL: "ws://api-runtime:6120" } as NodeJS.ProcessEnv).hub?.peer_link).toBe(true);
    expect(hubReadyzPayload(hub, { MULTIREMI_PEER_URL: "   " } as NodeJS.ProcessEnv).hub?.peer_link).toBe(false);
  });

  it("adds nothing for an app built without a hub, keeping the old body byte-identical", async () => {
    const apiRole = process.env.MULTIREMI_API_ROLE;
    delete process.env.MULTIREMI_API_ROLE;
    try {
      const app = createMultiremiApp({ store: createStore(), hub: null, realtimeState: { enabled: true, connections: 0 } });
      expect(await (await app.request("/health")).json()).toEqual({ ok: true });
      expect(await (await app.request("/readyz")).json()).toEqual({ ok: true });
    } finally {
      if (apiRole === undefined) delete process.env.MULTIREMI_API_ROLE;
      else process.env.MULTIREMI_API_ROLE = apiRole;
    }
  });

  it("does not attach the human-request feed when background jobs are off", () => {
    // A read-only blue/green candidate passes `backgroundJobs: false`; the feed must
    // honour that rather than the host environment, so the two cannot disagree about
    // who consumes E5's events. The observable is the listener count on the store.
    const store = createStore();
    const hub = createHub({ transport: createLocalHubTransport() });
    const listeners = (): number => (store as unknown as {
      ctx: { humanRequestListeners: Set<unknown> };
    }).ctx.humanRequestListeners.size;

    createMultiremiApp({ store, hub: hub as never, backgroundJobs: false, realtimeState: { enabled: true, connections: 0 } });
    expect(listeners()).toBe(0);

    createMultiremiApp({ store, hub: hub as never, backgroundJobs: true, realtimeState: { enabled: true, connections: 0 } });
    expect(listeners()).toBe(1);
  });

  it("recognizes only a hub that can describe itself", () => {
    const hub = createHub({ transport: createLocalHubTransport() });
    expect(isObservableHub(hub)).toBe(true);
    expect(isObservableHub(null)).toBe(false);
    expect(isObservableHub(undefined)).toBe(false);
    // A structural hub without `snapshot` is not observable, which is what keeps
    // `EmptyLiveHub` and injected test doubles from producing a fake `hub.*` block.
    expect(isObservableHub({ transport: createLocalHubTransport() } as never)).toBe(false);
    expect(hubHealthPayload({ transport: createLocalHubTransport() } as never)).toEqual({});
  });
});
