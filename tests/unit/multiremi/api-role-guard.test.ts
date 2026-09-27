/**
 * MUL-461 — `MULTIREMI_API_ROLE` and the role guard.
 *
 * The Issue fixes four things to prove:
 *   ① with the env var unset the process is main (the route snapshot in
 *      `tests/unit/multiremi/api-route-snapshot.test.ts` covers the byte-identical
 *      part; here the guard itself must be absent from the middleware chain);
 *   ② over the FULL golden route inventory: `ui` refuses every `/api/daemon/*`
 *      and nothing else, `runtime` is the mirror image, `all` refuses nothing;
 *   ③ WebSocket upgrades are refused with 421 rather than 426 — an upgrade never
 *      reaches Hono, so it is answered in `startMultiremiServer.fetch`, which is
 *      exactly the branch a middleware-only test would miss;
 *   ④ `role` reaches both metrics events and the health payloads.
 *
 * The matrix drives the same inventory the API snapshot does
 * (`scripts/api-routes.golden.json`, 759 patterns) instead of a hand-picked list,
 * so a route added later under either prefix is covered without editing this file.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import {
  API_ROLE_HEADER,
  isDaemonPath,
  isMisdirectedPath,
  isRuntimeAllowedPath,
  resolveApiRole,
  type ApiRole,
} from "@multiremi/config/api-role.js";
import { startRequestMetricsSummary } from "@multiremi/observability/request-metrics.js";

/**
 * Collect `console.log` lines for the duration of `run`.
 *
 * Local rather than imported: `request-metrics.test.ts` keeps its own copy, and
 * `helpers.ts` is shared by nearly every suite in this directory.
 */
function captureConsoleLog<T>(run: () => Promise<T> | T): Promise<{ lines: string[]; result: T }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  return Promise.resolve()
    .then(run)
    .then((result) => ({ lines, result }))
    .finally(() => {
      console.log = original;
    });
}

const GOLDEN_PATH = join(import.meta.dir, "../../../scripts/api-routes.golden.json");
const GOLDEN = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { routes: string[] };

/**
 * The golden file records route PATTERNS; turn each into a path the app will
 * actually route. `:id` style params become a literal segment, which is enough
 * for the guard: it decides on the path prefix before any handler runs, so a
 * request that would 404 further in still proves whether the role refused it.
 */
function concreteRequest(pattern: string): { method: string; path: string } {
  const [method, route] = pattern.split(" ");
  const path = (route ?? "/")
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "role_probe" : segment))
    .join("/");
  return { method: method ?? "GET", path };
}

function memoryStore(): { store: MultiremiStore; db: Database } {
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  return { store, db };
}

/** Every golden pattern, with its response status, for one role. */
async function sweep(role: ApiRole): Promise<Map<string, number>> {
  const { store, db } = memoryStore();
  const app = createMultiremiApp({ store, apiRole: role, authToken: null, requestMetrics: undefined });
  const statuses = new Map<string, number>();
  try {
    for (const pattern of GOLDEN.routes) {
      const { method, path } = concreteRequest(pattern);
      // The three upgrade-only routes answer 426 through `app.request`; the WS
      // behaviour is asserted separately below against a real server.
      if (pattern === "GET /api/daemon/ws" || pattern === "GET /ws" || pattern === "GET /api/realtime/ws") continue;
      const response = await app.request(path, { method });
      statuses.set(pattern, response.status);
    }
  } finally {
    db.close();
  }
  return statuses;
}

afterEach(() => {
  delete process.env.MULTIREMI_API_ROLE;
});

describe("MUL-461 api role — env resolution", () => {
  it("defaults to all and never invents a split role", () => {
    expect(resolveApiRole({})).toBe("all");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "" })).toBe("all");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "   " })).toBe("all");
    // A typo must degrade to main's behavior, not silently split a process.
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "runtim" })).toBe("all");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "browser" })).toBe("all");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "0" })).toBe("all");
  });

  it("accepts the three documented values, case- and whitespace-insensitively", () => {
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "all" })).toBe("all");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "ui" })).toBe("ui");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "runtime" })).toBe("runtime");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: " RUNTIME " })).toBe("runtime");
    expect(resolveApiRole({ MULTIREMI_API_ROLE: "Ui" })).toBe("ui");
  });

  it("treats the daemon prefix as trailing-slash only", () => {
    expect(isDaemonPath("/api/daemon/")).toBe(true);
    expect(isDaemonPath("/api/daemon/heartbeat")).toBe(true);
    expect(isDaemonPath("/api/daemon/ws")).toBe(true);
    expect(isDaemonPath("/api/daemon/tasks/t1/claim")).toBe(true);

    // `/api/daemons/:id` (plural) is a browser route in the same app: matching the
    // bare prefix would hand a page request to the runtime process.
    expect(isDaemonPath("/api/daemons")).toBe(false);
    expect(isDaemonPath("/api/daemons/rt_1")).toBe(false);
    expect(isDaemonPath("/api/daemon")).toBe(false);
  });

  it("lets runtime keep exactly the daemon protocol, the health probes and /internal", () => {
    for (const allowed of [
      "/api/daemon/ws",
      "/api/daemon/heartbeat",
      "/health",
      "/healthz",
      "/readyz",
      "/health/realtime",
      "/api/multiremi/health",
      "/internal/peer/events",
      "/internal/peer/health",
    ]) {
      expect(isRuntimeAllowedPath(allowed), allowed).toBe(true);
    }
    for (const refused of [
      "/",
      "/api/issues",
      "/api/daemons/rt_1",
      "/ws",
      "/api/realtime/ws",
      // A prefix sweep on "health" would have swallowed this browser route.
      "/api/cloud-runtime/healthz",
      "/api/cloud-runtime/readyz",
    ]) {
      expect(isRuntimeAllowedPath(refused), refused).toBe(false);
    }
  });

  it("refuses nothing at all as all", () => {
    for (const pattern of GOLDEN.routes) {
      const { path } = concreteRequest(pattern);
      expect(isMisdirectedPath("all", path), pattern).toBe(false);
    }
  });
});

