import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export {
  tokenizeWikiLinks,
  resolveProjectWikiRef,
  resolveRepositoryWikiRef,
  type ProjectWikiRefDocument,
  type ProjectWikiRefResolution,
  type RepositoryWikiRefDocument,
  type RepositoryWikiRefResolution,
  type WikiLinkToken,
} from "@multiremi/contracts/wiki-links";

export type WikiBacklinksScope =
  | { kind: "project"; projectId: string }
  | { kind: "repository"; repositoryId: string };

export interface WikiBacklinkDocument {
  id: string;
  slug: string;
  path: string;
  title: string;
  body: string;
}

export const wikiBacklinkKeys = {
  detail: (workspaceId: string, scope: WikiBacklinksScope, ref: string) => [
    "wiki-backlinks",
    workspaceId,
    scope.kind,
    scope.kind === "project" ? scope.projectId : scope.repositoryId,
    ref,
  ] as const,
};

export function wikiBacklinksOptions(
  workspaceId: string,
  scope: WikiBacklinksScope,
  ref: string,
) {
  return queryOptions({
    queryKey: wikiBacklinkKeys.detail(workspaceId, scope, ref),
    queryFn: async (): Promise<WikiBacklinkDocument[]> => scope.kind === "project"
      ? await api.listProjectDocBacklinks(scope.projectId, ref)
      : await api.listRepositoryWikiBacklinks(workspaceId, scope.repositoryId, ref),
    enabled: Boolean(
      workspaceId
      && ref
      && (scope.kind === "project" ? scope.projectId : scope.repositoryId),
    ),
  });
}

/** Stable heading fragment shared by Wiki link generation and rendering. */
export function normalizeWikiHeadingAnchor(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}
