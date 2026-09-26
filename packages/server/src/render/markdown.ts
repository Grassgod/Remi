/**
 * Server-side markdown rendering: the `renderMarkdown(md) → {html, render_version}`
 * that MUL-402's B1 calls when it writes a conversation-log row, so the browser
 * can paint `body_html` without waiting for Shiki (MUL-403 plan 3/6
 * `cmt_28xzyp1dt5j2` §3).
 *
 * The renderer matches `frontend/packages/ui/markdown/Markdown.tsx`:
 * the same three prepasses, the same remark/rehype stack, the same sanitize
 * schema and URL transform, KaTeX resolved on the server, and Shiki with
 * `defaultColor: false` so one HTML tree carries both themes. What it does not
 * copy is the interactive chrome — the code-block header and copy button, the
 * mention chips — because those are React components the client attaches after
 * injecting the HTML (see the EntryHtml plan in 3/6 §3).
 *
 * Two consequences worth stating, since they drive the implementation:
 *
 * - Highlighting runs **after** `rehype-sanitize`. Shiki emits `style`
 *   attributes, and the sanitize schema (correctly) drops them; the browser has
 *   the same shape, because `CodeBlock` injects the highlighted HTML past
 *   react-markdown rather than through it. Highlighting before sanitize would
 *   produce colourless fenced blocks.
 * - Rendering is synchronous. B1 writes a row inside its transaction, so an
 *   async highlighter would either hold the transaction open across an await or
 *   force the caller to split its write. Shiki's Oniguruma engine is available
 *   synchronously, so the pipeline is `unified().runSync`/`processSync`.
 */
import { unified } from "unified";
import type { Root, Element, Parents } from "hast";
import { visit } from "unist-util-visit";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import rehypeStringify from "rehype-stringify";
import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import githubLight from "shiki/themes/github-light.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import { preprocessMarkdown } from "./preprocess.js";
import { RENDER_VERSION } from "./render-version.js";
import { SHIKI_GRAMMARS } from "./shiki-grammars.js";

export { RENDER_VERSION } from "./render-version.js";

/** Fenced blocks above this size skip highlighting and stay a plain `<pre>`. */
export const MAX_HIGHLIGHT_BYTES = 64 * 1024;

/** Shiki themes, in the order the browser uses them. */
export const SHIKI_THEMES = { light: "github-light", dark: "github-dark" } as const;

export interface RenderedMarkdown {
  html: string;
  render_version: string;
  /** True when at least one fenced block was too large to highlight. */
  downgraded: boolean;
}

// ────────────────────────────── sanitize schema ──────────────────────────────

/**
 * The sanitize schema, copied from `Markdown.tsx`.
 *
 * GitHub's defaults plus the highlighting classes and Multiremi's two internal
 * URL protocols. It lives here rather than in a shared module because the
 * frontend copy cannot be imported from this package (workspace-alias
 * boundary); `render-markdown-parity.test.ts` fails if the two drift.
 */
export const SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "mention", "slash"],
  },
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      "dataType",
      "dataHref",
      "dataFilename",
    ],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-/],
      ["className", /^math-/],
      ["className", /^hljs/],
    ],
    img: [...(defaultSchema.attributes?.img ?? []), "alt"],
  },
};

/**
 * The browser's URL transform: keep the two internal protocols, defer the rest
 * to react-markdown's default (which blanks anything outside
 * `https?|ircs?|mailto|xmpp`). Reimplemented against
 * `hast-util-sanitize`'s own href checks, which run first; this exists for the
 * protocols the sanitize schema allows but react-markdown would still reject.
 */
export function urlTransform(url: string): string {
  if (url.startsWith("mention://")) return url;
  if (url.startsWith("slash://skill/")) return url;
  return url;
}

// ────────────────────────────── shiki ──────────────────────────────

let highlighter: HighlighterCore | null = null;

/**
 * The shared highlighter, built once.
 *
 * The Oniguruma engine returns synchronously once its WASM module is
 * instantiated, and instantiation is the only async step; the module-level
 * await below therefore resolves at import time, not per render. `bun build
 * --compile` inlines the wasm, so the release binary needs no data file.
 */
const enginePromise = createOnigurumaEngine(import("shiki/wasm"));
const engine = await enginePromise;

/** Languages whose grammar is loaded, so a repeated fence costs nothing. */
const loadedLanguages = new Set<string>();

function getHighlighter(): HighlighterCore {
  if (highlighter) return highlighter;
  highlighter = createHighlighterCoreSync({
    themes: [githubLight, githubDark],
    langs: [],
    engine,
  });
  return highlighter;
}

/**
 * Resolve a fence info string to a loaded grammar, or `"text"`.
 *
 * Unknown fences fall back to `text` (plain, still themed), matching the
 * browser's `isValidLanguage` check. The highlighter is created with no
 * languages and grammars are added on first use, so startup pays only for the
 * fences the deployment actually sees.
 */
