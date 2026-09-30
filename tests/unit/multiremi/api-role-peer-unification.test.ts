/**
 * MUL-462 — one effective role for the guard, the realtime fanout and health.
 *
 * MUL-461 resolved a process's role in `server.ts` and enforced it with a guard.
 * MUL-462 fans store events out by role and reports `peer_healthy` next to it. If
 * those two read the role from different places, a process can refuse traffic for
 * one side while fanning out for the other — and an injected `apiRole` (the way
 * tests and `startMultiremiServer` pin a role) is exactly where that diverges if
 * anything re-reads env.
 *
 * These cases pin the whole chain for one process:
 *   guard (421 for the other side) — fanout (which registry a store event
 *   reaches) — health (`/readyz` and `/health/realtime`).
 *
 * The mutation that motivates them: making the fanout resolve its own role from
 * env. With an injected `apiRole=runtime` and no env var it resolves `all`, so the
 * guard refuses browser paths while the fanout still delivers to the browser
 * registry — a and b below catch it.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import {
  createRealtimeFanout,
  type LocalRealtimeRole,
  type RealtimeFanoutOptions,
} from "../../../packages/server/src/api/realtime-fanout.js";
import { resetRequestMetricsForTest } from "@multiremi/observability/request-metrics.js";
import * as apiRoleConfig from "@multiremi/config/api-role.js";
import { resolveStartupApiRole } from "@multiremi/config/startup-env.js";
import { createEmptyLiveHub } from "@multiremi/api/hub/live-hub.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";

const legacyHub = () => createEmptyLiveHub(createLocalHubTransport());

it("resolves the role once during a real server start and retains the unconfigured default", async () => {
  delete process.env.MULTIREMI_API_ROLE;
  delete process.env.MULTIREMI_PEER_URL;
  expect(resolveStartupApiRole({})).toEqual({ role: "all", configured: false });
  expect(resolveStartupApiRole({ MULTIREMI_API_ROLE: "all" })).toEqual({ role: "all", configured: true });
  const resolver = spyOn(apiRoleConfig, "resolveApiRole");
  const { store, db } = memoryStore();
  const server = startMultiremiServer({ store, liveHub: legacyHub(), port: 0, hostname: "127.0.0.1", backgroundJobs: false, authToken: null });
  try {
    expect(resolver).toHaveBeenCalledTimes(1);
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/readyz`)).text()).toBe('{"ok":true}');
    expect(await (await fetch(`${base}/health/realtime`)).text()).toBe('{"connections":0,"enabled":true,"transport":"websocket"}');
    expect(resolver).toHaveBeenCalledTimes(1);
  } finally { server.stop(true); db.close(); resolver.mockRestore(); }
});

const ROLE_ENV = "MULTIREMI_API_ROLE";
const savedRole = process.env[ROLE_ENV];

afterEach(() => {
  if (savedRole === undefined) delete process.env[ROLE_ENV];
  else process.env[ROLE_ENV] = savedRole;
  resetRequestMetricsForTest();
});

function memoryStore(): { store: MultiremiStore; db: Database } {
  const db = new Database(":memory:");
  return { store: new MultiremiStore(db), db };
}

/**
 * Observe the role the server actually wired into the fanout.
 *
 * Reading `createRealtimeFanout({ role })` in isolation proves nothing about the
 * server: the bug this guards against is the server building the fanout from a
 * different role than the guard uses. So the servers below are constructed with a
 * wrapper that records the options and delegates to the real factory.
 */
function roleSpy() {
  const roles: LocalRealtimeRole[] = [];
  return {
    roles,
    createRealtimeFanout: (options: RealtimeFanoutOptions) => {
      roles.push(options.role);
      return createRealtimeFanout(options);
    },
  };
}

/** Records browser frames; daemon delivery is observed through the fanout hook. */
function registries() {
  const browserFrames: string[] = [];
  const browser = {
    data: {
      kind: "browser" as const,
      connectedAt: new Date().toISOString(),
      workspaceId: "local",
      authenticated: true,
      userId: "local",
      accessToken: null,
    },
    sendText: (frame: string) => browserFrames.push(frame),
    close: () => {},
  };
  return {
    browserFrames,
    registries: {
      browser: new Map([["local", new Set([browser])]]) as any,
      browserUser: new Map([["local", new Set([browser])]]) as any,
      browserScope: new Map() as any,
    },
  };
}

/**
 * Run one store event through a fanout built with `role` and report which side
 * received it. This is the fanout half of "the three places agree".
 */
