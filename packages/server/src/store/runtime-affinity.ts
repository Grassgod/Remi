import type { MultiremiRuntime } from "@multiremi/contracts/types.js";

type RuntimeIdentity = Pick<MultiremiRuntime, "id" | "daemonId" | "legacyDaemonId">;

export function runtimeDaemonAliases(runtime: RuntimeIdentity): string[] {
  return [...new Set([runtime.id, runtime.daemonId, runtime.legacyDaemonId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))];
}

export function runtimesShareDaemon(first: RuntimeIdentity, second: RuntimeIdentity): boolean {
  const secondAliases = new Set(runtimeDaemonAliases(second));
  return runtimeDaemonAliases(first).some((alias) => secondAliases.has(alias));
}
