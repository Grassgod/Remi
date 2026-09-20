import type { MultiremiRepositoryWikiDoc } from "@multiremi/contracts/types.js";
import {
  resolveRepositoryWikiRef,
  resolveRepositoryWikiToken,
  tokenizeRepositoryWikiLinks,
  type RepositoryWikiRefResolution,
  type WikiLinkToken,
} from "@multiremi/contracts/wiki-links";

export type RepositoryWikiGraphDoc = Pick<MultiremiRepositoryWikiDoc, "id" | "path" | "body"> & {
  /** Outgoing links are unknown; identity still participates in resolution. */
  bodyUnavailable?: boolean;
};

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

/**
 * Tokens that form the Repository Wiki link graph.
 *
 * Canonical `[[ref]]` links always participate. Markdown `.md` links
 * participate only when they resolve to exactly one existing page — a **hard
 * link**, which earns a backlink, gets rewritten on move/merge, and can block a
 * write it breaks. A Markdown link that resolves to no page (a source file
 * path, a removed page) or to several is a **soft reference**: it stays in the
 * body untouched and never fails the gate.
 */
function graphTokens(body: string): WikiLinkToken[] {
  return tokenizeRepositoryWikiLinks(body);
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
        // Markdown page links are soft references: a path that matches no page
        // is an ordinary Markdown link (source file path, external doc), so a
        // brand-new one is never a problem by itself. One that previously
        // resolved and no longer does is a regression and still blocks.
        if (state.token.syntax === "markdown" && !previous) continue;
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
  return documents.filter((document) => !document.bodyUnavailable && document.id !== target.id && graphTokens(document.body).some((token) => {
    const resolution = resolveRepositoryWikiToken(token, document.path, documents);
    return resolution.status === "resolved" && resolution.document.id === target.id;
  }));
}

export function defaultRepositoryWikiPath(title: unknown, id: string): string {
  const slug = String(title ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || id}.md`;
}

/**
 * Preserve each resolved target when a source/target moves, including relative refs.
 *
 * A resolvable Markdown `.md` link whose target identity would otherwise change
 * is rewritten into the canonical `[[...]]` form, so the next move carries it
 * without depending on a relative path that no longer points anywhere. Soft
 * Markdown references resolve to nothing and are left byte-identical.
 */
export function rewriteRepositoryWikiLinks(
  body: string,
  sourcePath: string,
  nextSourcePath: string,
  before: readonly RepositoryWikiGraphDoc[],
  after: readonly RepositoryWikiGraphDoc[],
  mergedIds: ReadonlyMap<string, string> = new Map(),
): string {
  let rewritten = body;
  for (const token of graphTokens(body).reverse()) {
    const old = resolveRepositoryWikiToken(token, sourcePath, before);
    if (old.status !== "resolved") continue;
    const targetId = mergedIds.get(old.document.id) ?? old.document.id;
    const current = resolveRepositoryWikiToken(token, nextSourcePath, after);
    if (current.status === "resolved" && current.document.id === targetId) continue;
    const target = after.find(doc => doc.id === targetId);
    if (!target) throw new Error(`repository wiki rewrite target not found: ${targetId}`);
    // Bare root paths can resolve to a same-named sibling first. Use stable ID
    // in that case, rather than silently retargeting an otherwise valid link.
    const byPath = resolveRepositoryWikiRef(target.path, nextSourcePath, after);
    const ref = byPath.status === "resolved" && byPath.document.id === target.id ? target.path : target.id;
    const replacement = `[[${ref}${token.anchor ? `#${token.anchor}` : ""}${token.label !== null ? `|${token.label}` : ""}]]`;
    rewritten = rewritten.slice(0, token.start) + replacement + rewritten.slice(token.end);
  }
  return rewritten;
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
    if (document.bodyUnavailable) continue;
    for (const token of graphTokens(document.body)) {
      const resolution = resolveRepositoryWikiToken(token, document.path, documents);
      const key = `${document.id}\u0000${token.ref ?? "#self"}\u0000${token.anchor ?? ""}`;
      const grouped = states.get(key) ?? [];
      grouped.push({ source: document, token, resolution });
      states.set(key, grouped);
    }
  }
  return states;
}