describe("MUL-461 api role — guard over the full golden route inventory", () => {
  it("keeps main's behavior when the role is all", async () => {
    const statuses = await sweep("all");
    expect(statuses.size).toBe(GOLDEN.routes.length - 3);
    for (const [pattern, status] of statuses) {
      expect(status, `${pattern} answered ${status} as all`).not.toBe(421);
    }
  });

  it("refuses /api/daemon/* and nothing else as ui", async () => {
    const daemon = await sweep("ui");
    const misdirected: string[] = [];
    for (const [pattern, status] of daemon) {
      const { path } = concreteRequest(pattern);
      if (status === 421) misdirected.push(pattern);
      // The guard is the ONLY source of 421, so the set of 421s must be exactly
      // the daemon paths: this catches both a missing refusal and an over-broad one.
      expect(isDaemonPath(path), `${pattern} -> ${status}`).toBe(status === 421);
    }
    // 70 of the 759 patterns live under `/api/daemon/`; a zero here would mean the
    // guard silently stopped registering.
    expect(misdirected.length).toBeGreaterThan(0);
    expect(misdirected.every((pattern) => isDaemonPath(concreteRequest(pattern).path))).toBe(true);
  });

  it("refuses everything but the daemon protocol, health and /internal as runtime", async () => {
    const statuses = await sweep("runtime");
    for (const [pattern, status] of statuses) {
      const { path } = concreteRequest(pattern);
      expect(isRuntimeAllowedPath(path), `${pattern} -> ${status}`).toBe(status !== 421);
    }
    const refused = [...statuses.values()].filter((status) => status === 421).length;
    expect(refused).toBeGreaterThan(0);
  });

  it("answers 421 with the misdirected body, the role header, and a real route still reachable", async () => {
    const { store, db } = memoryStore();
    try {
      const ui = createMultiremiApp({ store, apiRole: "ui", authToken: null });
      const refused = await ui.request("/api/daemon/heartbeat", { method: "POST" });
      expect(refused.status).toBe(421);
      expect(refused.headers.get(API_ROLE_HEADER)).toBe("ui");
      expect(await refused.json()).toEqual({ error: "misdirected", role: "ui" });

      const runtime = createMultiremiApp({ store, apiRole: "runtime", authToken: null });
      const refusedRuntime = await runtime.request("/api/issues");
      expect(refusedRuntime.status).toBe(421);
      expect(refusedRuntime.headers.get(API_ROLE_HEADER)).toBe("runtime");
      expect(await refusedRuntime.json()).toEqual({ error: "misdirected", role: "runtime" });

      // `/api/daemons/:id` (plural) is a browser route, so it is the mirror image of
      // the daemon prefix: `ui` must serve it even though the string starts with
      // `/api/daemon`, and `runtime` must refuse it. This is the pair that a bare
      // `startsWith("/api/daemon")` would get exactly backwards.
      const browserOnUi = await ui.request("/api/daemons/rt_missing");
      expect(browserOnUi.status).not.toBe(421);
      const browserOnRuntime = await runtime.request("/api/daemons/rt_missing");
      expect(browserOnRuntime.status).toBe(421);
      expect(browserOnRuntime.headers.get(API_ROLE_HEADER)).toBe("runtime");
    } finally {
      db.close();
    }
  });

  it("keeps every health probe reachable from both split roles", async () => {
    const { store, db } = memoryStore();
    try {
      for (const role of ["ui", "runtime"] as const) {
        const app = createMultiremiApp({ store, apiRole: role, authToken: null });
        for (const path of ["/health", "/healthz", "/readyz", "/health/realtime"]) {
          expect((await app.request(path)).status, `${role} ${path}`).toBe(200);
        }
      }
    } finally {
      db.close();
    }
  });
});

