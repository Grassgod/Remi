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
import {
  startRequestMetricsSummary,
  type RequestMetricsOptions,
} from "@multiremi/observability/request-metrics.js";

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
 * What the plan's guard table says, written out literally.
 *
 * Deliberately NOT imported from `api-role.ts`: expectations that call the same
 * predicate the guard calls agree with the guard even when the guard is wrong.
 * These are transcriptions of MUL-455 §3.2, so a bug in `isMisdirectedPath` /
 * `isRuntimeAllowedPath` fails this suite instead of defining the answer.
 *
 * `ui` = the page process: it refuses the daemon protocol prefix and serves
 * everything else. `runtime` = the daemon process: an allowlist of prefixes and
 * exact paths; everything else is refused.
 */
const RUNTIME_ALLOWED_PREFIXES = ["/api/daemon/", "/health/", "/internal/"] as const;
const RUNTIME_ALLOWED_EXACT = ["/health", "/healthz", "/readyz", "/api/multiremi/health"] as const;

/** Independent re-implementation of §3.2, used as the oracle. */
function expectedRefusal(role: ApiRole, pathname: string): boolean {
  if (role === "all") return false;
  if (role === "ui") return pathname.startsWith("/api/daemon/");
  if (RUNTIME_ALLOWED_EXACT.includes(pathname as (typeof RUNTIME_ALLOWED_EXACT)[number])) return false;
  return !RUNTIME_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Why the fixed counts below are allowed to be literals, and what to do when one
 * fails.
 *
 * These three numbers turn every PR that adds a route into a decision point: the
 * guard table in MUL-455 §3.2 says which process serves a new path, and a route
 * added under the wrong prefix is exactly the regression this matrix exists to
 * catch. Failing here is not "update the number until it is green" — decide first,
 * then record the decision.
 */
function routeCountHint(role: ApiRole): string {
  return [
    `The ${role} route count changed, which means the golden inventory gained or lost a route.`,
    "Before touching this number:",
    "  1. Read the new route's path and classify it against the literal rules at the top of this",
    "     file (RUNTIME_ALLOWED_PREFIXES / RUNTIME_ALLOWED_EXACT), NOT against the implementation.",
    "     /api/daemon/* -> the runtime process serves it and ui answers 421.",
    "     /api/daemons/:id (plural) and everything else outside the allowlist -> ui serves it.",
    "  2. Confirm the route really belongs where it was added. A daemon-protocol route registered",
    "     outside /api/daemon/ (or a browser route added under it) is a routing bug, not a count to",
    "     bump: MUL-464 sends /api/daemon/ to api-runtime in nginx, so such a route would 421 in",
    "     production for the process that should serve it.",
    "  3. Only then update the literal below, and update the sweep's own arithmetic (the upgrade-only",
    "     routes cannot be driven by app.request and are asserted in the websocket block instead).",
    "If the classification above and the observed status disagree, the guard is wrong, not the count.",
  ].join("\n");
}

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

/**
 * A real `Bun.serve` instance plus the metrics lines it produced.
 *
 * The two QA blockers both live in `Bun.serve`'s fetch handler — a plain-HTTP 421
 * that never reached Hono, and a metrics `role` that could disagree with the
 * process's effective role — so neither is observable through `app.request`.
 * `slowRequestMs: 0` makes every request emit a slow line, which is what lets a
 * single call assert on both log events.
 */
async function withServedMetrics(
  options: {
    apiRole: ApiRole;
    /** Deliberately WRONG role for the metrics options, to catch a diverge. */
    injectedMetricsRole?: ApiRole;
    requests: Array<{ path: string; upgrade?: boolean }>;
  },
): Promise<{ summaries: Array<Record<string, any>>; slow: Array<Record<string, any>> }> {
  const { store, db } = memoryStore();
  // The summary timer is the SERVER's own (`startMultiremiServer` starts it from the
  // options it stamps), never one this helper starts: starting a second timer from
  // the raw options would make the test assert its own scaffolding instead of the
  // wiring under test. A short cadence keeps the wait bounded.
  const metricsOptions: RequestMetricsOptions = {
    enabled: true,
    slowRequestMs: 0,
    summaryIntervalMs: 120,
    summaryTopRoutes: 10,
    bufferCapacity: 64,
    role: options.injectedMetricsRole ?? options.apiRole,
  };
  const server = startMultiremiServer({
    store,
    scheduler: null,
    port: 0,
    hostname: "127.0.0.1",
    authToken: null,
    apiRole: options.apiRole,
    requestMetrics: metricsOptions,
  });
  // Captured here rather than through `captureConsoleLog`: the minute summary only
  // appears on a timer, so the wait below has to read the lines while they are still
  // being written, and that helper only hands its array back once `run` resolves.
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    for (const request of options.requests) {
      const response = await fetch(`http://127.0.0.1:${server.port}${request.path}`, {
        headers: request.upgrade
          ? {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          }
          : undefined,
      });
      await response.text().catch(() => "");
    }
    // Wait for the server's own timer to emit the window covering these requests.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && !lines.some((line) => line.includes("api_minute_summary"))) {
      await Bun.sleep(40);
    }
    return {
      summaries: lines.filter((line) => line.includes("api_minute_summary")).map((line) => JSON.parse(line)),
      slow: lines.filter((line) => line.includes("api_slow_request")).map((line) => JSON.parse(line)),
    };
  } finally {
    console.log = realLog;
    server.stop(true);
    db.close();
  }
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
      expect(expectedRefusal("runtime", allowed), `oracle ${allowed}`).toBe(false);
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
      expect(expectedRefusal("runtime", refused), `oracle ${refused}`).toBe(true);
    }
  });

  it("refuses nothing at all as all", () => {
    for (const pattern of GOLDEN.routes) {
      const { path } = concreteRequest(pattern);
      expect(isMisdirectedPath("all", path), pattern).toBe(false);
    }
  });

  it("agrees with the literal rule on the boundaries that decide the split", () => {
    // Each pair brackets a rule that is easy to get backwards: the plural browser
    // route next to the daemon prefix, a health-looking browser route next to the
    // real probes, and the peer channel that only the runtime process serves.
    const cases: Array<{ path: string; ui: boolean; runtime: boolean }> = [
      { path: "/api/daemons/x", ui: false, runtime: true },
      { path: "/api/cloud-runtime/healthz", ui: false, runtime: true },
      { path: "/internal/peer/events", ui: false, runtime: false },
      { path: "/internal/peer/health", ui: false, runtime: false },
    ];
    for (const entry of cases) {
      expect(isMisdirectedPath("ui", entry.path), `ui ${entry.path}`).toBe(entry.ui);
      expect(isMisdirectedPath("runtime", entry.path), `runtime ${entry.path}`).toBe(entry.runtime);
      // …and the hand-written oracle the matrix uses agrees, so the two cannot drift.
      expect(expectedRefusal("ui", entry.path), `oracle ui ${entry.path}`).toBe(entry.ui);
      expect(expectedRefusal("runtime", entry.path), `oracle runtime ${entry.path}`).toBe(entry.runtime);
    }
    // `isDaemonPath` is the primitive behind the `ui` column: pin it too, because a
    // dropped trailing slash is exactly the regression QA mutated.
    expect(isDaemonPath("/api/daemons/x")).toBe(false);
    expect(isDaemonPath("/api/daemon/heartbeat")).toBe(true);
  });
});

