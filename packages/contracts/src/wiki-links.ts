import { normalizeWikiPath } from "./wiki-path";

/**
 * Source syntax a token was read from.
 *
 * `bracket` is the canonical `[[ref]]` wiki syntax. `markdown` is an ordinary
 * Markdown inline link `[label](path.md)`; it only joins the Repository Wiki
 * link graph when it resolves to an existing page, and stays a plain
 * Markdown link otherwise (see resolveRepositoryWikiMarkdownRef).
 */
export type WikiLinkSyntax = "bracket" | "markdown";

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
  /** Absent means `bracket`, so existing canonical tokens keep their shape. */
  syntax?: WikiLinkSyntax;
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

/**
 * Tokenize Markdown inline links whose target is a `.md` path.
 *
 * Only same-repository page references are returned: images (`![alt](src)`),
 * fragment-only links (`[label](#section)`), external URLs (`https:`,
 * `mailto:`, protocol-relative), and non-`.md` targets such as source file
 * paths are left as ordinary text. Code spans are skipped exactly as in
 * {@link tokenizeWikiLinks}.
 */
export function tokenizeMarkdownWikiLinks(markdown: string): WikiLinkToken[] {
  const source = String(markdown ?? "");
  // A Markdown link requires an adjacent `](`; skip the scan when absent.
  if (!source.includes("](")) return [];
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
      index = closing >= 0 ? closing + tickCount : index + tickCount;
      continue;
    }

    const linked = readMarkdownWikiLink(source, index);
    if (!linked) {
      index += 1;
      continue;
    }
    tokens.push(linked);
    index = linked.end;
  }
  return tokens;
}

/**
 * Every link token that participates in the Repository Wiki link graph:
 * canonical `[[ref]]` links plus resolvable Markdown `.md` links.
 *
 * Tokens never overlap; a Markdown link nested inside a canonical link's body
 * is dropped in favour of the canonical token.
 */
export function tokenizeRepositoryWikiLinks(markdown: string): WikiLinkToken[] {
  const bracket = tokenizeWikiLinks(markdown);
  const markdownLinks = tokenizeMarkdownWikiLinks(markdown);
  if (!markdownLinks.length) return bracket;
  if (!bracket.length) return markdownLinks;
  const canonical = bracket.map((token) => [token.start, token.end] as const);
  return [
    ...bracket,
    ...markdownLinks.filter((token) => !canonical.some(([start, end]) => token.start < end && token.end > start)),
  ].sort((left, right) => left.start - right.start);
}

/**
 * Resolve a Markdown `.md` link the way a reader's browser would, then fall
 * back to a repository-root path.
 *
 * Markdown has no `[[...]]` syntax, so a page-relative target wins when both
 * interpretations exist; only when the relative reading finds nothing do we
 * accept an author's repository-root style path (the shape that produced the
 * dy-code-context breakage). Anything that resolves to no page — a source file
 * path, a removed page — returns `missing`, which callers treat as a **soft
 * reference**: never rewritten, and never a problem on its own when newly
 * introduced. A reference that used to resolve and no longer does is a
 * regression, and is still reported.
 */
export function resolveRepositoryWikiMarkdownRef<T extends RepositoryWikiRefDocument>(
  ref: string | null,
  sourcePath: string,
  documents: readonly T[],
): RepositoryWikiRefResolution<T> {
  if (ref === null) return { status: "missing", ref: null };
  const value = ref.trim();
  if (!value) return { status: "missing", ref: value };
  const relative = resolveRepositoryWikiRef(`./${value.replace(/^\.\/+/, "")}`, sourcePath, documents);
  if (relative.status !== "missing") return relative;
  const root = resolveRepositoryWikiRef(value, sourcePath, documents);
  return root.status === "missing" ? { status: "missing", ref: value } : root;
}

/** Resolve a token by its source syntax; the single dispatch point for both forms. */
export function resolveRepositoryWikiToken<T extends RepositoryWikiRefDocument>(
  token: Pick<WikiLinkToken, "ref" | "syntax">,
  sourcePath: string,
  documents: readonly T[],
): RepositoryWikiRefResolution<T> {
  return token.syntax === "markdown"
    ? resolveRepositoryWikiMarkdownRef(token.ref, sourcePath, documents)
    : resolveRepositoryWikiRef(token.ref, sourcePath, documents);
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

function readMarkdownWikiLink(source: string, index: number): WikiLinkToken | null {
  if (source[index] !== "[" || isEscaped(source, index)) return null;
  // `![alt](src)` is an attachment/image, not a page reference.
  if (index > 0 && source[index - 1] === "!") return null;
  const labelEnd = findClosingBracket(source, index);
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return null;
  const targetEnd = findClosingParen(source, labelEnd + 1);
  if (targetEnd < 0) return null;
  const target = parseMarkdownWikiTarget(source.slice(labelEnd + 2, targetEnd));
  if (!target) return null;
  return {
    start: index,
    end: targetEnd + 1,
    raw: source.slice(index, targetEnd + 1),
    ref: target.ref,
    anchor: target.anchor,
    label: source.slice(index + 1, labelEnd).trim() || null,
    syntax: "markdown",
  };
}

/** Offset of the `]` matching the `[` at `open`, or -1. Inline links never span lines. */
function findClosingBracket(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n") return -1;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Offset of the `)` matching the `(` at `open`, or -1. */
function findClosingParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n") return -1;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Parse a Markdown link target into a page reference.
 *
 * Returns null for anything that is not a same-repository `.md` page path —
 * external URLs, protocol-relative URLs, fragment-only anchors, absolute
 * site paths, source file paths, and targets carrying an optional title.
 */
function parseMarkdownWikiTarget(raw: string): Pick<WikiLinkToken, "ref" | "anchor"> | null {
  const text = raw.trim();
  if (!text) return null;
  const withoutTitle = text.replace(/\s+(?:"[^"]*"|'[^']*'|\([^()]*\))\s*$/, "").trim();
  if (!withoutTitle || isExternalMarkdownTarget(withoutTitle)) return null;
  if (withoutTitle.startsWith("/") || withoutTitle.startsWith("<")) return null;
  const hash = withoutTitle.indexOf("#");
  const path = (hash >= 0 ? withoutTitle.slice(0, hash) : withoutTitle).trim();
  const anchor = hash >= 0 ? withoutTitle.slice(hash + 1).trim() : "";
  // A bare `#section` stays inside the current document.
  if (!path) return null;
  if (/\s/.test(path)) return null;
  if (!path.toLowerCase().endsWith(".md")) return null;
  return { ref: path, anchor: anchor || null };
}

function isExternalMarkdownTarget(target: string): boolean {
  // Schemes (https:, mailto:, mention://, slash://) and protocol-relative URLs.
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
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
