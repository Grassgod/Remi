// MUL-389: the per-request read cache must be invisible outside its request and must never
// outlive a write.
//
// The heartbeat needs to look the same Runtime / workspace / membership / relay rows up several
// times inside one request, so the store memoizes them. Two properties make that safe, and both
// are asserted here because a regression in either would be silent:
//
//   1. scope — the cache lives for exactly one HTTP request. A token that was revoked, expired or
//      re-scoped between two requests must be rejected on the very next one; if a cache entry ever
//      escaped the request, the old row would keep authenticating.
//   2. invalidation — a store write must clear the rows it can change. A heartbeat writes its own
//      Runtime row, so the read that follows inside the same request has to observe that write.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import {
  activeRequestReadCache,
  withRequestReadCache,
  invalidatingDatabase,
  cacheKey,
} from "@multiremi/store/request-read-cache.js";

afterEach(resetMultiremiTestEnv);

describe("request-scoped read cache", () => {
  it("is inactive outside a request scope", () => {
    // Background jobs, CLI commands and tests run without a scope; the store must then read
    // straight through, which is what `activeRequestReadCache() === null` guarantees.
    expect(activeRequestReadCache()).toBeNull();
    withRequestReadCache(() => {
      expect(activeRequestReadCache()).not.toBeNull();
    });
    expect(activeRequestReadCache()).toBeNull();
  });

  it("does not leak entries from one request into the next", async () => {
    const store = createStore();
    store.createWorkspaceMember({ id: "usr_cache", userId: "usr_cache", name: "Cache user", role: "member" });
    const runtime = store.registerRuntime({
      id: "rt_cache",
      name: "Cache runtime",
      provider: "codex",
      daemonId: "daemon-cache",
      workspaceId: "local",
      ownerId: "local",
      status: "online",
    });
    const token = await store.createAccessToken({
      workspaceId: "local",
      name: "Cache daemon",
      type: "daemon",
      daemonId: "daemon-cache",
    });
    const app = createMultiremiApp({ store, authToken: "cache-master", backgroundJobs: false });
    const heartbeat = () => app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtime.id }),
    });

    expect((await heartbeat()).status).toBe(200);

    // Revoke between requests. The very next heartbeat must be rejected: the token row was read
    // in the previous request's scope and must not have survived it. (The token is a bound daemon
    // credential, so retirement is what revokes it rather than `revokeAccessToken`.)
    const plan = store.getDaemonRetirementPlan("local", "daemon-cache");
    store.retireDaemon("local", "daemon-cache", plan.snapshot, "local");
    expect(store.getAccessToken(token.id)?.revokedAt).not.toBeNull();
    expect((await heartbeat()).status).toBe(401);
  });

  it("keeps authenticating while the token is live, across many requests", async () => {
    // The complement of the revocation check: request-scoping must not mean the cache is rebuilt
    // into something that fails after the first request.
    const store = createStore();
    store.createWorkspaceMember({ id: "usr_live", userId: "usr_live", name: "Live user", role: "member" });
    const runtime = store.registerRuntime({
      id: "rt_live",
      name: "Live runtime",
      provider: "codex",
      daemonId: "daemon-live",
      workspaceId: "local",
      ownerId: "local",
      status: "online",
    });
    const token = await store.createAccessToken({
      workspaceId: "local",
      name: "Live daemon",
      type: "daemon",
      daemonId: "daemon-live",
    });
    const app = createMultiremiApp({ store, authToken: "live-master", backgroundJobs: false });
    for (let index = 0; index < 4; index += 1) {
      const response = await app.request("/api/daemon/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ runtime_id: runtime.id }),
      });
      expect(response.status, `heartbeat ${index}`).toBe(200);
    }
  });

  it("observes a write performed inside the same scope", () => {
    // Invalidation is what makes the cache safe to use inside a request that also writes. Here the
    // write is done through the store; the read that follows must see the new value, not the
    // cached pre-write row.
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", { settings: { before: true } });

    withRequestReadCache(() => {
      expect(store.getWorkspace("local")?.settings).toMatchObject({ before: true });
      store.updateWorkspace("local", { settings: { after: true } });
      // Same request, after a write to `multiremi_workspaces`: no stale read.
      expect(store.getWorkspace("local")?.settings).toMatchObject({ after: true });
      expect(store.getWorkspace("local")?.settings).not.toMatchObject({ before: true });
    });

    // Outside the scope the same row still reads correctly.
    expect(store.getWorkspace("local")?.settings).toMatchObject({ after: true });
  });

  it("caches reads within one scope and drops them with the scope", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.registerRuntime({
      id: "rt_scope",
      name: "Scope runtime",
      provider: "codex",
      daemonId: "daemon-scope",
      workspaceId: "local",
      ownerId: "local",
      status: "online",
    });

    let reads = 0;
    const raw = db!;
    const counting = invalidatingDatabase(new Proxy(raw, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "prepare" || key === "query") {
          return (sql: string, ...args: unknown[]) => {
            if (String(sql).includes("FROM multiremi_runtimes")) reads += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, [sql, ...args]);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    const scoped = new (store.constructor as new (handle: unknown) => typeof store)(counting);
    scoped.ensureLocalWorkspace();
    scoped.registerRuntime({
      id: "rt_scope2",
      name: "Scope runtime 2",
      provider: "codex",
      daemonId: "daemon-scope2",
      workspaceId: "local",
      ownerId: "local",
      status: "online",
    });

    reads = 0;
    withRequestReadCache(() => {
      scoped.getRuntimeLite("rt_scope2");
      scoped.getRuntimeLite("rt_scope2");
      scoped.getRuntimeLite("rt_scope2");
    });
    // Three reads inside one scope cost one statement.
    expect(reads).toBe(1);

    reads = 0;
    scoped.getRuntimeLite("rt_scope2");
    scoped.getRuntimeLite("rt_scope2");
    // Without a scope every call reads through.
    expect(reads).toBe(2);
  });

  it("namespaces cache keys by table so a write only drops the rows it can change", () => {
    // `invalidateTable` relies on the `<table>\0<parts>` key shape; if the separator ever changed,
    // a workspace write would start clearing Runtime entries and vice versa.
    const runtimeKey = cacheKey("multiremi_runtimes", "row", "rt_1");
    const workspaceKey = cacheKey("multiremi_workspaces", "row", "rt_1");
    expect(runtimeKey).not.toBe(workspaceKey);
    expect(runtimeKey.startsWith("multiremi_runtimes\u0000")).toBe(true);
    expect(workspaceKey.startsWith("multiremi_workspaces\u0000")).toBe(true);
  });

  describe("transactions", () => {
    // A transaction is where the store takes a lock and re-reads the rows it protects; the
    // heartbeat re-reads its Runtime row that way so a Runtime deleted by another connection is
    // reported gone. `raw` stands in for that other connection: the wrapper never sees its writes.
    function cachedTable() {
      const raw = new Database(":memory:");
      raw.run("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
      raw.run("INSERT INTO t VALUES ('a', 'before')");
      const wrapped = invalidatingDatabase(raw);
      let reads = 0;
      const read = (): string | null => {
        const cache = activeRequestReadCache();
        const key = cacheKey("t", "row", "a");
        const cached = cache?.get<string | null>(key);
        if (cached !== undefined) return cached;
        reads += 1;
        const value = (wrapped.query("SELECT v FROM t WHERE id = ?").get("a") as { v: string } | null)?.v ?? null;
        cache?.set(key, value);
        return value;
      };
      return { raw, wrapped, read, reads: () => reads };
    }

    it("never serves a transaction a row cached before it began", () => {
      const { raw, wrapped, read, reads } = cachedTable();
      withRequestReadCache(() => {
        expect(read()).toBe("before");
        raw.run("UPDATE t SET v = 'after' WHERE id = 'a'");
        // Outside a transaction the row is as old as the request.
        expect(read()).toBe("before");
        const underLock = wrapped.transaction(() => [read(), read()])();
        expect(underLock).toEqual(["after", "after"]);
        // What the transaction read is what the rest of the request keeps.
        expect(read()).toBe("after");
      });
      // One read before the transaction, one inside it; the second read inside it and the one
      // after it are served from the cache.
      expect(reads()).toBe(2);
    });

    it("drops what a failed transaction read", () => {
      const { wrapped, read } = cachedTable();
      withRequestReadCache(() => {
        expect(read()).toBe("before");
        expect(() => wrapped.transaction(() => {
          wrapped.run("UPDATE t SET v = 'rolled back' WHERE id = 'a'");
          expect(read()).toBe("rolled back");
          throw new Error("abort");
        })()).toThrow("abort");
        expect(read()).toBe("before");
      });
    });

    it("reports a Runtime deleted by another connection as gone on the heartbeat", () => {
      const store = createStore();
      store.ensureLocalWorkspace();
      store.registerRuntime({
        id: "rt_gone",
        name: "Gone runtime",
        provider: "claude",
        daemonId: "daemon-gone",
        workspaceId: "local",
        ownerId: "local",
        status: "online",
      });
      withRequestReadCache(() => {
        // The daemon-identity guard reads the Runtime row before the heartbeat locks anything.
        expect(store.getRuntimeLite("rt_gone")).not.toBeNull();
        db!.run("DELETE FROM multiremi_runtimes WHERE id = ?", ["rt_gone"]);
        expect(store.heartbeatRuntime("rt_gone", { agentPluginProtocol: 1 }).status).toBe("runtime_gone");
      });
    });
  });
});
