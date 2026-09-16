import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { RuntimeClaudeProfileInput } from "@multiremi/contracts/claude-profile";
import { runtimeModelsKeys } from "./models";
import { api } from "../api";
import { runtimeKeys } from "./queries";
export type { RuntimeClaudeProfile, RuntimeClaudeProfileConfig } from "@multiremi/contracts/claude-profile";

export function runtimeProviderProfileOptions(wsId: string, runtimeId: string, provider: "codex" | "claude") {
  return queryOptions({
    queryKey: [...runtimeKeys.all(wsId), runtimeId, `${provider}-profile`],
    queryFn: () => provider === "codex" ? api.getRuntimeCodexProfile(runtimeId) : api.getRuntimeClaudeProfile(runtimeId), enabled: Boolean(wsId && runtimeId), staleTime: 10_000,
  });
}

export function useSetRuntimeProviderProfile(wsId: string, runtimeId: string, provider: "codex" | "claude") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RuntimeClaudeProfileInput) => provider === "codex" ? api.setRuntimeCodexProfile(runtimeId, input) : api.setRuntimeClaudeProfile(runtimeId, input),
    onSuccess: async result => {
      qc.setQueryData(runtimeProviderProfileOptions(wsId, runtimeId, provider).queryKey, result);
      await qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.forRuntime(runtimeId) });
    },
  });
}
