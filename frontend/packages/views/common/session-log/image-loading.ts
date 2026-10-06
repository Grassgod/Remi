/** Reserve unsized images at SSR, and keep the hidden stream buffer inert. */
export function deferStreamedImages(html: string | null | undefined): string | null | undefined {
  if (html == null) return html;
  return html.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
    const attributes = new Map<string, string>();
    const opening = /^<img\b/i.exec(tag)![0];
    for (const attribute of tag.slice(opening.length).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes.set(attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    const positiveDimension = (name: string) => /^[1-9]\d*$/.test(attributes.get(name) ?? "");
    const additions = [
      attributes.has("loading") ? "" : ' loading="lazy"',
      (positiveDimension("width") && positiveDimension("height")) || attributes.has("data-entry-image-frame")
        ? "" : ' data-entry-image-frame=""',
    ].join("");
    return opening + additions + tag.slice(opening.length);
  });
}
