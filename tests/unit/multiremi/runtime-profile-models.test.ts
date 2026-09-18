import { expect, it } from "bun:test";
import { discoverRuntimeProfileModels } from "@multiremi/worker/runtime-profile-models.js";

it("discovers a custom Codex catalog from the Runtime-local base path and keeps its default", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/v2/models");
    expect(request.headers.get("authorization")).toBe("Bearer private-test-key");
    return Response.json({ data: [{ id: "astra", display_name: "Astra" }, { id: "sol" }, { id: "sol" }] });
  } });
  try {
    const models = await discoverRuntimeProfileModels("codex", {
      name: "local", base_url: `http://127.0.0.1:${server.port}/v2`, model: "default-alias", env_key: "REMI_CODEX_KEY",
    }, "private-test-key", new AbortController().signal);
    expect(models).toEqual([
      { id: "astra", label: "Astra", provider: "codex", default: false },
      { id: "sol", label: "sol", provider: "codex", default: false },
      { id: "default-alias", label: "default-alias", provider: "codex", default: true },
    ]);
  } finally { server.stop(true); }
});

it("reads all Claude pages using the configured authentication header", async () => {
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    calls++;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/models");
    expect(request.headers.get("x-api-key")).toBe("private-test-key");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
    return url.searchParams.get("after_id") === "first"
      ? Response.json({ data: [{ id: "second" }], has_more: false })
      : Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" });
  } });
  try {
    for (const suffix of ["", "/v1"]) {
      const models = await discoverRuntimeProfileModels("claude", {
        name: "local", base_url: `http://127.0.0.1:${server.port}${suffix}`, model: "first", env_key: "REMI_CLAUDE_KEY", auth_header: "x-api-key",
      }, "private-test-key", new AbortController().signal);
      expect(models.map(model => model.id)).toEqual(["first", "second"]);
    }
    expect(calls).toBe(4);
  } finally { server.stop(true); }
});

it("rejects invalid, failed and redirected catalogs without disclosing response bodies", async () => {
  let response = () => new Response("echo-private-test-key", { status: 401 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => response() });
  const probe = () => discoverRuntimeProfileModels("codex", {
    name: "local", base_url: `http://127.0.0.1:${server.port}`, model: "astra", env_key: "REMI_CODEX_KEY",
  }, "private-test-key", new AbortController().signal);
  try {
    await expect(probe()).rejects.toThrow("Runtime codex model discovery HTTP 401");
    response = () => new Response("echo-private-test-key");
    await expect(probe()).rejects.toThrow("returned invalid JSON");
    response = () => Response.json({ data: [] });
    await expect(probe()).rejects.toThrow("returned no models");
    response = () => Response.json({ error: "echo-private-test-key" });
    await expect(probe()).rejects.toThrow("requires a data array");
    response = () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:1" } });
    await expect(probe()).rejects.toThrow();
  } finally { server.stop(true); }
});
