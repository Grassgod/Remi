import { runtimeProviderProfileOptions, useSetRuntimeProviderProfile } from "./provider-profile";
export type { RuntimeCodexProfile, RuntimeCodexProfileConfig } from "@multiremi/contracts/codex-profile";
export const runtimeCodexProfileOptions = (wsId: string, runtimeId: string) => runtimeProviderProfileOptions(wsId, runtimeId, "codex");
export const useSetRuntimeCodexProfile = (wsId: string, runtimeId: string) => useSetRuntimeProviderProfile(wsId, runtimeId, "codex");
