import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const projectDocKeys = {
  /** PREFIX for invalidation — every project-doc query in the workspace. */
  all: (wsId: string) => ["project-docs", wsId] as const,
  /** PREFIX for invalidation — every doc query of one project. */
  project: (wsId: string, projectId: string) =>
    [...projectDocKeys.all(wsId), projectId] as const,
  /** FULL KEY for queryOptions — includes the kind filter. */
  list: (wsId: string, projectId: string, kind?: string) =>
    [...projectDocKeys.project(wsId, projectId), "list", kind ?? "all"] as const,
  /** FULL KEY for queryOptions — `ref` is a doc id or slug. */
  detail: (wsId: string, projectId: string, ref: string) =>
    [...projectDocKeys.project(wsId, projectId), "detail", ref] as const,
};

/** Both kinds in one request — the Wiki tab splits memory / wiki client-side. */
export function projectDocListOptions(
  wsId: string,
  projectId: string,
  kind?: string,
) {
  return queryOptions({
    queryKey: projectDocKeys.list(wsId, projectId, kind),
    queryFn: () => api.listProjectDocs(projectId, kind ? { kind } : undefined),
    select: (data) => data.docs,
  });
}

export function projectDocDetailOptions(
  wsId: string,
  projectId: string,
  ref: string,
) {
  return queryOptions({
    queryKey: projectDocKeys.detail(wsId, projectId, ref),
    queryFn: () => api.getProjectDoc(projectId, ref),
  });
}