describe("MUL-461 api role — guard over the full golden route inventory", () => {
  it("keeps main's behavior when the role is all", async () => {
    const statuses = await sweep("all");
    expect(statuses.size).toBe(GOLDEN.routes.length - 3);
    let refused = 0;
    for (const [pattern, status] of statuses) {
      const { path } = concreteRequest(pattern);
      expect(status === 421, `${pattern} answered ${status} as all`).toBe(expectedRefusal("all", path));
      if (status === 421) refused += 1;
    }
    // `all` registers no guard at all, so the answer is always zero — the count is
    // still pinned so a guard accidentally registered for the default role shows up
    // here rather than as a mystery 421 in production.
    expect(refused, routeCountHint("all")).toBe(0);
    // Unlike the split roles, `all` runs every handler, so this sweep costs the
    // whole inventory rather than a guard short-circuit. The default 5 s budget is
    // not enough when the full suite loads the machine in parallel.
  }, 60_000);

  it("refuses /api/daemon/* and nothing else as ui", async () => {
    const statuses = await sweep("ui");
    const misdirected: string[] = [];
    for (const [pattern, status] of statuses) {
      const { path } = concreteRequest(pattern);
      // The guard is the ONLY source of 421, so the set of 421s must be exactly the
      // paths the plan refuses: this catches a missing refusal and an over-broad one.
      expect(status === 421, `${pattern} -> ${status}`).toBe(expectedRefusal("ui", path));
      if (status === 421) misdirected.push(pattern);
    }
    // Fixed counts, derived from the literal rule above (not from the guard).
    // 72 of the 772 swept patterns are refused here; `GET /api/daemon/ws` is the
    // upgrade-only route this sweep cannot drive — the websocket block asserts it —
    // so the full-inventory total is 73. Pinning the swept count AND the arithmetic
    // means a route cannot be reclassified without one of the numbers moving.
    // MUL-412's two /api/daemon/issues/:issueId/decisions routes are runtime
    // protocol traffic, so they move the swept/full totals from 70/71 to 72/73.
    // MUL-462 adds two /internal/peer/* routes. Both roles serve /internal, so
    // the swept inventory grows from 769 to 771 while these refusal totals stay put.
    // MUL-479's context-window PUT is browser traffic that ui serves, so it takes
    // the swept inventory to 772 without moving these totals either.
    expect(misdirected, routeCountHint("ui")).toHaveLength(72);
    expect(misdirected.length + 1, routeCountHint("ui")).toBe(73);
  });

  it("refuses everything but the daemon protocol, health and /internal as runtime", async () => {
    const statuses = await sweep("runtime");
    let refused = 0;
    for (const [pattern, status] of statuses) {
      const { path } = concreteRequest(pattern);
      expect(status === 421, `${pattern} -> ${status}`).toBe(expectedRefusal("runtime", path));
      if (status === 421) refused += 1;
    }
    // 693 of the 772 swept patterns are refused; the two browser upgrade routes
    // (`GET /ws`, `GET /api/realtime/ws`) are upgrade-only, so the full-inventory
    // total is 695. Every browser route main added before MUL-462 sits outside
    // the runtime allowlist (no /api/daemon/, /health/, /internal/ prefix and no bare
    // health path), so each one is refused here and served by ui: MUL-410's five
    // /api/issues/:id/decisions* routes took this count 682 -> 687, and MUL-457's
    // four /api[/multiremi]/issues/:id/parent-done-grant routes took it 687 -> 691.
    // MUL-479's context-window PUT is workspace admin/browser traffic, outside
    // every runtime allowlist prefix; ui serves it and runtime refuses it.
    // MUL-395: /api/issues/status-pages is browser/CLI traffic, outside the
    // runtime allowlist. UI serves it; runtime refuses this one new route.
    // MUL-462's two /internal/peer/* routes increase the swept inventory by two,
    // but runtime serves both, so they leave the refusal totals unchanged. Only
    // MUL-479's context-window PUT moves them, from 692/694 to 693/695.
    expect(refused, routeCountHint("runtime")).toBe(693);
    expect(refused + 2, routeCountHint("runtime")).toBe(695);
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

/**
 * QA blocker: the pre-Hono guard answered plain HTTP outside the measured region,
 * so `api_minute_summary` and `api_slow_request` never saw a 421 at all — the
 * post-split dashboard would have read as if the refused traffic had vanished.
 */
describe("MUL-461 api role — misdirected 421s reach the metrics", () => {
  it("counts a plain-HTTP 421 served by the runtime role", async () => {
    const { summaries, slow } = await withServedMetrics({
      apiRole: "runtime",
      requests: [{ path: "/api/issues" }],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.requests).toBe(1);
    expect(summaries[0]!.role).toBe("runtime");
    // A plain-HTTP refusal is now produced by the guard INSIDE Hono, so the sample
    // carries the resolved route pattern rather than a raw path.
    expect(summaries[0]!.routes).toMatchObject([{ method: "GET", route: "/api/issues", count: 1 }]);

    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ event: "api_slow_request", status: 421, role: "runtime", route: "/api/issues" });
  });

  it("counts a misdirected websocket upgrade refused by the ui role", async () => {
    const { summaries, slow } = await withServedMetrics({
      apiRole: "ui",
      requests: [{ path: "/api/daemon/ws?runtime_ids=rt_x", upgrade: true }],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.requests).toBe(1);
    expect(summaries[0]!.role).toBe("ui");
    // The upgrade is refused through the same guard middleware, so it reports the
    // registered pattern — and never the `runtime_ids` query it carried.
    expect(summaries[0]!.routes).toMatchObject([{ method: "GET", route: "/api/daemon/ws", count: 1 }]);
    expect(JSON.stringify(summaries[0])).not.toContain("rt_x");

    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ status: 421, role: "ui", route: "/api/daemon/ws" });
  });

  it("still upgrades for the role that owns the endpoint", async () => {
    // The guard must not swallow a legitimate upgrade: runtime owns the daemon
    // socket, so `server.upgrade` has to run and the request must NOT be recorded as
    // a refusal. An unauthenticated upgrade on a real socket stays open, so only the
    // metrics are asserted here (the handshake itself is covered elsewhere).
    const { store, db } = memoryStore();
    const metricsOptions: RequestMetricsOptions = {
      enabled: true,
      slowRequestMs: 0,
      summaryIntervalMs: 60_000,
      summaryTopRoutes: 10,
      bufferCapacity: 64,
      role: "runtime",
    };
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: null,
      apiRole: "runtime",
      requestMetrics: metricsOptions,
    });
    const summary = startRequestMetricsSummary(metricsOptions);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_missing`, {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      // `rt_missing` does not exist, so the daemon handler answers 404 — the point is
      // that it is NOT a 421 from the guard.
      expect(response.status).not.toBe(421);
      await response.text().catch(() => "");
      const { lines } = await captureConsoleLog(async () => {
        summary?.flush();
      });
      const summaries = lines.filter((line) => line.includes("api_minute_summary")).map((line) => JSON.parse(line));
      expect(summaries[0]!.role).toBe("runtime");
    } finally {
      summary?.stop();
      server.stop(true);
      db.close();
    }
  });
});

/**
 * QA blocker: `options.requestMetrics ?? {...}` let an injected metrics object
 * decide the role, so a runtime process could report `role:"all"` while its guard
 * refused runtime traffic. The effective role is now stamped last, and the
 * pre-Hono upgrade guard reads the same value the middleware does.
 */
describe("MUL-461 api role — one effective role per process", () => {
  it("lets the effective role win over an injected metrics role", async () => {
    const { summaries, slow } = await withServedMetrics({
      apiRole: "runtime",
      // A caller that passes stale options must not be able to relabel the process.
      injectedMetricsRole: "all",
      requests: [{ path: "/api/issues" }],
    });

    expect(summaries[0]!.role).toBe("runtime");
    expect(slow[0]!.role).toBe("runtime");
  });

  it("applies an injected apiRole without touching the env", async () => {
    // No MULTIREMI_API_ROLE in the environment at all: the injected option is the
    // only source, so a pre-Hono guard that read the env would disagree with Hono.
    delete process.env.MULTIREMI_API_ROLE;
    const { summaries } = await withServedMetrics({
      apiRole: "runtime",
      requests: [
        { path: "/api/issues" },
        { path: "/ws?workspace_id=local", upgrade: true },
      ],
    });

    // Both the plain-HTTP guard and the upgrade guard refused, and both are counted.
    expect(summaries[0]!.role).toBe("runtime");
    expect(summaries[0]!.requests).toBe(2);
  });

  it("keeps the guard and the upgrade guard in agreement on the same role", async () => {
    const { store, db } = memoryStore();
    const server = startMultiremiServer({
      store,
      scheduler: null,
      port: 0,
      hostname: "127.0.0.1",
      authToken: null,
      apiRole: "runtime",
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const upgradeHeaders = {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      // Hono-guard path (plain HTTP) vs fetch pre-guard path (upgrade): same role,
      // same status, same header.
      const http = await fetch(`${baseUrl}/api/issues`);
      const upgrade = await fetch(`${baseUrl}/ws?workspace_id=local`, { headers: upgradeHeaders });
      await http.text();
      await upgrade.text().catch(() => "");
      expect(http.status).toBe(421);
      expect(upgrade.status).toBe(421);
      expect(http.headers.get(API_ROLE_HEADER)).toBe("runtime");
      expect(upgrade.headers.get(API_ROLE_HEADER)).toBe("runtime");
    } finally {
      server.stop(true);
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
