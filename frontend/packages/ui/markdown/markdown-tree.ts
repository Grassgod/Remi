/**
 * Parsed-Markdown cache for `Markdown`.
 *
 * `react-markdown` runs the whole unified pipeline (micromark parse, mdast →
 * hast, rehype-raw, sanitize, KaTeX) on every render. A chat that is switched
 * back to remounts every bubble, so the same replies were parsed again on each
 * visit. This module splits `react-markdown`'s `Markdown` into its two halves,
 * using the same public packages it uses:
 *
 * 1. {@link MarkdownTreeSource.get}: the pipeline up to and including the
 *    `urlTransform` pass of `react-markdown`'s `post`, producing a hast tree.
 *    The tree depends only on the content string (the plugins and the URL
 *    transform are fixed per source), so it is cached by content.
 * 2. {@link renderMarkdownTree}: `post`'s `toJsxRuntime` call, run on every
 *    render with the caller's `components`, exactly as `react-markdown` does.
 *    Components are never part of the cache.
 *
 * Cached trees are shared between every bubble showing the same content, so
 * `get` deep-freezes them when it parses (see {@link freezeTree}). `parse` runs
 * the same pipeline without the cache or the freeze, for renderers that show
 * each body once.
 */
import type { Element, Root } from 'hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { urlAttributes } from 'html-url-attributes'
import type * as React from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import type { Components, UrlTransform } from 'react-markdown'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { type PluggableList, unified } from 'unified'
import { visit } from 'unist-util-visit'
import { VFile } from 'vfile'

/** The `react-markdown` options that shape the tree; everything else is per render. */
export interface MarkdownPipeline {
  remarkPlugins: PluggableList
  rehypePlugins: PluggableList
  urlTransform: UrlTransform
}

/**
 * Bounds, in tree weight: one unit per object in the frozen tree (node,
 * `properties`, `children`, `position`, ...), per character of the strings it
 * holds, and per character of the content key. Content length alone is a poor
 * proxy for memory: KaTeX expands a formula into hundreds of nodes, so a
 * math-dense reply costs ~2 KB of heap per content character against ~35 bytes
 * for prose. Weight tracks heap within a factor of about three: V8 measured
 * 10–12 bytes per unit for prose and chat replies with lists and code, 24 for
 * tables, 35 for dense inline math.
 */
export interface MarkdownTreeCacheLimits {
  /** Most trees kept at once. */
  maxEntries: number
  /** Most weight kept at once. */
  maxTotalWeight: number
  /** A tree heavier than this is used for its own render and never stored. */
  maxEntryWeight: number
}

/**
 * Bounds for the cache every `Markdown` in a browser tab shares (servers do
 * not cache; see `Markdown.tsx`).
 *
 * - `maxEntries` 500: the Chat log pool keeps about ten chats of ~30 rows, each
 *   row one `Markdown`; the rest covers turn steps, subagent replies and other
 *   surfaces open in the same tab.
 * - `maxTotalWeight` 2,000,000: 20–70 MB of heap at the measured 10–35 bytes per
 *   unit. A typical 1 k-character chat reply weighs ~3 k, so 500 of them use
 *   about 1.5 M; a chat full of dense formulas (~30 k per reply) keeps its last
 *   ~65 replies instead of 500.
 * - `maxEntryWeight` 200,000 (10% of the total, roughly a 70 k-character plain
 *   reply or 3.5 k characters of dense math): storing one would evict dozens of
 *   ordinary replies, so such bodies are parsed per mount as before.
 */
export const MARKDOWN_TREE_CACHE_LIMITS: MarkdownTreeCacheLimits = {
  maxEntries: 500,
  maxTotalWeight: 2_000_000,
  maxEntryWeight: 200_000,
}

/**
 * Least-recently-used map from content to hast tree, bounded by entry count and
 * by total weight. A `Map` keeps insertion order, so the first key is the least
 * recently used one; a hit re-inserts its key at the end.
 */
export class MarkdownTreeCache {
  private readonly entries = new Map<string, { tree: Root; weight: number }>()
  private weight = 0

  constructor(readonly limits: MarkdownTreeCacheLimits) {}

  get size(): number {
    return this.entries.size
  }

  /** Summed weight of the stored entries. */
  get totalWeight(): number {
    return this.weight
  }

  /** Keys from least to most recently used. */
  keys(): string[] {
    return [...this.entries.keys()]
  }

