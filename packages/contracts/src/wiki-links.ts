import { normalizeWikiPath } from "./wiki-path";

export interface WikiLinkToken {
  /** Inclusive offset in the original Markdown source. */
  start: number;
  /** Exclusive offset in the original Markdown source. */
  end: number;
  raw: string;
  /** Document reference. Null denotes a self-anchor such as [[#usage]]. */
  ref: string | null;
  /** Heading anchor without the leading #. */
  anchor: string | null;
  /** Optional display label after |. */
  label: string | null;
}

export interface RepositoryWikiRefDocument {
  id: string;
  path: string;
}

export interface ProjectWikiRefDocument extends RepositoryWikiRefDocument {
  slug: string;
}

export type RepositoryWikiRefResolution<T extends RepositoryWikiRefDocument = RepositoryWikiRefDocument> =
  | { status: "resolved"; ref: string | null; document: T }
  | { status: "missing"; ref: string | null }
  | { status: "ambiguous"; ref: string; candidates: T[] };

export type ProjectWikiRefResolution<T extends ProjectWikiRefDocument = ProjectWikiRefDocument> =
  | { status: "resolved"; ref: string | null; document: T }
  | { status: "missing"; ref: string | null }
  | { status: "ambiguous"; ref: string; candidates: T[] };

/**
 * Tokenize Wiki links outside fenced and inline code spans.
 *
 * Supported forms are [[ref]], [[ref#anchor]], [[#anchor]], and
 * [[ref#anchor|label]]. Invalid or empty markers remain ordinary text.
 */
export function tokenizeWikiLinks(markdown: string): WikiLinkToken[] {
  const source = String(markdown ?? "");
  const fencedRanges = findCodeBlockRanges(source);
  const tokens: WikiLinkToken[] = [];
  let fencedIndex = 0;
  let index = 0;

  while (index < source.length) {
    const fenced = fencedRanges[fencedIndex];
    if (fenced && index >= fenced.start) {
      index = fenced.end;
      fencedIndex += 1;
      continue;
    }

    if (source[index] === "`") {
      const tickCount = countRun(source, index, "`");
      const closing = findMatchingBacktickRun(source, index + tickCount, tickCount);
      if (closing >= 0) {
        index = closing + tickCount;
        continue;
      }
      index += tickCount;
      continue;
    }

    if (source[index] !== "[" || source[index + 1] !== "[" || isEscaped(source, index)) {
      index += 1;
      continue;
    }

    const closing = source.indexOf("]]", index + 2);
    if (closing < 0 || source.slice(index + 2, closing).includes("\n")) {
      index += 2;
      continue;
    }
    const parsed = parseWikiLink(source.slice(index + 2, closing));
    if (!parsed) {
      index = closing + 2;
      continue;
    }
    const end = closing + 2;
    tokens.push({
      start: index,
      end,
      raw: source.slice(index, end),
      ...parsed,
    });
    index = end;
  }
  return tokens;
}

/** Resolve a Repository Wiki ref without guessing when basename matches collide. */
export function resolveRepositoryWikiRef<T extends RepositoryWikiRefDocument>(
  ref: string | null,
  sourcePath: string,
  documents: readonly T[],
): RepositoryWikiRefResolution<T> {
  const candidates = documents
    .map((document) => ({ document, path: tryNormalizePath(document.path) }))
    .filter((entry): entry is { document: T; path: string } => entry.path !== null);
  const normalizedSourcePath = tryNormalizePath(sourcePath);

  if (ref === null) {
    const matches = normalizedSourcePath
      ? candidates.filter((entry) => entry.path === normalizedSourcePath).map((entry) => entry.document)
      : [];
    return uniqueResolution(null, matches);
  }

  const value = ref.trim();
  if (!value) return { status: "missing", ref: value };

  const idMatches = documents.filter((document) => document.id === value);
  if (idMatches.length) return uniqueResolution(value, idMatches);

  const explicitlyRelative = value.startsWith("./");
  const relativeRef = explicitlyRelative ? value.slice(2) : value;
  const normalizedRef = tryNormalizePath(relativeRef);
  if (!normalizedRef) return { status: "missing", ref: value };
  const hasDirectory = relativeRef.includes("/");
  const sourceDirectory = normalizedSourcePath?.includes("/")
    ? normalizedSourcePath.slice(0, normalizedSourcePath.lastIndexOf("/"))
    : "";
  const relativePath = sourceDirectory
    ? tryNormalizePath(`${sourceDirectory}/${relativeRef}`)
    : normalizedRef;

  // `./` is an explicit same-directory reference. Falling back to a root path
  // would silently retarget the link when both locations contain that path.
  if (explicitlyRelative) {
    const local = relativePath
      ? candidates.filter((entry) => entry.path === relativePath).map((entry) => entry.document)
      : [];
    return uniqueResolution(value, local);
  }

  // A ref containing a directory is an explicit repository-root path first.
  if (hasDirectory) {
    const exact = candidates.filter((entry) => entry.path === normalizedRef).map((entry) => entry.document);
    if (exact.length) return uniqueResolution(value, exact);
  }

  // Bare refs are local to their source directory. This keeps sibling links
  // stable when a complete section is moved as one unit.
  if (relativePath) {
    const local = candidates.filter((entry) => entry.path === relativePath).map((entry) => entry.document);
    if (local.length) return uniqueResolution(value, local);
  }

  if (!hasDirectory) {
    const exact = candidates.filter((entry) => entry.path === normalizedRef).map((entry) => entry.document);
    if (exact.length) return uniqueResolution(value, exact);

    const basename = normalizedRef.slice(normalizedRef.lastIndexOf("/") + 1);
    const basenameMatches = candidates
      .filter((entry) => entry.path.slice(entry.path.lastIndexOf("/") + 1) === basename)
      .map((entry) => entry.document)
      .sort(compareDocuments);
    if (basenameMatches.length) return uniqueResolution(value, basenameMatches);
  }

  return { status: "missing", ref: value };
}

