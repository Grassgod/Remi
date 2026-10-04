/**
 * Text preprocessors shared with the browser renderer.
 *
 * `frontend/packages/ui/markdown/Markdown.tsx` runs three prepasses over the
 * raw markdown before remark sees it: legacy mention shortcodes, bare URLs and
 * file paths, and file-card syntax. Rendering the same message on the server
 * therefore needs the same three transforms, or a mention that the browser
 * turns into a chip would stay a literal `[@ …]` in `body_html` and the two
 * renderers would disagree about the same input.
 *
 * The results are pinned against the frontend functions by
 * `tests/unit/multiremi/render-markdown-parity.test.ts`. The frontend copies
 * cannot be imported here — they live in `frontend/packages/ui`, which this
 * package may not depend on (see the workspace-alias allowlist in
 * `tests/arch/package-boundaries.test.ts`) — so this is a port with a parity
 * test rather than a shared module.
 *
 * Source of truth for each function:
 * - `frontend/packages/ui/markdown/mentions.ts`
 * - `frontend/packages/ui/markdown/linkify.ts`
 * - `frontend/packages/ui/markdown/file-cards.ts`
 */
import LinkifyIt from "linkify-it";

// ────────────────────────────── mentions ──────────────────────────────

/**
 * Convert legacy mention shortcodes `[@ id="UUID" label="LABEL"]` into the
 * markdown link form `[@LABEL](mention://member/UUID)`.
 */
export function preprocessMentionShortcodes(text: string): string {
  if (!text.includes("[@ ")) return text;
  return text.replace(/\[@\s+([^\]]*)\]/g, (match, attrString: string) => {
    const attrs: Record<string, string> = {};
    const re = /(\w+)="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrString)) !== null) {
      if (m[1] && m[2] !== undefined) attrs[m[1]] = m[2];
    }
    const { id, label } = attrs;
    if (!id || !label) return match;
    return `[@${label}](mention://member/${id})`;
  });
}

// ────────────────────────────── links ──────────────────────────────

const linkify = new LinkifyIt();

const FILE_PATH_REGEX =
  /(?:^|[\s([{<])((\/|~\/|\.\/)[\w\-./@]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|yaml|yml|py|go|rs|css|scss|less|html|htm|txt|log|sh|bash|zsh|swift|kt|java|c|cpp|h|hpp|rb|php|xml|toml|ini|cfg|conf|env|sql|graphql|vue|svelte|astro|prisma|dockerfile|makefile|gitignore))(?=[\s)\]}.,;:!?>]|$)/gi;

/** Full-width punctuation that terminates a URL; see the frontend copy. */
const CJK_URL_TERMINATOR_REGEX = /[！-／：-＠［-｀｛-～、。「-】]/;

interface DetectedLink {
  type: "url" | "email" | "file";
  text: string;
  url: string;
  start: number;
  end: number;
}

interface TextRange {
  start: number;
  end: number;
}

/** Fenced code, display/inline math and inline code — never linkified. */
function findCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];

  const fencedRegex = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  const displayMathRegex = /\$\$[\s\S]*?\$\$/g;
  while ((match = displayMathRegex.exec(text)) !== null) {
    const pos = match.index;
    if (ranges.some((r) => pos >= r.start && pos < r.end)) continue;
    ranges.push({ start: pos, end: pos + match[0].length });
  }

  const inlineMathRegex = /(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g;
  while ((match = inlineMathRegex.exec(text)) !== null) {
    const pos = match.index;
    if (ranges.some((r) => pos >= r.start && pos < r.end)) continue;
    ranges.push({ start: pos, end: pos + match[0].length });
  }

  const inlineRegex = /(?<!`)`(?!`)([^`\n]+)`(?!`)/g;
  while ((match = inlineRegex.exec(text)) !== null) {
    const pos = match.index;
    if (ranges.some((r) => pos >= r.start && pos < r.end)) continue;
    ranges.push({ start: pos, end: pos + match[0].length });
  }

  return ranges;
}

