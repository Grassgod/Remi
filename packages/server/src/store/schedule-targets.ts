import type { MultiremiScheduleTargets, MultiremiScheduleTarget } from "@multiremi/contracts/types.js";
import type { StoreContext } from "./context.js";

export function normalizeScheduleTargets(value: unknown): MultiremiScheduleTargets | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("schedule_targets must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["projects", "repositories", "prompt"].includes(key))) {
    throw new Error("schedule_targets contains unsupported fields");
  }
  const selection = (value: unknown): { all: boolean; ids: string[] } => {
    if (value == null) return { all: false, ids: [] };
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("schedule_targets selection must be an object");
    const item = value as Record<string, unknown>;
    if (typeof item.all !== "boolean" || !Array.isArray(item.ids)
      || Object.keys(item).some((key) => !["all", "ids"].includes(key))
      || item.ids.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error("schedule_targets selection requires all and ids");
    }
    if (item.ids.length > 1000) throw new Error("schedule_targets supports at most 1000 selected IDs");
    if (item.all && item.ids.length) throw new Error("schedule_targets all cannot include explicit ids");
    return { all: item.all, ids: [...new Set((item.ids as string[]).map((id) => id.trim()))] };
  };
  const projects = selection(input.projects);
  const repositories = selection(input.repositories);
  if (!projects.all && !repositories.all && !projects.ids.length && !repositories.ids.length) {
    throw new Error("schedule_targets must select at least one target");
  }
  if (input.prompt != null && (typeof input.prompt !== "string" || input.prompt.length > 16000)) {
    throw new Error("schedule_targets prompt must be a string of at most 16000 characters");
  }
  return { projects, repositories, prompt: typeof input.prompt === "string" ? input.prompt.trim() || null : null };
}

export function availableScheduleTargets(ctx: StoreContext, workspaceId: string): MultiremiScheduleTarget[] {
  const projects: MultiremiScheduleTarget[] = ctx.projects().listProjects(workspaceId)
    .filter((project) => !project.archivedAt)
    .map((project) => ({ kind: "project", id: project.id, name: project.title }));
  const repositories: MultiremiScheduleTarget[] = (ctx.workspaces().getWorkspace(workspaceId)?.repos ?? []).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const repo = value as Record<string, unknown>;
    return typeof repo.id === "string" && typeof repo.name === "string"
      ? [{ kind: "repository" as const, id: repo.id, name: repo.name }]
      : [];
  });
  return [...projects, ...repositories].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
