import type { ScmChangeRequest } from "../types";

const CHANGE_PATH_MARKERS = new Set(["pull", "pulls", "merge_requests", "-"]);

/**
 * Repository display name for a change request. Prefers the synced binding
 * name; falls back to parsing the change request URL so change requests whose
 * repository binding was removed still get labeled in multi-repo issues.
 */
export function deriveChangeRequestRepositoryName(
  changeRequest: Pick<ScmChangeRequest, "repositoryName" | "url">,
): string | null {
  const name = changeRequest.repositoryName?.trim();
  if (name) return name;
  return repositoryNameFromUrl(changeRequest.url);
}

function repositoryNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  // Change request URLs look like /owner/repo/pull/4 (GitHub) or
  // /owner/repo(/-)/merge_requests/4 — the segment before the marker is the
  // repository name; shorter or unrecognized paths carry no reliable name.
  const markerIndex = segments.findIndex((segment) => CHANGE_PATH_MARKERS.has(segment));
  if (markerIndex < 2) return null;
  return segments[markerIndex - 1]?.replace(/\.git$/u, "") ?? null;
}