function isInsideRange(pos: number, ranges: TextRange[]): boolean {
  return ranges.some((r) => pos >= r.start && pos < r.end);
}

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function findMatchingBracket(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (isEscaped(text, i)) continue;
    const char = text[i];
    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findInlineLinkEnd(text: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    if (isEscaped(text, i)) continue;
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Spans of existing markdown links/images, so nothing nests inside them. */
function findMarkdownLinkRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[" || isEscaped(text, i)) continue;
    if (ranges.some((r) => i >= r.start && i < r.end)) continue;

    const labelEnd = findMatchingBracket(text, i);
    if (labelEnd === -1) continue;

    const start = i > 0 && text[i - 1] === "!" && !isEscaped(text, i - 1) ? i - 1 : i;
    const nextChar = text[labelEnd + 1];

    if (nextChar === "(") {
      const end = findInlineLinkEnd(text, labelEnd + 1);
      if (end !== -1) {
        ranges.push({ start, end });
        i = end - 1;
      }
      continue;
    }

    if (nextChar === "[") {
      const referenceEnd = findMatchingBracket(text, labelEnd + 1);
      if (referenceEnd !== -1) {
        ranges.push({ start, end: referenceEnd + 1 });
        i = referenceEnd;
      }
    }
  }
  return ranges;
}

function isAlreadyLinked(text: string, linkStart: number, linkEnd: number): boolean {
  const before = text.slice(Math.max(0, linkStart - 2), linkStart);
  if (before.endsWith("](")) return true;
  if (before.endsWith("][")) return true;
  const charBefore = text[linkStart - 1];
  const charAfter = text[linkEnd];
  return charBefore === "[" && charAfter === "]";
}

function rangesOverlap(a: TextRange, b: TextRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectLinkifyMatches(text: string, offset: number, out: DetectedLink[]): void {
  const matches = linkify.match(text);
  if (!matches) return;

  for (const match of matches) {
    const cjkIdx = match.text.search(CJK_URL_TERMINATOR_REGEX);
    if (cjkIdx === 0) continue;

    const truncate = cjkIdx > 0;
    const matchText = truncate ? match.text.slice(0, cjkIdx) : match.text;
    const schemePrefix = match.url.slice(0, match.url.length - match.text.length);
    const matchUrl = truncate ? schemePrefix + matchText : match.url;
    const matchEnd = truncate ? match.index + cjkIdx : match.lastIndex;

    out.push({
      type: match.schema === "mailto:" ? "email" : "url",
      text: matchText,
      url: matchUrl,
      start: match.index + offset,
      end: matchEnd + offset,
    });

    if (truncate) {
      const tailStart = matchEnd + 1;
      collectLinkifyMatches(text.slice(tailStart), offset + tailStart, out);
      return;
    }
  }
}

/** Detect URLs, emails and file paths, sorted by position. */
export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = [];
  collectLinkifyMatches(text, 0, links);

  FILE_PATH_REGEX.lastIndex = 0;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = FILE_PATH_REGEX.exec(text)) !== null) {
    const path = fileMatch[1];
    if (!path) continue;

    const pathOffset = fileMatch[0].indexOf(path);
    const start = fileMatch.index + pathOffset;
    const pathRange = { start, end: start + path.length };
    if (links.some((link) => rangesOverlap(pathRange, link))) continue;

    links.push({ type: "file", text: path, url: path, start, end: start + path.length });
  }

  return links.sort((a, b) => a.start - b.start);
}

/** Convert bare URLs and file paths into markdown links, skipping code spans. */
export function preprocessLinks(text: string): string {
  if (!linkify.pretest(text) && !/[~/.]\//.test(text)) return text;

  const codeRanges = findCodeRanges(text);
  const markdownLinkRanges = findMarkdownLinkRanges(text);
  const links = detectLinks(text);
  if (links.length === 0) return text;

  let result = "";
  let lastIndex = 0;

  for (const link of links) {
    if (isInsideRange(link.start, codeRanges)) continue;
    if (markdownLinkRanges.some((range) => rangesOverlap(link, range))) continue;
    if (isAlreadyLinked(text, link.start, link.end)) continue;

    result += text.slice(lastIndex, link.start);
    result += `[${link.text}](${link.url})`;
    lastIndex = link.end;
  }

  result += text.slice(lastIndex);
  return result;
}

// ────────────────────────────── file cards ──────────────────────────────

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?)$/i;

export const FILE_CARD_URL_PATTERN = /\/uploads\/[^)]*|https?:\/\/[^)]+/;

const NEW_FILE_CARD_RE = new RegExp(
  `^!file\\[((?:\\\\.|[^\\]])*)\\]\\((${FILE_CARD_URL_PATTERN.source})\\)$`,
);

const FILE_LINK_LINE = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function toFileCardHtml(filename: string, url: string): string {
  return `<div data-type="fileCard" data-href="${escapeAttr(url)}" data-filename="${escapeAttr(filename)}"></div>`;
}

export function isCdnUrl(url: string, cdnDomain: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === cdnDomain || u.hostname.endsWith(".amazonaws.com");
  } catch {
    return false;
  }
}

function isFileCardUrl(url: string, cdnDomain: string): boolean {
  try {
    return isCdnUrl(url, cdnDomain) && !IMAGE_EXTS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Turn `!file[…]()` and CDN file links into the `<div data-type="fileCard">` rows. */
export function preprocessFileCards(markdown: string, cdnDomain: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      const newMatch = trimmed.match(NEW_FILE_CARD_RE);
      if (newMatch) {
        const filename = newMatch[1]!.replace(/\\([[\]\\()])/g, "$1");
        return toFileCardHtml(filename, newMatch[2]!);
      }

      const match = trimmed.match(FILE_LINK_LINE);
      if (!match) return line;
      const filename = match[1]!;
      const url = match[2]!;
      if (!isFileCardUrl(url, cdnDomain)) return line;
      return toFileCardHtml(filename, url);
    })
    .join("\n");
}

/** The three frontend prepasses, in the order `Markdown.tsx` applies them. */
export function preprocessMarkdown(markdown: string, cdnDomain = ""): string {
  let result = preprocessMentionShortcodes(markdown);
  result = preprocessLinks(result);
  result = preprocessFileCards(result, cdnDomain);
  return result;
}
