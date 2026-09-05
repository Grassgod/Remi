const FEISHU_IMAGE_KEY_RE = /^img_[A-Za-z0-9_-]+$/u;
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)/gu;
const ATTACHMENT_PATH_RE = /^\/api\/attachments\/(att_[A-Za-z0-9_-]+)\/content\/?$/u;

export type MarkdownImageSource =
  | { kind: "feishu"; src: string; imageKey: string; fallbackUrl: null; name: string }
  | { kind: "attachment"; src: string; attachmentId: string; fallbackUrl: string | null; name: string }
  | { kind: "local"; src: string; filePath: string; fallbackUrl: null; name: string }
  | { kind: "http"; src: string; url: string; fallbackUrl: string; name: string }
  | { kind: "unsupported"; src: string; fallbackUrl: null; name: string };

export interface MarkdownImageMatch {
  raw: string;
  alt: string;
  source: MarkdownImageSource;
  start: number;
  end: number;
}

export type MarkdownImageResolver = (source: MarkdownImageSource) => Promise<string | null | undefined>;

export function isFeishuImageKey(value: string): boolean {
  return FEISHU_IMAGE_KEY_RE.test(value.trim());
}

export function classifyMarkdownImageSource(
  value: string,
  options: { publicUrl?: string | null } = {},
): MarkdownImageSource {
  const src = value.trim();
  const markerKey = src.startsWith("feishu-image:") ? src.slice("feishu-image:".length) : null;
  if (markerKey && isFeishuImageKey(markerKey)) {
    return { kind: "feishu", src, imageKey: markerKey, fallbackUrl: null, name: markerKey };
  }
  if (isFeishuImageKey(src)) {
    return { kind: "feishu", src, imageKey: src, fallbackUrl: null, name: src };
  }

  const parsedHttp = parseHttpUrl(src);
  const attachmentPath = parsedHttp?.pathname ?? stripQueryAndHash(src);
  const attachmentMatch = attachmentPath.match(ATTACHMENT_PATH_RE);
  if (attachmentMatch) {
    return {
      kind: "attachment",
      src,
      attachmentId: attachmentMatch[1]!,
      fallbackUrl: parsedHttp?.toString() ?? absoluteUrl(src, options.publicUrl),
      name: attachmentMatch[1]!,
    };
  }

  if (src.startsWith("file://")) {
    const filePath = fileUrlPath(src);
    if (filePath) {
      return { kind: "local", src, filePath, fallbackUrl: null, name: sourceBasename(filePath) };
    }
  }
  if (isAbsoluteFilePath(src)) {
    return { kind: "local", src, filePath: src, fallbackUrl: null, name: sourceBasename(src) };
  }
  if (parsedHttp) {
    return { kind: "http", src, url: parsedHttp.toString(), fallbackUrl: parsedHttp.toString(), name: sourceBasename(parsedHttp.pathname) };
  }
  return { kind: "unsupported", src, fallbackUrl: null, name: sourceBasename(src) };
}

export function findMarkdownImages(
  text: string,
  options: { publicUrl?: string | null } = {},
): MarkdownImageMatch[] {
  const matches: MarkdownImageMatch[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const start = match.index ?? 0;
    if (isEscaped(text, start)) continue;
    const src = match[2] ?? match[3] ?? "";
    matches.push({
      raw: match[0],
      alt: match[1] ?? "",
      source: classifyMarkdownImageSource(src, options),
      start,
      end: start + match[0].length,
    });
  }
  return matches;
}

export async function rewriteMarkdownImages(
  text: string,
  resolve: MarkdownImageResolver,
  options: { publicUrl?: string | null } = {},
): Promise<string> {
  const matches = findMarkdownImages(text, options);
  if (matches.length === 0) return text;
  const resolved = new Map<string, Promise<string | null>>();
  const replacements = await Promise.all(matches.map(async (match) => {
    if (match.source.kind === "feishu") return match.raw;
    let pending = resolved.get(match.source.src);
    if (!pending) {
      pending = Promise.resolve(resolve(match.source))
        .then((value) => value?.trim() ?? null)
        .catch(() => null);
      resolved.set(match.source.src, pending);
    }
    const imageKey = await pending;
    return imageKey && isFeishuImageKey(imageKey)
      ? `![${match.alt}](feishu-image:${imageKey})`
      : fallbackMarkdownImage(match.alt, match.source);
  }));
  return replaceMarkdownImageMatches(text, matches, replacements);
}

export function degradeMarkdownImages(
  text: string,
  options: { publicUrl?: string | null } = {},
): string {
  const matches = findMarkdownImages(text, options);
  if (matches.length === 0) return text;
  return replaceMarkdownImageMatches(
    text,
    matches,
    matches.map((match) => match.source.kind === "feishu"
      ? match.raw
      : fallbackMarkdownImage(match.alt, match.source)),
  );
}

export function fallbackMarkdownImage(alt: string, source: MarkdownImageSource): string {
  const name = escapeMarkdownLabel(alt.trim() || source.name || "image");
  const label = `图片: ${name}`;
  return source.fallbackUrl
    ? `[${label}](${escapeMarkdownDestination(source.fallbackUrl)})`
    : `[${label}]`;
}

function replaceMarkdownImageMatches(
  text: string,
  matches: readonly MarkdownImageMatch[],
  replacements: readonly string[],
): string {
  let output = "";
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    output += text.slice(cursor, match.start) + replacements[index]!;
    cursor = match.end;
  }
  return output + text.slice(cursor);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function absoluteUrl(value: string, publicUrl: string | null | undefined): string | null {
  if (!publicUrl?.trim()) return null;
  try {
    const base = new URL(publicUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function fileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/u, 1)[0] ?? value;
}

function sourceBasename(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || "image";
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\\[\]]/gu, "\\$&");
}

function escapeMarkdownDestination(value: string): string {
  return value.replace(/\\/gu, "%5C").replace(/\(/gu, "%28").replace(/\)/gu, "%29");
}