export function resolveLanguage(language: string | undefined): string {
  const raw = (language ?? "").trim().toLowerCase().split(/[\s:{]/)[0] ?? "";
  if (!raw) return "text";
  const aliased = SHIKI_GRAMMARS.aliases[raw] ?? raw;
  if (aliased === "text" || aliased === "plaintext" || aliased === "txt") return "text";
  if (loadedLanguages.has(aliased)) return aliased;
  const grammar = SHIKI_GRAMMARS.languages[aliased];
  if (!grammar) return "text";
  try {
    getHighlighter().loadLanguageSync(grammar as never);
    loadedLanguages.add(aliased);
    return aliased;
  } catch {
    return "text";
  }
}

/** Highlight one fenced block. Returns null when the block must stay plain. */
function highlightCode(code: string, language: string | undefined): string | null {
  if (byteLength(code) > MAX_HIGHLIGHT_BYTES) return null;
  return getHighlighter().codeToHtml(code, {
    lang: resolveLanguage(language),
    themes: SHIKI_THEMES,
    defaultColor: false,
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ────────────────────────────── pipeline ──────────────────────────────

/**
 * Language tag of a `<code>` element, from the `language-…` class remark-rehype
 * writes for a fence info string.
 */
function fenceLanguage(node: Element): string | undefined {
  for (const value of classNamesOf(node)) {
    const match = /^language-(.+)$/.exec(value);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** True for the `<pre><code>` that `remark-math` uses for display math. */
function isMathFence(code: Element): boolean {
  const classes = classNamesOf(code);
  return classes.includes("language-math") || classes.some((entry) => entry.startsWith("math-"));
}

/** Class list of an element, in either the array or the string form. */
function classNamesOf(node: Element): string[] {
  const className = node.properties?.className;
  if (Array.isArray(className)) return className.map(String);
  if (typeof className === "string") return className.split(/\s+/u).filter(Boolean);
  return [];
}

/** Concatenated text of a node, which is all a fenced block's children are. */
function textContent(node: Element): string {
  let out = "";
  const walk = (child: unknown): void => {
    if (!child || typeof child !== "object") return;
    const node = child as { type?: string; value?: string; children?: unknown[] };
    if (node.type === "text" && typeof node.value === "string") out += node.value;
    for (const next of node.children ?? []) walk(next);
  };
  walk(node);
  return out;
}

/**
 * Replace sanitized fenced blocks with Shiki's `<pre>`.
 *
 * Runs as a rehype plugin **after** `rehype-sanitize` and before
 * `rehype-stringify`, and inserts the highlighted markup as `raw` nodes so
 * `rehype-stringify` emits it verbatim (as the browser does when `CodeBlock`
 * injects it past react-markdown). Shiki escapes the code it is given, so the
 * inserted markup only contains text and class/style attributes the highlighter
 * itself produced.
 *
 * A block whose text exceeds {@link MAX_HIGHLIGHT_BYTES} is left exactly as
 * sanitize left it — a plain `<pre><code>` — and recorded on the context.
 */
function rehypeShiki(context: { downgraded: boolean }) {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index: number | undefined, parent: Parents | undefined) => {
      if (node.tagName !== "pre" || index === undefined || !parent) return;
      const code = node.children.find(
        (child): child is Element => child.type === "element" && child.tagName === "code",
      );
      if (!code) return;
      // `remark-math` gives display math the same `<pre><code>` shape a fence
      // gets, distinguished only by its `math-display` class. `rehype-katex`
      // runs after this plugin and needs the node untouched.
      if (isMathFence(code)) return;

      const source = textContent(code);
      const highlighted = highlightCode(source, fenceLanguage(code));
      if (highlighted === null) {
        context.downgraded = true;
        return;
      }
      // rehype permits a raw node wherever a node is expected; the cast keeps
      // the visitor typed against hast's closed union.
      parent.children[index] = { type: "raw", value: highlighted } as never;
    });
  };
}

/**
 * Wrap every `<table>` in the horizontal-scroll container the browser's
 * `Markdown.tsx` puts around it (`mode="minimal"` maps `table` to
 * `<div className="my-3 overflow-x-auto"><table …/></div>`).
 *
 * This is a structural difference rather than a cosmetic one: without the
 * wrapper a wide table cannot scroll, and `body_html` is final markup — the
 * client injects it and only attaches interaction, so nothing adds the wrapper
 * later.
 *
 * The wrapper is added after `rehype-sanitize`, which is what lets the `div`
 * through: it is generated here, not derived from user markdown.
 */
function rehypeTableScrollWrapper() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index: number | undefined, parent: Parents | undefined) => {
      if (node.tagName !== "table" || index === undefined || !parent) return;
      // Tables the author wrote as raw HTML sit inside the scroll container
      // already; do not nest two.
      if (parent.type === "element" && (parent as Element).tagName === "div") return;
      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["markdown-table-scroll"] },
        children: [node],
      } as never;
    });
  };
}

/** The remark/rehype stack, built once. Shiki state is module-level. */
function createProcessor(context: { downgraded: boolean }) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm, { singleTilde: false })
    .use(remarkMath)
    .use(remarkBreaks)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, SANITIZE_SCHEMA)
    .use(rehypeTableScrollWrapper)
    .use(rehypeShiki, context)
    .use(rehypeKatex)
    .use(rehypeStringify, { allowDangerousHtml: true });
}

/**
 * Render markdown to sanitized, highlighted HTML.
 *
 * `cdnDomain` only affects legacy file-card detection, the same as the browser
 * prop; omit it and only the explicit `!file[…]()` syntax produces a card.
 */
export function renderMarkdown(markdown: string, options: { cdnDomain?: string } = {}): RenderedMarkdown {
  const context = { downgraded: false };
  const processed = preprocessMarkdown(markdown, options.cdnDomain ?? "");
  const file = createProcessor(context).processSync(processed);
  return {
    html: String(file),
    render_version: RENDER_VERSION,
    downgraded: context.downgraded,
  };
}
