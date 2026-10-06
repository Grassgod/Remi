/** Keep images inert while Next streams their hidden SSR buffer. */
export function deferStreamedImages(html: string | null | undefined): string | null | undefined {
  if (html == null) return html;
  return html.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    const attributes = tag.replace(/"[^"]*"|'[^']*'/g, "");
    if (/(?:^|\s)loading\s*=/i.test(attributes)) return tag;
    return tag.replace(/^<img\b/i, opening => `${opening} loading="lazy"`);
  });
}
