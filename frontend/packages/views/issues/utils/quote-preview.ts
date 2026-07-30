import { stripMentionMarkdown } from "./strip-mention-markdown";

/**
 * How much of a quoted comment a reply reference shows. Long enough to
 * recognise which message is being answered, short enough to stay on one line
 * next to the author name.
 */
const DEFAULT_MAX_CHARS = 40;

/**
 * Collapse a markdown comment body into a single-line plain-text quote.
 *
 * A quote line is read, not rendered: raw markdown in it (`[@名字](mention://…)`,
 * backticks, `**`) is noise that costs characters the 40-char budget cannot
 * spare. So every marker is dropped and only the text survives:
 *
 * - mentions → their label (`[@名字](mention://member/id)` → `@名字`)
 * - links → their text, images → nothing
 * - `code`, **bold**, _italic_, ~~strike~~ → markers removed
 * - heading / bullet / blockquote line markers → removed
 * - all whitespace (including newlines) collapsed to single spaces
 * - truncated to `maxChars` with a trailing ellipsis
 */
export function quotePreview(content: string, maxChars = DEFAULT_MAX_CHARS): string {
  const plain = stripMentionMarkdown(content)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/```[^\n]*/g, "")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/gm, "")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > maxChars ? `${plain.slice(0, maxChars)}…` : plain;
}
