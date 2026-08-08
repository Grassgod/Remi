/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ENDPOINT_FACTORIES } from "./client";
import { HttpClient } from "./http";

/** Every module file under endpoints/, resolved independently of client.ts.
 *  Deriving the expectation from the filesystem is the whole point: a module
 *  dropped from BOTH the wiring and this test's expectation is exactly the
 *  regression `declaredMethods()` cannot see, because it reads the wiring. */
const ENDPOINT_MODULES = import.meta.glob<Record<string, unknown>>("./endpoints/*.ts", { eager: true });

/** Every public method declared by every endpoint module, paired with the
 *  module that declares it. This is the set the facade must expose. */
function declaredMethods(): Array<{ module: string; method: string }> {
  const http = new HttpClient("https://api.example.test");
  const out: Array<{ module: string; method: string }> = [];
  for (const create of ENDPOINT_FACTORIES) {
    const instance = create(http);
    const proto = Object.getPrototypeOf(instance) as object;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      out.push({ module: instance.constructor.name, method: key });
    }
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient composition", () => {
  it("wires every module in endpoints/ into ENDPOINT_FACTORIES", () => {
    const paths = Object.keys(ENDPOINT_MODULES);
    // Guard the guard: a glob that matches nothing would pass vacuously.
    expect(paths.length).toBeGreaterThan(0);

    const http = new HttpClient("https://api.example.test");
    const wired = new Set<unknown>(ENDPOINT_FACTORIES.map((create) => create(http).constructor));

    const unwired = paths.filter(
      (path) => !Object.values(ENDPOINT_MODULES[path]!).some((exported) => wired.has(exported)),
    );
    expect(unwired).toEqual([]);
    // One factory per file — catches a module wired twice as well.
    expect(ENDPOINT_FACTORIES.length).toBe(paths.length);
  });

  it("exposes every endpoint module method on the facade", () => {
    const client = new ApiClient("https://api.example.test") as unknown as Record<string, unknown>;
    const missing = declaredMethods().filter(({ method }) => typeof client[method] !== "function");
    expect(missing).toEqual([]);
  });

  it("declares no method name in two endpoint modules", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const { module, method } of declaredMethods()) {
      const owner = seen.get(method);
      if (owner) clashes.push(`${method}: ${owner} vs ${module}`);
      else seen.set(method, module);
    }
    expect(clashes).toEqual([]);
  });

  it("does not shadow the facade's own transport accessors", () => {
    const names = new Set(declaredMethods().map(({ method }) => method));
    expect(names.has("getBaseUrl")).toBe(false);
    expect(names.has("setToken")).toBe(false);
  });

  it("binds copied methods to their module so this.http resolves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cdn_domain: "cdn.example.test", allow_signup: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("https://api.example.test");
    const { getConfig } = client;
    // Detached call — the facade hands out bound functions, so this must not
    // lose `this` the way a plain prototype method would.
    await getConfig();

    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.test/api/config");
  });

  it("routes token and base-url changes through the shared HttpClient", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("https://api.example.test");
    expect(client.getBaseUrl()).toBe("https://api.example.test");
    client.setToken("tok-1");
    await client.listWorkspaces();

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-1");
  });
});
