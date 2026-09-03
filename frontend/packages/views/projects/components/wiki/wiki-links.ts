// `[[slug]]` cross-links between wiki pages. Agents are told to write them
// when a page references another page (see the project `_schema` doc), so the
// syntax arrives from the model, not from a structured editor.
//
// Code is exempt. A wiki page written by an agent is full of shell snippets,
// and bash's `[[ … ]]` test syntax is indistinguishable from a link once the
// fences are gone. The shared tokenizer consumes fenced and inline code before
// looking for Wiki markers, keeping these legacy memory cards aligned with all
// canonical Wiki readers.
//
import { normalizeWikiHeadingAnchor, tokenizeWikiLinks } from "@multiremi/core/knowledge";

/** Slugs referenced by `body`, de-duplicated, in the order they appear. */
export function extractWikiLinkSlugs(body: string): string[] {
  const slugs: string[] = [];
  for (const token of tokenizeWikiLinks(body)) {
    const slug = token.ref;
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

// A title is agent-written free text, and it lands inside a markdown link's
// `[…]`. An unescaped bracket would close the label early and spill link
// syntax into the prose; a trailing backslash would escape the closing one.
function escapeLinkText(title: string): string {
  return title.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/**
 * Rewrite `[[slug]]` markers before the markdown renderer sees them.
 *
 * A slug `resolve` answers for becomes an ordinary markdown link to that
 * page's route, so the reader clicks the target's title and the renderer's
 * own link handling does the navigating. A slug with no page behind it keeps
 * the older degradation — the raw slug as an inline code span — so the wiki
 * syntax never leaks into the prose and a dead link is never clickable.
 */
export function replaceWikiLinkMarkers(
  body: string,
  resolve: (slug: string) => { title: string; href: string } | null,
): string {
  const tokens = tokenizeWikiLinks(body);
  if (tokens.length === 0) return body;
  let cursor = 0;
  let rendered = "";
  for (const token of tokens) {
    rendered += body.slice(cursor, token.start);
    if (token.ref === null && token.anchor) {
      const anchor = normalizeWikiHeadingAnchor(token.anchor);
      rendered += `[${escapeLinkText(token.label || token.anchor)}](#${encodeURIComponent(anchor)})`;
    } else {
      const target = token.ref ? resolve(token.ref) : null;
      const anchor = token.anchor ? normalizeWikiHeadingAnchor(token.anchor) : "";
      rendered += target
        ? `[${escapeLinkText(token.label || target.title)}](${target.href}${anchor ? `#${encodeURIComponent(anchor)}` : ""})`
        : `\`${token.label || token.ref || token.anchor || token.raw}\``;
    }
    cursor = token.end;
  }
  return rendered + body.slice(cursor);
}