describe("MUL-461 api role — websocket upgrades", () => {
  /**
   * A real `Bun.serve` instance, because the upgrade branch runs before Hono and
   * `app.request` cannot reach it. Each role gets its own server so the assertion
   * is about the role, not about upgrade state left over from a previous case.
   */
  async function upgradeStatus(role: ApiRole, path: string): Promise<{ status: number; role: string | null }> {
    const { store, db } = memoryStore();
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: null,
      apiRole: role,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      // A successful upgrade has no readable body and stays open; only the refusal
      // path is exercised here, so drain the body to release the connection.
      if (response.status === 421) await response.text();
      else response.body?.cancel();
      return { status: response.status, role: response.headers.get(API_ROLE_HEADER) };
    } finally {
      server.stop(true);
      db.close();
    }
  }

  it("refuses the daemon upgrade as ui with 421, not 426", async () => {
    const refused = await upgradeStatus("ui", "/api/daemon/ws?runtime_ids=rt_probe");
    expect(refused.status).toBe(421);
    expect(refused.role).toBe("ui");
  });

  it("refuses the browser upgrades as runtime with 421, not 426", async () => {
    for (const path of ["/ws?workspace_id=local", "/api/realtime/ws?workspace_id=local"]) {
      const refused = await upgradeStatus("runtime", path);
      expect(refused.status, path).toBe(421);
      expect(refused.role, path).toBe("runtime");
    }
  });

  it("keeps the 426 upgrade-required answer for a non-upgrade GET", async () => {
    const { store, db } = memoryStore();
    try {
      // `/api/daemon/ws` and `/ws` remain mounted routes; a plain GET must still get
      // the "websocket upgrade required" contract rather than a role refusal.
      const app = createMultiremiApp({ store, apiRole: "all", authToken: null });
      const fallback = await app.request("/api/daemon/ws");
      expect(fallback.status).toBe(426);
      expect((await fallback.json()).upgrade_required).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("MUL-461 api role — health and effective config", () => {
  it("omits role from the health payloads when the env var is unset", async () => {
    delete process.env.MULTIREMI_API_ROLE;
    const { store, db } = memoryStore();
    try {
      const app = createMultiremiApp({ store, authToken: null });
      // Byte-identity with main matters here: `snapshot-api-routes.ts` records these
      // bodies, so an unconditional `role` would break the golden check.
      expect(await (await app.request("/health")).json()).toEqual({ ok: true });
      expect(await (await app.request("/readyz")).json()).toEqual({ ok: true });
      expect(await (await app.request("/healthz")).json()).toEqual({ ok: true });
      expect(await (await app.request("/health/realtime")).json()).toEqual({
        connections: 0,
        enabled: true,
        transport: "websocket",
      });
    } finally {
      db.close();
    }
  });

  it("reports the effective role on every health payload once a role is set", async () => {
    const { store, db } = memoryStore();
    try {
      for (const role of ["all", "ui", "runtime"] as const) {
        const app = createMultiremiApp({ store, apiRole: role, authToken: null });
        expect(await (await app.request("/health")).json()).toMatchObject({ ok: true, role });
        expect(await (await app.request("/readyz")).json()).toMatchObject({ ok: true, role });
        expect(await (await app.request("/healthz")).json()).toMatchObject({ ok: true, role });
        expect(await (await app.request("/health/realtime")).json()).toMatchObject({ role });
      }
    } finally {
      db.close();
    }
  });

  it("logs apiRole in the effective config and warns when a split role runs on SQLite", async () => {
    const { store, db } = memoryStore();
    try {
      const lines: string[] = [];
      const realLog = console.log;
      const realWarn = console.warn;
      console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
      console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
      const server = startMultiremiServer({
        store,
        scheduler: null,
        port: 0,
        hostname: "127.0.0.1",
        authToken: null,
        apiRole: "runtime",
      });
      server.stop(true);
      console.log = realLog;
      console.warn = realWarn;

      const effective = lines.find((line) => line.includes("[effective-config]"));
      expect(effective).toBeTruthy();
      expect(JSON.parse(effective!.slice(effective!.indexOf("{")))).toMatchObject({
        apiRole: "runtime",
        mode: "local",
      });
      expect(lines.some((line) => line.includes("[configuration-degradation]") && line.includes("SQLite")))
        .toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("MUL-461 api role — role on the metrics events", () => {
  it("stamps role on api_minute_summary and api_slow_request", async () => {
    const { store, db } = memoryStore();
    const options = {
      enabled: true,
      slowRequestMs: 0,
      summaryIntervalMs: 60_000,
      summaryTopRoutes: 10,
      bufferCapacity: 64,
      role: "runtime" as const,
    };
    const app = createMultiremiApp({
      store,
      authToken: null,
      apiRole: "runtime",
      requestMetrics: options,
    });
    const runtime = startRequestMetricsSummary(options);
    try {
      const { lines } = await captureConsoleLog(async () => {
        await app.request("/health");
        runtime?.flush();
      });
      const slow = lines.filter((line) => line.includes("api_slow_request"));
      const summary = lines.filter((line) => line.includes("api_minute_summary"));
      expect(slow).toHaveLength(1);
      expect(summary).toHaveLength(1);
      expect(JSON.parse(slow[0]!).role).toBe("runtime");
      expect(JSON.parse(summary[0]!).role).toBe("runtime");
    } finally {
      runtime?.stop();
      db.close();
    }
  });
});
