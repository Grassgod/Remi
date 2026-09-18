import { describe, expect, it } from "bun:test";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import type { AcpModelCapability, AcpProviderOptions } from "@acp/provider.js";
import type { CodexModelCatalogState } from "@daemon/agent-runtime/relay-sync.js";

type DiscoveryState = {
  runtimeModels: MultiremiRuntimeModel[];
  discoverAcpRuntimeModels(signal: AbortSignal): Promise<MultiremiRuntimeModel[]>;
  runtimeModelProbeProviderOptions(): Promise<{
    options: AcpProviderOptions;
    catalogState: CodexModelCatalogState;
  }>;
};

const bundled: AcpModelCapability = {
  id: "bundled-model", label: "Bundled", default: true,
  effort: { status: "supported", defaultLevel: "low", supportedLevels: [{ value: "low", label: "Low" }] },
};

function fixture(catalogState: CodexModelCatalogState, discover: () => Promise<AcpModelCapability[]>) {
  let closed = 0;
  const daemon = new MultiremiDaemon({
    serverUrl: "http://127.0.0.1:1", token: "fixture-token", runtimeId: "fixture-runtime",
    provider: "codex", daemonId: "fixture-daemon", workspaceId: "local", gcEnabled: false,
    inProcessRuntimeModelDiscoveryEnabled: true,
    providerFactory: () => ({
      async *sendStream() { throw new Error("Model discovery must not send a prompt"); },
      getLastResponse: () => null,
      discoverModelCapabilities: discover,
      close: () => { closed++; },
    }),
  });
  const state = daemon as unknown as DiscoveryState;
  state.runtimeModels = [{ id: "previous-native-only", label: "Previous", provider: "openai", default: false }];
  state.runtimeModelProbeProviderOptions = async () => ({ options: { agentType: "codex" }, catalogState });
  return { state, closed: () => closed };
}

describe("Runtime native catalog fallback membership", () => {
  it("reports only this probe's bundled members after failure and retains usable GPT defaults", async () => {
    const { state, closed } = fixture({ status: "error", error: "Codex model catalog HTTP 503" }, async () => [bundled]);
    const models = await state.discoverAcpRuntimeModels(new AbortController().signal);
    expect(models.map(model => model.id)).toEqual(["bundled-model"]);
    expect(models[0]).toMatchObject({
      default: true,
      catalog: { status: "error", error: "Codex model catalog HTTP 503" },
      thinking: { status: "supported", defaultLevel: "low", supportedLevels: [{ value: "low", label: "Low" }] },
    });
    expect(closed()).toBe(1);
  });

  it("replaces previous executable members with diagnostic-only state when the fallback probe also fails", async () => {
    const { state, closed } = fixture({ status: "error", error: "Codex model catalog HTTP 503" }, async () => {
      throw new Error("ACP unavailable");
    });
    const models = await state.discoverAcpRuntimeModels(new AbortController().signal);
    expect(models.filter(model => !model.providerDefault)).toEqual([]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ catalog: { status: "error" }, default: false, providerDefault: true });
    expect(models.some(model => model.id === "previous-native-only")).toBe(false);
    expect(closed()).toBe(1);
  });

  it("reports loaded catalogs explicitly while leaving custom or disabled catalog reports unchanged", async () => {
    for (const status of ["loaded", "disabled"] as const) {
      const { state } = fixture({ status }, async () => [bundled]);
      const models = await state.discoverAcpRuntimeModels(new AbortController().signal);
      expect(models[0]?.catalog).toEqual(status === "loaded" ? { status: "ready" } : undefined);
      expect(models[0]?.thinking?.defaultLevel).toBe("low");
    }
  });

  it("does not turn cancellation into a successful fallback report", async () => {
    const abort = new AbortController();
    const { state } = fixture({ status: "error", error: "Codex model catalog HTTP 503" }, async () => {
      abort.abort();
      return [bundled];
    });
    await expect(state.discoverAcpRuntimeModels(abort.signal)).rejects.toThrow();
  });
});
