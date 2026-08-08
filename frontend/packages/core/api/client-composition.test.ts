import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ENDPOINT_FACTORIES } from "./client";
import { HttpClient } from "./http";

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
