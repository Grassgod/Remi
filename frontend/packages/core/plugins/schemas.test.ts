import { describe, expect, it } from "vitest";
import { parseWithFallback } from "../api/schema";
import {
  AgentPluginBindingListSchema,
  AgentPluginDetailSchema,
  AgentPluginListSchema,
  AgentPluginRuntimeStateListSchema,
  AgentPluginVersionListSchema,
  CreateAgentPluginVersionResultSchema,
  EMPTY_AGENT_PLUGIN_DETAIL,
  EMPTY_AGENT_PLUGIN_LIST,
  EMPTY_AGENT_PLUGIN_RUNTIME_STATE_LIST,
  EMPTY_AGENT_PLUGIN_VERSION_LIST,
  EMPTY_CREATE_AGENT_PLUGIN_VERSION_RESULT,
} from "./schemas";

const plugin = {
  id: "plugin-1",
  provider: "claude",
  futureField: { enabled: true },
};

describe("agent plugin response schemas", () => {
  it("unwraps list envelopes, supplies safe defaults, and preserves new fields", () => {
    const parsed = AgentPluginListSchema.parse({ plugins: [plugin], total: 1 });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "plugin-1",
      provider: "claude",
      runtimeSummary: {
        desired: 0,
        ready: 0,
        pending: 0,
        retrying: 0,
        setupRequired: 0,
        blocked: 0,
        offline: 0,
      },
      futureField: { enabled: true },
    });
  });

  it("keeps unknown server-driven enum values", () => {
    const parsed = AgentPluginRuntimeStateListSchema.parse({
      states: [
        {
          id: "state-1",
          runtimeId: "runtime-1",
          pluginId: "plugin-1",
          pluginVersionId: "version-1",
          status: "future_runtime_status",
          desiredReason: "future_reason",
          plugin: { ...plugin, provider: "future_provider" },
          version: { id: "version-1", pluginId: "plugin-1" },
          runtime: { id: "runtime-1", provider: "future_provider" },
        },
      ],
    });

    expect(parsed[0]?.status).toBe("future_runtime_status");
    expect(parsed[0]?.plugin.provider).toBe("future_provider");
    expect(parsed[0]?.desiredReason).toBe("future_reason");
  });

  it("unwraps version lists and parses create-version results", () => {
    const version = {
      id: "version-2",
      pluginId: "plugin-1",
      futureField: "preserved",
    };

    expect(
      AgentPluginVersionListSchema.parse({ versions: [version], total: 1 }),
    ).toMatchObject([
      {
        id: "version-2",
        manifest: {},
        files: [],
        futureField: "preserved",
      },
    ]);
    expect(
      CreateAgentPluginVersionResultSchema.parse({ plugin, version }),
    ).toMatchObject({
      plugin: { id: "plugin-1" },
      version: { id: "version-2" },
    });
  });

  it("accepts current bare-array binding responses", () => {
    const parsed = AgentPluginBindingListSchema.parse([
      {
        id: "binding-1",
        agentId: "agent-1",
        pluginId: "plugin-1",
        plugin,
      },
    ]);

    expect(parsed[0]).toMatchObject({
      id: "binding-1",
      enabled: true,
      versionPolicy: "follow_active",
      config: {},
    });
  });

  it("degrades malformed list and detail responses", () => {
    expect(
      parseWithFallback(
        { plugins: "not-an-array" },
        AgentPluginListSchema,
        EMPTY_AGENT_PLUGIN_LIST,
        { endpoint: "test plugin list" },
      ),
    ).toEqual([]);
    expect(
      parseWithFallback(
        { versions: null },
        AgentPluginVersionListSchema,
        EMPTY_AGENT_PLUGIN_VERSION_LIST,
        { endpoint: "test plugin versions" },
      ),
    ).toEqual([]);
    expect(
      parseWithFallback(
        { plugin: null, version: null },
        CreateAgentPluginVersionResultSchema,
        EMPTY_CREATE_AGENT_PLUGIN_VERSION_RESULT,
        { endpoint: "test create plugin version" },
      ),
    ).toBeNull();
    expect(
      parseWithFallback(
        { plugin: { id: 123 } },
        AgentPluginDetailSchema,
        EMPTY_AGENT_PLUGIN_DETAIL,
        { endpoint: "test plugin detail" },
      ),
    ).toBeNull();
    expect(
      parseWithFallback(
        { states: null },
        AgentPluginRuntimeStateListSchema,
        EMPTY_AGENT_PLUGIN_RUNTIME_STATE_LIST,
        { endpoint: "test plugin runtime states" },
      ),
    ).toEqual([]);
  });
});
