import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { PluginsEndpoints } from "./plugins";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PluginsEndpoints", () => {
  it("lists plugins using the provider query and unwraps the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        plugins: [{ id: "plugin-1", provider: "future_provider" }],
        total: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );

    const plugins = await endpoints.listAgentPlugins(
      "claude/preview",
      "workspace/1",
    );

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.provider).toBe("future_provider");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/agent-plugins?provider=claude%2Fpreview&workspace_id=workspace%2F1",
    );
  });

  it("uses the import endpoint and preserves the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ plugin: { id: "plugin-1", provider: "claude" } }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );
    const input = {
      workspaceId: "workspace-1",
      provider: "claude",
      manifest: { name: "review-tools" },
    } as const;

    await expect(endpoints.importAgentPlugin(input)).resolves.toMatchObject({
      id: "plugin-1",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/agent-plugins/import",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(input),
    });
  });

  it("inspects a Plugin repository and parses candidate defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        inspection: {
          sourceUrl: "https://example.test/plugins.git",
          sourceRef: "main",
          defaultBranch: "main",
          branches: ["main"],
          sourceRevision: "1234567890abcdef1234567890abcdef12345678",
          candidates: [{
            provider: "claude",
            name: "Review tools",
            description: "Review code",
            version: "1.0.0",
            sourceSubdir: "plugins/review",
            manifestPath: ".claude-plugin/plugin.json",
            manifest: { name: "Review tools", version: "1.0.0" },
            fileCount: 2,
            artifactSize: 128,
          }],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );
    const input = {
      workspaceId: "workspace-1",
      sourceUrl: "https://example.test/plugins.git",
    };

    await expect(endpoints.inspectAgentPluginRepository(input)).resolves.toMatchObject({
      sourceRef: "main",
      candidates: [{
        provider: "claude",
        name: "Review tools",
        version: "1.0.0",
        manifest: { name: "Review tools", version: "1.0.0" },
      }],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/agent-plugins/inspect",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(input),
    });
  });

  it("lists, creates, activates, and rolls back plugin versions", async () => {
    const plugin = { id: "plugin/1", provider: "claude" };
    const version = { id: "version/2", pluginId: "plugin/1" };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ versions: [version], total: 1 }))
      .mockResolvedValueOnce(jsonResponse({ plugin, version }, 201))
      .mockResolvedValueOnce(jsonResponse({ plugin }))
      .mockResolvedValueOnce(jsonResponse({ plugin }))
      .mockResolvedValueOnce(jsonResponse({ plugin }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );
    const input = {
      manifest: { name: "review-tools", version: "2.0.0" },
      activate: false,
    };

    await expect(
      endpoints.listAgentPluginVersions("plugin/1"),
    ).resolves.toMatchObject([{ id: "version/2" }]);
    await expect(
      endpoints.createAgentPluginVersion("plugin/1", input),
    ).resolves.toMatchObject({
      plugin: { id: "plugin/1" },
      version: { id: "version/2" },
    });
    await expect(
      endpoints.activateAgentPluginVersion("plugin/1", "version/2"),
    ).resolves.toMatchObject({ id: "plugin/1" });
    await expect(
      endpoints.rollbackAgentPluginVersion("plugin/1"),
    ).resolves.toMatchObject({ id: "plugin/1" });
    await expect(
      endpoints.rollbackAgentPluginVersion("plugin/1", "version/1"),
    ).resolves.toMatchObject({ id: "plugin/1" });

    expect(
      fetchMock.mock.calls.map(([url, init]) => ({
        url,
        method: init?.method ?? "GET",
        body: init?.body,
      })),
    ).toEqual([
      {
        url: "https://api.example.test/api/multiremi/agent-plugins/plugin%2F1/versions",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.example.test/api/multiremi/agent-plugins/plugin%2F1/versions",
        method: "POST",
        body: JSON.stringify(input),
      },
      {
        url: "https://api.example.test/api/multiremi/agent-plugins/plugin%2F1/activate",
        method: "POST",
        body: JSON.stringify({ versionId: "version/2" }),
      },
      {
        url: "https://api.example.test/api/multiremi/agent-plugins/plugin%2F1/rollback",
        method: "POST",
        body: JSON.stringify({}),
      },
      {
        url: "https://api.example.test/api/multiremi/agent-plugins/plugin%2F1/rollback",
        method: "POST",
        body: JSON.stringify({ versionId: "version/1" }),
      },
    ]);
  });

  it("uses encoded binding paths and the expected mutation bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ binding: null }, 201))
      .mockResolvedValueOnce(jsonResponse({ binding: null }))
      .mockResolvedValueOnce(jsonResponse({ deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await endpoints.createAgentPluginBinding("agent/1", {
      pluginId: "plugin-1",
    });
    await endpoints.updateAgentPluginBinding("agent/1", "binding/1", {
      enabled: false,
    });
    await endpoints.deleteAgentPluginBinding("agent/1", "binding/1");

    expect(
      fetchMock.mock.calls.map(([url, init]) => ({
        url,
        method: init?.method ?? "GET",
        body: init?.body,
      })),
    ).toMatchObject([
      {
        url: "https://api.example.test/api/multiremi/agents/agent%2F1/plugins",
        method: "POST",
        body: JSON.stringify({ pluginId: "plugin-1" }),
      },
      {
        url: "https://api.example.test/api/multiremi/agents/agent%2F1/plugins/binding%2F1",
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      },
      {
        url: "https://api.example.test/api/multiremi/agents/agent%2F1/plugins/binding%2F1",
        method: "DELETE",
      },
    ]);
  });

  it("lists a runtime's plugin states without a provider filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ states: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.listRuntimeAgentPluginStates("runtime/1"),
    ).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/runtimes/runtime%2F1/agent-plugins",
    );
  });

  it("retries one exact runtime version through the collection endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ states: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(
      endpoints.retryAgentPluginRuntime(
        "plugin/1",
        "runtime/1",
        "version/1",
      ),
    ).resolves.toEqual([]);
    await expect(
      endpoints.retryAgentPluginRuntime("plugin/1", "runtime/1"),
    ).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/api/multiremi/agent-plugins/plugin%2F1/runtimes/retry",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        runtimeId: "runtime/1",
        versionId: "version/1",
      }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ runtimeId: "runtime/1" }),
    });
  });

  it("degrades malformed plugin, version, and runtime responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ plugins: "not-an-array" }))
      .mockResolvedValueOnce(jsonResponse({ plugin: { id: 123 } }))
      .mockResolvedValueOnce(jsonResponse({ versions: null }))
      .mockResolvedValueOnce(jsonResponse({ plugin: null, version: null }))
      .mockResolvedValueOnce(jsonResponse({ plugin: { id: 123 } }))
      .mockResolvedValueOnce(jsonResponse({ plugin: { provider: "claude" } }))
      .mockResolvedValueOnce(jsonResponse({ states: null }))
      .mockResolvedValueOnce(jsonResponse({ states: "not-an-array" }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoints = new PluginsEndpoints(
      new HttpClient("https://api.example.test"),
    );

    await expect(endpoints.listAgentPlugins()).resolves.toEqual([]);
    await expect(endpoints.getAgentPlugin("plugin-1")).resolves.toBeNull();
    await expect(
      endpoints.listAgentPluginVersions("plugin-1"),
    ).resolves.toEqual([]);
    await expect(
      endpoints.createAgentPluginVersion("plugin-1", { manifest: {} }),
    ).resolves.toBeNull();
    await expect(
      endpoints.activateAgentPluginVersion("plugin-1", "version-1"),
    ).resolves.toBeNull();
    await expect(
      endpoints.rollbackAgentPluginVersion("plugin-1"),
    ).resolves.toBeNull();
    await expect(
      endpoints.listAgentPluginRuntimeStates("plugin-1"),
    ).resolves.toEqual([]);
    await expect(
      endpoints.listRuntimeAgentPluginStates("runtime-1"),
    ).resolves.toEqual([]);
  });
});
