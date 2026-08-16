import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import {
  agentPluginKeys,
  pluginVersionsOptions,
  runtimePluginStatesOptions,
} from "./queries";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent plugin version and runtime queries", () => {
  it("fetches versions under the plugin-scoped key", async () => {
    const listAgentPluginVersions = vi.fn().mockResolvedValue([]);
    setApiInstance({ listAgentPluginVersions } as unknown as ApiClient);
    const queryClient = new QueryClient();

    const options = pluginVersionsOptions("workspace-1", "plugin/1");
    await queryClient.fetchQuery(options);

    expect(options.queryKey).toEqual(
      agentPluginKeys.versions("workspace-1", "plugin/1"),
    );
    expect(listAgentPluginVersions).toHaveBeenCalledWith("plugin/1");
    queryClient.clear();
  });

  it("fetches all plugin states for one runtime without a provider", async () => {
    const listRuntimeAgentPluginStates = vi.fn().mockResolvedValue([]);
    setApiInstance({ listRuntimeAgentPluginStates } as unknown as ApiClient);
    const queryClient = new QueryClient();

    const options = runtimePluginStatesOptions("workspace-1", "runtime/1");
    await queryClient.fetchQuery(options);

    expect(options.queryKey).toEqual(
      agentPluginKeys.runtimePluginStates("workspace-1", "runtime/1"),
    );
    expect(listRuntimeAgentPluginStates).toHaveBeenCalledWith("runtime/1");
    queryClient.clear();
  });

});
