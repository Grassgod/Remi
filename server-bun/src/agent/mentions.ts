/**
 * Mention parsing — port of Go util.ParseMentions. Markdown mention links have
 * the form `[@Label](mention://<type>/<id>)` (the `@` is optional so issue
 * cross-references `[MUL-1](mention://issue/<uuid>)` match too). Used to find
 * the agents/squads a comment addresses so they can be woken with a task.
 */

export type MentionType = "member" | "agent" | "squad" | "issue" | "all";

export interface Mention {
  type: MentionType;
  id: string;
}

// Mirrors Go's MentionRe. The label is non-greedy; the `](mention://` anchor is
// specific enough that labels containing `]` (e.g. "David[TF]") still match.
const MENTION_RE = /\[@?(?:.+?)\]\(mention:\/\/(member|agent|squad|issue|all)\/([0-9a-fA-F-]+|all)\)/g;

/** Parse all mentions in `content`, de-duplicated by (type, id), in order. */
export function parseMentions(content: string): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    const type = m[1] as MentionType;
    const id = m[2]!;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
  }
  return out;
}
