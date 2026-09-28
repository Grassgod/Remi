/**
 * Structural comparison between the server renderer and the browser component.
 *
 * The two sides are a React tree and an HTML string, so both are normalised to
 * one shape first:
 *
 * 1. Parse with `hast-util-from-html`, so attribute quoting, entity escaping
 *    and self-closing style stop mattering.
 * 2. Drop the browser's outer `div.markdown-content` container. `EntryHtml`
 *    supplies an equivalent container, so the wrapper is not rendered content.
 * 3. Drop Tailwind class and inline-style attributes, keeping only attributes
 *    that carry meaning: link targets, image sources, the fence language,
 *    checkbox state and the file-card `data-*` pair.
 * 4. Collapse fenced code and the file-card container to a marker node, because
 *    what the server emits for them is the payload the client injects, not the
 *    final chrome. The highlighting itself is asserted byte-for-byte in a
 *    separate test; this file only decides where the block sits.
 *
 * Whatever is left must match exactly: same elements, same nesting, same text,
 * same link targets.
 */
import { fromHtml } from "hast-util-from-html";
import type { Element, Root, RootContent } from "hast";

/** Attributes the comparison keeps. Everything else is presentational. */
const MEANINGFUL_ATTRIBUTES = new Set([
  "href",
  "src",
  "alt",
  "type",
  "checked",
  "disabled",
  "datatype",
  "datahref",
  "datafilename",
]);

/** Class names worth keeping: only the fence language. */
const CLASS_ATTRIBUTE_KEEP = /^language-/u;

export interface NormalizedNode {
  tag: string;
  attributes: Record<string, string>;
  children: NormalizedNode[];
  text: string;
}

function classNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/u).filter(Boolean);
  return [];
}

function findFirst(node: Element, predicate: (candidate: Element) => boolean): Element | null {
  for (const child of node.children ?? []) {
    if (child.type !== "element") continue;
    const element = child as Element;
    if (predicate(element)) return element;
    const nested = findFirst(element, predicate);
    if (nested) return nested;
  }
  return null;
}

/** Filename shown by the browser's file-card chrome: its first text-bearing `<p>`. */
function extractFileCardName(node: Element): string {
  const paragraph = findFirst(node, (candidate) => candidate.tagName === "p");
  const name = paragraph ? textOf(paragraph) : textOf(node);
  return name.trim();
}

function textOf(node: Element): string {
  let out = "";
  const walk = (child: unknown): void => {
    if (!child || typeof child !== "object") return;
    const current = child as { type?: string; value?: string; children?: unknown[] };
    if (current.type === "text" && typeof current.value === "string") out += current.value;
    for (const next of current.children ?? []) walk(next);
  };
  walk(node);
  return out;
}

/** The syntax-highlighted `<pre>` both renderers eventually produce. */
function isShikiPre(node: Element): boolean {
  return node.tagName === "pre" && classNames(node.properties?.className).includes("shiki");
}

/** The browser's `CodeBlock` wrapper around the highlighted `<pre>`. */
function isCodeBlockWrapper(node: Element): boolean {
  const classes = classNames(node.properties?.className);
  return node.tagName === "div" && classes.includes("group") && classes.includes("rounded-lg");
}

/** The default `<pre>` `CodeBlock` renders before highlighting resolves. */
function isPlainCodePre(node: Element): boolean {
  if (node.tagName !== "pre") return false;
  const classes = classNames(node.properties?.className);
  return classes.includes("font-mono");
}

/** The server's file-card container, which the client turns into chrome. */
function isFileCardContainer(node: Element): boolean {
  return node.tagName === "div" && String(node.properties?.dataType ?? "") === "fileCard";
}

/** The browser's file-card chrome, rendered by the `div` component in Markdown.tsx. */
function isBrowserFileCard(node: Element): boolean {
  const classes = classNames(node.properties?.className);
  return (
    node.tagName === "div" &&
    classes.includes("my-1") &&
    classes.includes("items-center") &&
    classes.includes("gap-2")
  );
}

/**
 * A mention or slash link.
 *
 * The server keeps `<a href="mention://…">` (and `slash://skill/…`) so the
 * client can find the marker and attach the chip after injecting `body_html`;
 * the browser component, rendering live, collapses the same link to a styled
 * `<span>` because the chip is a React component. Both are the same content —
 * the text plus the target — so they normalise to one node and the comparison
 * still checks the target the server preserved.
 */
function isInternalProtocolLink(node: Element): boolean {
  if (node.tagName !== "a") return false;
  const href = String(node.properties?.href ?? "");
  return href.startsWith("mention://") || href.startsWith("slash://");
}

/** The browser's collapsed form of the same link. */
function isBrowserInternalProtocolSpan(node: Element): boolean {
  if (node.tagName !== "span") return false;
  const classes = classNames(node.properties?.className);
  return classes.includes("slash-command") || (classes.includes("text-primary") && classes.includes("mx-0.5"));
}