  /** The stored tree, marking it most recently used. */
  get(key: string): Root | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.tree
  }

  /** The stored tree without touching recency. */
  peek(key: string): Root | undefined {
    return this.entries.get(key)?.tree
  }

  /**
   * Store `tree` as the most recently used entry, evicting from the least
   * recently used end until both budgets hold. Returns `false`, storing
   * nothing and evicting nothing, when `weight` is over `maxEntryWeight`.
   */
  set(key: string, tree: Root, weight: number): boolean {
    if (weight > this.limits.maxEntryWeight) return false
    this.delete(key)
    this.entries.set(key, { tree, weight })
    this.weight += weight
    while (
      this.entries.size > this.limits.maxEntries ||
      this.weight > this.limits.maxTotalWeight
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined || oldest === key) break
      this.delete(oldest)
    }
    return true
  }

  /** Remove `key`; with `tree`, only while `key` still maps to that tree. */
  delete(key: string, tree?: Root): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined || (tree !== undefined && entry.tree !== tree)) return false
    this.entries.delete(key)
    this.weight -= entry.weight
    return true
  }

  clear(): void {
    this.entries.clear()
    this.weight = 0
  }
}

/**
 * Deep-freeze a tree and return its weight (objects plus string characters).
 *
 * Every bubble showing the same content renders the same tree, and components
 * receive its nodes as `node`, so a component that edited one would change
 * other bubbles. Frozen, such an edit throws instead (modules are strict).
 * Nothing on the render path edits it today: `toJsxRuntime` builds fresh props
 * objects and only reads nodes (the `style` object it writes for table-cell
 * `align` is one it just parsed from a string), and our components only read
 * `node.properties` and `node.position`.
 */
export function freezeTree(tree: Root): number {
  const stack: object[] = [tree]
  let weight = 0
  while (stack.length > 0) {
    const value = stack.pop() as Record<string, unknown>
    if (Object.isFrozen(value)) continue
    Object.freeze(value)
    weight += 1
    for (const key in value) {
      const child = value[key]
      if (typeof child === 'string') weight += child.length
      else if (child !== null && typeof child === 'object') stack.push(child)
    }
  }
  return weight
}

export interface MarkdownTreeEntry {
  tree: Root
  /** Whether this call parsed the content (a cache miss). */
  parsed: boolean
}

export interface MarkdownTreeSource {
  readonly cache: MarkdownTreeCache
  /** The tree for `content`: from the cache, or parsed now and stored if it fits. */
  get(content: string): MarkdownTreeEntry
  /**
   * The same pipeline without the cache: a fresh tree each call, neither
   * stored nor frozen. For renderers that show each body once (servers).
   */
  parse(content: string): Root
}

/**
 * Pair one fixed pipeline with a cache. The processor is built once, on first
 * use, and reused: unified processors are frozen after the first run and the
 * plugins in use keep no per-document state between runs.
 */
export function createMarkdownTreeSource(
  pipeline: MarkdownPipeline,
  limits: MarkdownTreeCacheLimits = MARKDOWN_TREE_CACHE_LIMITS,
): MarkdownTreeSource {
  const cache = new MarkdownTreeCache(limits)
  let processor: ReturnType<typeof createProcessor> | undefined
  const parse = (content: string): Root => {
    processor ??= createProcessor(pipeline)
    return parseTree(processor, pipeline.urlTransform, content)
  }

  return {
    cache,
    parse,
    get(content) {
      const cached = cache.get(content)
      if (cached !== undefined) return { tree: cached, parsed: false }
      const tree = parse(content)
      // Frozen even when too heavy to store, so every tree a cached render
      // sees obeys the same rule.
      cache.set(content, tree, content.length + freezeTree(tree))
      return { tree, parsed: true }
    },
  }
}

/** `react-markdown`'s `createProcessor`, with its default `remark-rehype` options. */
function createProcessor(pipeline: MarkdownPipeline) {
  return unified()
    .use(remarkParse)
    .use(pipeline.remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(pipeline.rehypePlugins)
    .freeze()
}

/**
 * `react-markdown`'s `Markdown` up to `toJsxRuntime`: parse and run the
 * pipeline on a fresh file, then apply `post`'s visitor with the options
 * `Markdown` uses (no `skipHtml`, no element filters), which turns leftover raw
 * nodes into text and passes every URL attribute through `urlTransform`.
 */
function parseTree(
  processor: ReturnType<typeof createProcessor>,
  urlTransform: UrlTransform,
  content: string,
): Root {
  const file = new VFile()
  file.value = content
  const tree = processor.runSync(processor.parse(file), file)

  visit(tree, (node, index, parent) => {
    if (node.type === 'raw' && parent && typeof index === 'number') {
      parent.children[index] = { type: 'text', value: node.value }
      return index
    }
    if (node.type === 'element') {
      transformUrls(node, urlTransform)
    }
    return undefined
  })

  return tree
}

function transformUrls(node: Element, urlTransform: UrlTransform): void {
  for (const key in urlAttributes) {
    if (Object.hasOwn(urlAttributes, key) && Object.hasOwn(node.properties, key)) {
      const value = node.properties[key]
      const test = urlAttributes[key]
      if (test === null || test?.includes(node.tagName)) {
        node.properties[key] = urlTransform(String(value || ''), key, node)
      }
    }
  }
}

/** `react-markdown`'s `post` output for an already transformed tree. */
export function renderMarkdownTree(
  tree: Root,
  components: Partial<Components> | undefined,
): React.ReactElement {
  return toJsxRuntime(tree, {
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  })
}