/** Resolve a Project Wiki ref by its stable id/slug or exact document path. */
export function resolveProjectWikiRef<T extends ProjectWikiRefDocument>(
  ref: string | null,
  sourcePath: string,
  documents: readonly T[],
): ProjectWikiRefResolution<T> {
  const normalizedSourcePath = tryNormalizePath(sourcePath);
  if (ref === null) {
    const matches = normalizedSourcePath
      ? documents.filter((document) => tryNormalizePath(document.path) === normalizedSourcePath)
      : [];
    return uniqueProjectResolution(null, matches);
  }

  const value = ref.trim();
  if (!value) return { status: "missing", ref: value };
  const byId = documents.filter((document) => document.id === value);
  if (byId.length) return uniqueProjectResolution(value, byId);
  const bySlug = documents.filter((document) => document.slug === value);
  if (bySlug.length) return uniqueProjectResolution(value, bySlug);
  const path = tryNormalizePath(value.startsWith("./") ? value.slice(2) : value);
  if (!path) return { status: "missing", ref: value };
  return uniqueProjectResolution(
    value,
    documents.filter((document) => tryNormalizePath(document.path) === path),
  );
}

function parseWikiLink(content: string): Pick<WikiLinkToken, "ref" | "anchor" | "label"> | null {
  const pipe = content.indexOf("|");
  const target = (pipe >= 0 ? content.slice(0, pipe) : content).trim();
  const labelText = pipe >= 0 ? content.slice(pipe + 1).trim() : "";
  if (!target) return null;
  const hash = target.indexOf("#");
  const refText = (hash >= 0 ? target.slice(0, hash) : target).trim();
  const anchorText = hash >= 0 ? target.slice(hash + 1).trim() : "";
  if (!refText && !anchorText) return null;
  return {
    ref: refText || null,
    anchor: anchorText || null,
    label: labelText || null,
  };
}

function uniqueResolution<T extends RepositoryWikiRefDocument>(
  ref: string | null,
  matches: T[],
): RepositoryWikiRefResolution<T> {
  if (matches.length === 1) return { status: "resolved", ref, document: matches[0]! };
  if (matches.length > 1 && ref !== null) {
    return { status: "ambiguous", ref, candidates: [...matches].sort(compareDocuments) };
  }
  return { status: "missing", ref };
}

function uniqueProjectResolution<T extends ProjectWikiRefDocument>(
  ref: string | null,
  matches: T[],
): ProjectWikiRefResolution<T> {
  if (matches.length === 1) return { status: "resolved", ref, document: matches[0]! };
  if (matches.length > 1 && ref !== null) {
    return { status: "ambiguous", ref, candidates: [...matches].sort(compareDocuments) };
  }
  return { status: "missing", ref };
}

function compareDocuments(left: RepositoryWikiRefDocument, right: RepositoryWikiRefDocument): number {
  return left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
}

function tryNormalizePath(value: unknown): string | null {
  try {
    return normalizeWikiPath(value);
  } catch {
    return null;
  }
}

function findFencedCodeRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let active: { start: number; marker: "`" | "~"; length: number } | null = null;
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (!active) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (opening) {
        const run = opening[1]!;
        active = { start: lineStart, marker: run[0] as "`" | "~", length: run.length };
      }
    } else {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1]![0] === active.marker && closing[1]!.length >= active.length) {
        ranges.push({ start: active.start, end: newline < 0 ? lineEnd : lineEnd + 1 });
        active = null;
      }
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  if (active) ranges.push({ start: active.start, end: source.length });
  return ranges;
}

function findCodeBlockRanges(source: string): Array<{ start: number; end: number }> {
  const ranges = [
    ...findFencedCodeRanges(source),
    ...findIndentedCodeRanges(source),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function findIndentedCodeRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line.startsWith("    ") || line.startsWith("\t")) {
      ranges.push({ start: lineStart, end: newline < 0 ? lineEnd : lineEnd + 1 });
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return ranges;
}

function findMatchingBacktickRun(source: string, from: number, length: number): number {
  let index = from;
  while (index < source.length) {
    const next = source.indexOf("`", index);
    if (next < 0) return -1;
    const run = countRun(source, next, "`");
    if (run === length) return next;
    index = next + run;
  }
  return -1;
}

function countRun(source: string, start: number, character: string): number {
  let end = start;
  while (source[end] === character) end += 1;
  return end - start;
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}
