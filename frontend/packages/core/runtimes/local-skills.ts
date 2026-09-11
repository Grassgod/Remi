import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type {
  CreateRuntimeLocalSkillImportRequest,
  RuntimeLocalSkillImportResult,
  RuntimeLocalSkillsResult,
} from "../types";

export const runtimeLocalSkillsKeys = {
  all: () => ["runtimes", "local-skills"] as const,
  forRuntime: (runtimeId: string) =>
    [...runtimeLocalSkillsKeys.all(), runtimeId] as const,
  forRoot: (runtimeId: string, root?: string) =>
    [...runtimeLocalSkillsKeys.forRuntime(runtimeId), root ?? null] as const,
};

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;
// Import timeout is longer than discovery because old daemons (pre-batch) pop
// only one import per heartbeat cycle (~15s). With 10 queued imports the 10th
// can wait up to 150s in pending before being claimed, plus up to 60s for
// the daemon to actually run the import.
//
// Timeout invariant: IMPORT_POLL_TIMEOUT_MS must exceed
// runtimeLocalSkillPendingTimeout + runtimeLocalSkillRunningTimeout
// (server/internal/handler/runtime_local_skills.go).
// See also IMPORT_CONCURRENCY in packages/views/.../runtime-local-skill-import-panel.tsx
// and maxLocalSkillImportBatch in server/internal/handler/daemon.go.
const IMPORT_POLL_TIMEOUT_MS = 4 * 60_000; // 4 minutes

function isAbsoluteRuntimeSkillDirectory(directory: string): boolean {
  // The directory belongs to the runtime machine, which may use Unix, drive, or UNC paths.
  return /^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(directory);
}

export async function resolveRuntimeLocalSkills(
  runtimeId: string,
  root?: string,
): Promise<RuntimeLocalSkillsResult> {
  const initial = await api.initiateListLocalSkills(runtimeId, { root });
  const start = Date.now();
  let current = initial;

  while (current.status === "pending" || current.status === "running") {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error("runtime local skill discovery timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await api.getListLocalSkillsResult(runtimeId, initial.id);
  }

  if (current.status === "failed" || current.status === "timeout") {
    throw new Error(current.error || "runtime local skill discovery failed");
  }
  if (root !== undefined && (!current.root || !isAbsoluteRuntimeSkillDirectory(current.root))) {
    // Older servers ignore the requested directory and return the default inventory.
    throw new Error("Custom skill directory scanning requires an updated Remi server and runtime.");
  }

  return {
    scan_request_id: current.id,
    root: current.root,
    warnings: current.warnings,
    skills: current.skills ?? [],
    supported: current.supported,
  };
}

export async function resolveRuntimeLocalSkillImport(
  runtimeId: string,
  payload: CreateRuntimeLocalSkillImportRequest,
): Promise<RuntimeLocalSkillImportResult> {
  const initial = await api.initiateImportLocalSkill(runtimeId, payload);
  const start = Date.now();
  let current = initial;

  while (current.status === "pending" || current.status === "running") {
    if (Date.now() - start > IMPORT_POLL_TIMEOUT_MS) {
      throw new Error("runtime local skill import timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await api.getImportLocalSkillResult(runtimeId, initial.id);
  }

  if (current.status === "failed" || current.status === "timeout") {
    throw new Error(current.error || "runtime local skill import failed");
  }
  if (!current.skill) {
    throw new Error("runtime local skill import did not return a skill");
  }

  return { skill: current.skill };
}

export function runtimeLocalSkillsOptions(
  runtimeId: string | null | undefined,
  root?: string,
  scanKey?: string,
) {
  const rootKey = runtimeId
    ? runtimeLocalSkillsKeys.forRoot(runtimeId, root)
    : runtimeLocalSkillsKeys.all();
  return queryOptions({
    queryKey: [...rootKey, ...(scanKey ? [scanKey] : [])],
    queryFn: () => resolveRuntimeLocalSkills(runtimeId as string, root),
    enabled: Boolean(runtimeId),
    staleTime: Infinity,
    retry: false,
  });
}
