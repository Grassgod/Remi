/**
 * Repository Wiki list/body transport shared by `remi wiki status|pull|push`
 * and `remi wiki lint`.
 *
 * `GET .../wiki` returns metadata only; bodies are an explicit bounded request
 * (`include_body=true&ids=`) so a list call never hydrates every page. See
 * docs/adr/0002-repository-wiki-list-without-bodies.md.
 */

import type { CliOptions } from "../options.js";
import { isRecord, multiremiApiRequest } from "../http.js";

/** Mirrors REPOSITORY_WIKI_BODY_BATCH_LIMIT on the server. */
export const REPOSITORY_WIKI_BODY_BATCH_LIMIT = 20;
/** Batches in flight per repository. */
const REPOSITORY_WIKI_BODY_BATCH_CONCURRENCY = 2;

export interface RepositoryWikiRemoteDoc {
  id: string;
  repositoryId: string;
  path: string;
  slug: string;
  title: string;
  version: number;
  sourceRevision: string | null;
  updatedAt: string;
  refs: Array<{ type: string; value: string }>;
  /**
   * Undefined means the response was metadata only. It must never be treated as
   * an empty page: an unreadable document has to fail loudly, not merge as "".
   */
  body: string | undefined;
}

export function repositoryWikiListPath(workspaceId: string, repositoryId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}/wiki`;
}

/** Metadata list. A server that predates the metadata contract answers with a
 *  superset (bodies included); that is tolerated and used as-is. */
export async function fetchRepositoryWikiMetadata(
  options: CliOptions,
  workspaceId: string,
  repositoryId: string,
): Promise<RepositoryWikiRemoteDoc[]> {
  const value = await multiremiApiRequest("GET", repositoryWikiListPath(workspaceId, repositoryId), undefined, options);
  if (!isRecord(value) || !Array.isArray(value.docs)) {
    throw new Error(`Repository Wiki response is invalid for ${repositoryId}`);
  }
  return value.docs.map((doc) => parseRepositoryWikiRemoteDoc(doc, repositoryId));
}

/**
 * Reads the requested bodies in batches of at most 20, at most 2 batches in
 * flight. Strict: every requested id must come back with a string body.
 */
export async function fetchRepositoryWikiBodies(
  options: CliOptions,
  workspaceId: string,
  repositoryId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const bodies = new Map<string, string>();
  if (unique.length === 0) return bodies;
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += REPOSITORY_WIKI_BODY_BATCH_LIMIT) {
    batches.push(unique.slice(index, index + REPOSITORY_WIKI_BODY_BATCH_LIMIT));
  }
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(REPOSITORY_WIKI_BODY_BATCH_CONCURRENCY, batches.length) },
    async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor++]!;
        const query = `?include_body=true&ids=${batch.map((id) => encodeURIComponent(id)).join(",")}`;
        const value = await multiremiApiRequest(
          "GET",
          `${repositoryWikiListPath(workspaceId, repositoryId)}${query}`,
          undefined,
          options,
        );
        if (!isRecord(value) || !Array.isArray(value.docs)) {
          throw new Error(`Repository Wiki body response is invalid for ${repositoryId}`);
        }
        const byId = new Map<string, unknown>();
        for (const doc of value.docs) {
          if (!isRecord(doc)) throw new Error("Repository Wiki body response contains an invalid document");
          const id = typeof doc.id === "string" ? doc.id : "";
          if (id) byId.set(id, doc);
        }
        for (const id of batch) {
          const doc = byId.get(id);
          if (!doc || typeof (doc as Record<string, unknown>).body !== "string") {
            throw new Error(`Repository Wiki body is missing for ${id}`);
          }
          bodies.set(id, (doc as Record<string, unknown>).body as string);
        }
      }
    },
  );
  const settled = await Promise.allSettled(workers);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return bodies;
}

function parseRepositoryWikiRemoteDoc(value: unknown, repositoryId: string): RepositoryWikiRemoteDoc {
  if (!isRecord(value)) throw new Error("Repository Wiki list contains an invalid document");
  const id = stringField(value, "id");
  const path = stringField(value, "path");
  const title = stringField(value, "title");
  if (!id || !path || !title) throw new Error("Repository Wiki document is missing id, path, or title");
  return {
    id,
    repositoryId,
    path,
    slug: stringField(value, "slug") || path.replace(/\.md$/i, ""),
    title,
    version: Math.max(1, Math.floor(Number(value.version) || 1)),
    sourceRevision: nullableStringField(value, "source_revision", "sourceRevision"),
    updatedAt: stringField(value, "updated_at", "updatedAt"),
    refs: Array.isArray(value.refs)
      ? value.refs.filter(isRecord).flatMap((ref) => {
        const type = typeof ref.type === "string" ? ref.type : "";
        const refValue = typeof ref.value === "string" ? ref.value : "";
        return type && refValue ? [{ type, value: refValue }] : [];
      })
      : [],
    body: typeof value.body === "string" ? value.body : undefined,
  };
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

function nullableStringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}