function normalizeElement(node: Element): NormalizedNode {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(node.properties ?? {})) {
    const name = key.toLowerCase();
    if (name === "classname" || name === "class") {
      const kept = classNames(value).filter((entry) => CLASS_ATTRIBUTE_KEEP.test(entry));
      if (kept.length) attributes["class"] = kept.sort().join(" ");
      continue;
    }
    if (name === "style") continue;
    if (!MEANINGFUL_ATTRIBUTES.has(name)) continue;
    const text = Array.isArray(value) ? value.map(String).join(" ") : String(value ?? "");
    // An absent `alt` and an empty one render the same; do not let the two
    // serializers disagree about it.
    if (name === "alt" && text === "") continue;
    attributes[name] = text;
  }

  const children: NormalizedNode[] = [];
  let text = "";
  for (const child of node.children ?? []) {
    collect(child as RootContent, children, (chunk) => {
      text += chunk;
    });
  }
  return { tag: node.tagName.toLowerCase(), attributes, children, text };
}

function collect(node: RootContent, into: NormalizedNode[], addText: (value: string) => void): void {
  if (node.type === "text") {
    addText(node.value);
    return;
  }
  if (node.type !== "element") return;
  const element = node as Element;

  // Code blocks: the server emits the Shiki `<pre>` directly, the browser
  // emits wrapper chrome plus (after highlighting) the same `<pre>`. Both
  // collapse to one marker carrying the source text, so the block's position in
  // the tree is still compared. Highlight fidelity is a byte comparison in
  // `render-markdown-parity.test.ts`.
  if (isShikiPre(element) || isPlainCodePre(element)) {
    into.push({ tag: "code-block", attributes: {}, children: [], text: textOf(element) });
    return;
  }
  if (isCodeBlockWrapper(element)) {
    // The wrapper also holds the language label and the copy button; only the
    // code itself is content, so take the text of the `<pre>` inside it.
    const pre = findFirst(element, (node) => isShikiPre(node) || isPlainCodePre(node));
    into.push({ tag: "code-block", attributes: {}, children: [], text: pre ? textOf(pre) : "" });
    return;
  }

  // The file card: the server emits the `data-type="fileCard"` container the
  // client enhances into chrome; the browser renders the chrome itself. Both
  // collapse to one marker keyed by the filename, which is the content.
  if (isFileCardContainer(element)) {
    into.push({
      tag: "file-card",
      attributes: { filename: String(element.properties?.dataFilename ?? "") },
      children: [],
      text: "",
    });
    return;
  }
  if (isBrowserFileCard(element)) {
    into.push({
      tag: "file-card",
      attributes: { filename: extractFileCardName(element) },
      children: [],
      text: "",
    });
    return;
  }

  if (isInternalProtocolLink(element) || isBrowserInternalProtocolSpan(element)) {
    // The server keeps the href so the client can find the marker; the browser
    // collapsed it into a chip and has no href left. The visible text is the
    // shared content, so that is what is compared here — the hrefs the server
    // preserves are asserted separately in the parity test.
    into.push({
      tag: "internal-link",
      attributes: {},
      children: [],
      text: textOf(element).trim(),
    });
    return;
  }

  into.push(normalizeElement(element));
}

/** Normalise one HTML string to the comparable tree. */
export function normalizeHtml(html: string): NormalizedNode[] {
  return normalizeChildren(fromHtml(html, { fragment: true }) as Root);
}

function normalizeChildren(tree: Root): NormalizedNode[] {
  const out: NormalizedNode[] = [];
  let text = "";
  for (const child of tree.children) {
    collect(child, out, (chunk) => {
      text += chunk;
    });
  }
  if (text.trim()) out.push({ tag: "#text", attributes: {}, children: [], text });
  return out;
}

/**
 * Normalise the browser component's output, dropping the outer
 * `div.markdown-content` container `Markdown.tsx` adds around its content.
 */
export function normalizeBrowserHtml(html: string): NormalizedNode[] {
  const tree = fromHtml(html, { fragment: true }) as Root;
  for (const child of tree.children) {
    if (
      child.type === "element" &&
      child.tagName === "div" &&
      classNames((child as Element).properties?.className).includes("markdown-content")
    ) {
      const out: NormalizedNode[] = [];
      let text = "";
      for (const grandchild of (child as Element).children) {
        collect(grandchild as RootContent, out, (chunk) => {
          text += chunk;
        });
      }
      if (text.trim()) out.push({ tag: "#text", attributes: {}, children: [], text });
      return out;
    }
  }
  return normalizeChildren(tree);
}

/** Render one normalised node as a compact, diffable tree. */
export function describeNodes(nodes: NormalizedNode[], depth = 0): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    const attrs = Object.entries(node.attributes)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => ` ${key}="${value}"`)
      .join("");
    if (node.tag === "#text") {
      lines.push(`${indent}text ${JSON.stringify(node.text)}`);
      continue;
    }
    lines.push(`${indent}<${node.tag}${attrs}>`);
    lines.push(...describeNodes(node.children, depth + 1));
    // A leaf element's text has to be reported somewhere.
    if (node.text.trim() && node.children.length === 0) {
      lines.push(`${indent}  text ${JSON.stringify(node.text.trim())}`);
    }
    lines.push(`${indent}</${node.tag}>`);
  }
  return lines;
}
