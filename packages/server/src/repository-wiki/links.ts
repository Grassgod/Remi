import type { MultiremiRepositoryWikiDoc } from "@multiremi/contracts/types.js";
import {
  resolveRepositoryWikiRef,
  tokenizeWikiLinks,
  type RepositoryWikiRefResolution,
  type WikiLinkToken,
} from "@multiremi/contracts/wiki-links";

export type RepositoryWikiGraphDoc = Pick<MultiremiRepositoryWikiDoc, "id" | "path" | "body">;

export interface RepositoryWikiLinkProblem {
  sourceId: string;
  sourcePath: string;
  token: WikiLinkToken;
  reason: "unresolved" | "ambiguous" | "retargeted";
  resolution: RepositoryWikiRefResolution<RepositoryWikiGraphDoc>;
  previousTarget: RepositoryWikiGraphDoc | null;
}

export class RepositoryWikiLinkValidationError extends Error {
  constructor(readonly problem: RepositoryWikiLinkProblem) {
    super(formatRepositoryWikiLinkProblem(problem));
  }
}

/** Return broken links introduced by a proposed graph while tolerating unchanged legacy debt. */
export function introducedRepositoryWikiLinkProblems(
  before: readonly RepositoryWikiGraphDoc[],
  after: readonly RepositoryWikiGraphDoc[],
): RepositoryWikiLinkProblem[] {
  const beforeStates = linkStatesByKey(before);
  const afterStates = linkStatesByKey(after);
  const introduced: RepositoryWikiLinkProblem[] = [];
  for (const [key, states] of afterStates) {
    const previousStates = beforeStates.get(key) ?? [];
    for (const [index, state] of states.entries()) {
      const previous = previousStates[index];
      if (state.resolution.status !== "resolved") {
        if (previous?.resolution.status !== "resolved" && previous) continue;
        introduced.push({
          sourceId: state.source.id,
          sourcePath: state.source.path,
          token: state.token,
          reason: state.resolution.status === "ambiguous" ? "ambiguous" : "unresolved",
          resolution: state.resolution,
          previousTarget: previous?.resolution.status === "resolved" ? previous.resolution.document : null,
        });
        continue;
      }
      if (previous?.resolution.status === "resolved"
        && previous.resolution.document.id !== state.resolution.document.id) {
        introduced.push({
          sourceId: state.source.id,
          sourcePath: state.source.path,
          token: state.token,
          reason: "retargeted",
          resolution: state.resolution,
          previousTarget: previous.resolution.document,
        });
      }
    }
  }
  return introduced;
}

export function assertNoIntroducedRepositoryWikiLinks(
  before: readonly RepositoryWikiGraphDoc[],
  after: readonly RepositoryWikiGraphDoc[],
): void {
  const problem = introducedRepositoryWikiLinkProblems(before, after)[0];
  if (problem) throw new RepositoryWikiLinkValidationError(problem);
}

export function repositoryWikiBacklinks<T extends RepositoryWikiGraphDoc>(
  target: RepositoryWikiGraphDoc,
  documents: readonly T[],
): T[] {
  return documents.filter((document) => document.id !== target.id && tokenizeWikiLinks(document.body).some((token) => {
    const resolution = resolveRepositoryWikiRef(token.ref, document.path, documents);
    return resolution.status === "resolved" && resolution.document.id === target.id;
  }));
}

export function defaultRepositoryWikiPath(title: unknown, id: string): string {
  const slug = String(title ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || id}.md`;
}

export function repositoryWikiGraphWithUpserts(
  documents: readonly RepositoryWikiGraphDoc[],
  upserts: readonly RepositoryWikiGraphDoc[],
): RepositoryWikiGraphDoc[] {
  const byId = new Map(documents.map((document) => [document.id, { ...document }]));
  for (const upsert of upserts) byId.set(upsert.id, { ...upsert });
  return [...byId.values()];
}

export function formatRepositoryWikiLinkProblem(problem: RepositoryWikiLinkProblem): string {
  const marker = problem.token.raw;
  if (problem.reason === "retargeted" && problem.resolution.status === "resolved" && problem.previousTarget) {
    return `repository wiki link ${marker} in ${problem.sourcePath} changed target from ${problem.previousTarget.path} to ${problem.resolution.document.path}`;
  }
  if (problem.resolution.status === "ambiguous") {
    const candidates = problem.resolution.candidates.map((candidate) => candidate.path).join(", ");
    return `ambiguous repository wiki link ${marker} in ${problem.sourcePath}; candidates: ${candidates}`;
  }
  return `unresolved repository wiki link ${marker} in ${problem.sourcePath}`;
}

interface RepositoryWikiLinkState {
  source: RepositoryWikiGraphDoc;
  token: WikiLinkToken;
  resolution: RepositoryWikiRefResolution<RepositoryWikiGraphDoc>;
}

function linkStatesByKey(documents: readonly RepositoryWikiGraphDoc[]): Map<string, RepositoryWikiLinkState[]> {
  const states = new Map<string, RepositoryWikiLinkState[]>();
  for (const document of documents) {
    for (const token of tokenizeWikiLinks(document.body)) {
      const resolution = resolveRepositoryWikiRef(token.ref, document.path, documents);
      const key = `${document.id}\u0000${token.ref ?? "#self"}\u0000${token.anchor ?? ""}`;
      const grouped = states.get(key) ?? [];
      grouped.push({ source: document, token, resolution });
      states.set(key, grouped);
    }
  }
  return states;
}
