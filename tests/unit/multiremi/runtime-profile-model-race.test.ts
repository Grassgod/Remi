import { expect, it, spyOn } from "bun:test";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import type { RuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import type { MultiremiRuntimeModel, ReportRuntimeModelListInput } from "@multiremi/contracts/types.js";

type ModelDiscoveryState = {
  runtimeModels: MultiremiRuntimeModel[] | null;
  discoverAcpRuntimeModels(signal: AbortSignal): Promise<MultiremiRuntimeModel[]>;
  applyRuntimeCodexProfile(profile: RuntimeCodexProfile): void;
  handleRuntimeModelList(runtimeId: string, requestId: string): Promise<void>;
  client: {
    reportRuntimeModelListResult(runtimeId: string, requestId: string, result: ReportRuntimeModelListInput): Promise<void>;
  };
};

it("never reports a completed old probe under a replacement connection", async () => {
  const envKey = "REMI_CODEX_MODEL_RACE_TEST_KEY";
  const oldKey = process.env[envKey];
  process.env[envKey] = "fixture-provider-key";
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json({ data: [{ id: url.hostname === "a.invalid" ? "model-from-A" : "model-from-B" }] });
  }) as typeof fetch);
  const daemon = new MultiremiDaemon({
    serverUrl: "http://127.0.0.1:1", token: "fixture-daemon-token", runtimeId: "fixture-runtime",
    provider: "codex", daemonId: "fixture-daemon", workspaceId: "local", gcEnabled: false,
    inProcessRuntimeModelDiscoveryEnabled: true,
    providerFactory: () => { throw new Error("Custom profiles must use their own catalog"); },
  });
  const state = daemon as unknown as ModelDiscoveryState;
  state.discoverAcpRuntimeModels = async () => { throw new Error("ACP unavailable in fixture"); };
  const profileA: RuntimeCodexProfile = { name: "A", base_url: "https://a.invalid/v1", model: "defaultA", env_key: envKey };
  const profileB = { ...profileA, name: "B", base_url: "https://b.invalid/v1", model: "defaultB" };
  const reports = new Map<string, ReportRuntimeModelListInput>();
  state.client.reportRuntimeModelListResult = async (_runtimeId, requestId, result) => { reports.set(requestId, result); };
  try {
    state.applyRuntimeCodexProfile(profileA);
    const first = state.handleRuntimeModelList("fixture-runtime", "request-A");
    const replacement = new Promise<void>((resolve, reject) => {
      let turns = 0;
      const switchAfterCacheWrite = () => {
        if (!state.runtimeModels) {
          if (++turns > 100) { reject(new Error("The fixture probe did not finish")); return; }
          queueMicrotask(switchAfterCacheWrite);
          return;
        }
        // Run between A's cache write and its outer Promise cleanup, like a
        // heartbeat applying B while a manual refresh joins the completed probe.
        state.applyRuntimeCodexProfile(profileB);
        state.handleRuntimeModelList("fixture-runtime", "request-B").then(resolve, reject);
      };
      queueMicrotask(switchAfterCacheWrite);
    });
    await Promise.all([first, replacement]);
    expect(reports.get("request-A")?.model_profile?.name).toBe("A");
    const result = reports.get("request-B")!;
    expect(result.status).toBe("completed");
    expect(result.model_profile?.name).toBe("B");
    expect(result.models?.map(model => model.id)).toEqual(["model-from-B", "defaultB"]);
  } finally {
    fetchMock.mockRestore();
    if (oldKey === undefined) delete process.env[envKey]; else process.env[envKey] = oldKey;
  }
});