function fanoutDelivery(role: LocalRealtimeRole) {
  const { store, db } = memoryStore();
  const agent = store.createAgent({ name: `role-${role}`, provider: "codex" });
  const runtime = store.registerRuntime({ id: "rt_role", name: "Role runtime", provider: "codex" });
  const mounts = registries();
  const daemonEvents: Array<{ type: string }> = [];
  const fanout = createRealtimeFanout({ role, store, registries: mounts.registries, onDaemonTask: event => { daemonEvents.push(event); } });
  try {
    store.createTask({ agentId: agent.id, prompt: "role delivery", runtimeId: runtime.id });
    return {
      browser: mounts.browserFrames.length,
      daemon: daemonEvents.length,
      browserTypes: mounts.browserFrames.map((frame) => (JSON.parse(frame) as { type: string }).type),
      daemonTypes: daemonEvents.map(event => event.type),
    };
  } finally {
    fanout.close();
    db.close();
  }
}

describe("MUL-462/461 — injected apiRole drives guard, fanout and health together", () => {
  it("pins all three to runtime when apiRole is injected and env is unset", async () => {
    delete process.env[ROLE_ENV];
    const { store, db } = memoryStore();
    const spy = roleSpy();
    const server = startMultiremiServer({
      liveHub: legacyHub(),
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: null,
      apiRole: "runtime",
      createRealtimeFanout: spy.createRealtimeFanout,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      // Guard: a browser path is misdirected, a daemon path is served.
      const browserPath = await fetch(`${base}/api/issues`);
      expect(browserPath.status).toBe(421);
      expect(await browserPath.json()).toEqual({ error: "misdirected", role: "runtime" });
      expect((await fetch(`${base}/api/daemon/runtimes/rt_role/activity`)).status).not.toBe(421);

      // Health: both payloads carry the same role. `/readyz` is in the health trio;
      // `/health/realtime` is the peer-channel consumer of the same value.
      expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ ok: true, role: "runtime" });
      expect(await (await fetch(`${base}/health/realtime`)).json()).toMatchObject({ role: "runtime" });

      // Fanout: the server built it with the SAME role the guard enforced. This is
      // the assertion the pre-increment state fails — there the fanout re-read env,
      // resolved `all`, and would fan out browser frames this process refuses.
      expect(spy.roles).toEqual(["runtime"]);
      // And that role really means daemon-only delivery.
      expect(fanoutDelivery("runtime")).toMatchObject({ browser: 0, daemon: 0 });
    } finally {
      server.stop(true);
      db.close();
    }
  });

  it("lets an injected apiRole win over a conflicting env var, and reports the winner", async () => {
    // MUL-461's precedence: an injected role is the effective role.
    process.env[ROLE_ENV] = "ui";
    const { store, db } = memoryStore();
    const spy = roleSpy();
    const server = startMultiremiServer({
      liveHub: legacyHub(),
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: null,
      apiRole: "runtime",
      createRealtimeFanout: spy.createRealtimeFanout,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const browserPath = await fetch(`${base}/api/issues`);
      expect(browserPath.status).toBe(421);
      // The injected role, not the env one.
      expect(await browserPath.json()).toEqual({ error: "misdirected", role: "runtime" });
      expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ ok: true, role: "runtime" });
      expect(await (await fetch(`${base}/health/realtime`)).json()).toMatchObject({ role: "runtime" });
      // The injected role wins over the conflicting env var in the fanout too.
      expect(spy.roles).toEqual(["runtime"]);
      expect(fanoutDelivery("runtime")).toMatchObject({ browser: 0, daemon: 0 });
    } finally {
      server.stop(true);
      db.close();
    }
  });

  it("behaves exactly like main when neither env nor apiRole is set", async () => {
    delete process.env[ROLE_ENV];
    const { store, db } = memoryStore();
    const app = createMultiremiApp({ store, liveHub: legacyHub(), authToken: null });
    const spy = roleSpy();
    const server = startMultiremiServer({
      liveHub: legacyHub(),
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: null,
      createRealtimeFanout: spy.createRealtimeFanout,
    });
    try {
      // `configured=false`: no role field anywhere, bodies byte-identical to main.
      expect(await (await app.request("/readyz")).json()).toEqual({ ok: true });
      const base = `http://127.0.0.1:${server.port}`;
      expect(await (await fetch(`${base}/readyz`)).json()).toEqual({ ok: true });
      expect(await (await fetch(`${base}/health/realtime`)).json()).toEqual({
        connections: 0,
        enabled: true,
        transport: "websocket",
      });
      // No peer and no role: nothing is misdirected.
      expect((await fetch(`${base}/api/issues`)).status).not.toBe(421);
      // `configured=false` but the effective role is still `all`, and that is what
      // the fanout got: both registries, exactly main's behaviour.
      expect(spy.roles).toEqual(["all"]);
      expect(fanoutDelivery("all")).toMatchObject({ browser: 1, daemon: 0 });
    } finally {
      server.stop(true);
      db.close();
    }
  });
});
