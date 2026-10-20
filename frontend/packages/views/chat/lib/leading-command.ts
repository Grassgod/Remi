/**
 * A user message that starts with a command (`/compact`, `/deploy-prod now`)
 * shows the command as a chip, the way the composer showed it (ADR 0025). The
 * message text itself is unchanged; only what the bubble renders is.
 *
 * Only a plain command word counts: letters, digits and `. _ : -` after the
 * slash, then whitespace or the end. A path such as `/tmp/x` or a slash
 * followed by a space is left as text.
 */
const LEADING_COMMAND = /^(\s*)\/([A-Za-z0-9][\w.:-]*)(?=\s|$)/;

export function leadingCommandChipMarkdown(markdown: string): string {
  const match = LEADING_COMMAND.exec(markdown);
  if (!match) return markdown;
  const [whole, space = "", name = ""] = match;
  return `${space}[/${name}](slash://command/${encodeURIComponent(name)})${markdown.slice(whole.length)}`;
}
