// `[[slug]]` cross-links between wiki pages. Agents are told to write them
// when a page references another page (see the project `_schema` doc), so the
// syntax arrives from the model, not from a structured editor — parsing stays
// forgiving: any run of characters that isn't a bracket or a newline counts as
// a slug, and whitespace around it is trimmed.
//
// Code is exempt. A wiki page written by an agent is full of shell snippets,
// and bash's `[[ … ]]` test syntax is indistinguishable from a link once the
// fences are gone. One scanner alternates a code branch — fenced ``` blocks
// first, then inline `…` spans — ahead of the link branch, so whatever a code
// region covers is consumed before the link branch can see it. Both exported
// functions drive this same regex, so what gets linked and what gets rewritten
// can never disagree.
//
// Group 1 = a code region (passed through verbatim), group 2 = a link's slug.
const WIKI_SCAN_RE = /(```[\s\S]*?```|`[^`\n]*`)|\[\[([^[\]\n]+)\]\]/g;

/** Slugs referenced by `body`, de-duplicated, in the order they appear. */
export function extractWikiLinkSlugs(body: string): string[] {
  const slugs: string[] = [];
  for (const match of body.matchAll(WIKI_SCAN_RE)) {
    if (match[1] !== undefined) continue;
    const slug = match[2]?.trim();
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  }
  return slugs;
}

/**
 * Rewrite `[[slug]]` markers before the markdown renderer sees them.
 *
 * The reader gets the target page's title (falling back to the raw slug when
 * no such page exists) as an inline code span, so the wiki syntax never leaks
 * into the prose. Jumping to the target is handled by the chip row next to the
 * body — the shared markdown renderer resolves `mention://` links against a
 * fixed set of entity types and wiki pages have no route of their own, so an
 * inline anchor has nothing to point at.
 */
export function replaceWikiLinkMarkers(
  body: string,
  titleOf: (slug: string) => string | null,
): string {
  return body.replace(
    WIKI_SCAN_RE,
    (_match, code: string | undefined, rawSlug: string | undefined) => {
      if (code !== undefined) return code;
      const slug = (rawSlug ?? "").trim();
      return `\`${titleOf(slug) ?? slug}\``;
    },
  );
}
