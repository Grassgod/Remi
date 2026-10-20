// @vitest-environment jsdom
// jsdom provides `window`, so `Markdown` takes its browser path: the cache.
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { type Components } from 'react-markdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown, type MarkdownProps, markdownPipeline, markdownTrees } from './Markdown'
import { renderMarkdownTree } from './markdown-tree'
import { CDN_DOMAIN, PARITY_CORPUS, ReferenceMarkdown } from './markdown-test-fixtures'

/**
 * Prop sets that give the same content different components: the three modes,
 * and caller renderers for mentions, images and file cards. Rendering them in
 * a row over one cache entry shows the cache keeps no components.
 */
const VARIANTS: Array<{ name: string; props: Omit<MarkdownProps, 'children'> }> = [
  { name: 'minimal', props: {} },
  { name: 'full', props: { mode: 'full', className: 'prose' } },
  { name: 'terminal', props: { mode: 'terminal' } },
  {
    name: 'caller renderers',
    props: {
      cdnDomain: CDN_DOMAIN,
      renderMention: ({ type, id }) => <span data-mention={type}>{id}</span>,
      renderImage: ({ src, alt }) => <figure data-src={src}>{alt}</figure>,
      renderFileCard: ({ href, filename }) => <span data-file={href}>{filename}</span>,
    },
  },
]

/** What the minimal render of a fixture has to show, so a pair of empty outputs cannot pass. */
const SHOWS: Record<string, { has?: string[]; lacks?: string[] }> = {
  'prose with soft breaks': { has: ['line one<br/>'] },
  'gfm table with alignment': { has: ['<table', '<th'] },
  'gfm task list': { has: ['type="checkbox" disabled="" checked=""'] },
  'strikethrough, double tilde only': { has: ['<del>gone</del>', '~kept~'] },
  footnotes: { has: ['href="#user-content-fn-1"', 'data-footnotes'] },
  'autolink literals and bare urls': { has: ['href="http://www.example.com"', 'href="mailto:me@example.com"'] },
  'inline math': { has: ['class="katex"'] },
  'block math': { has: ['katex-display'] },
  'invalid math': { has: ['katex-error'] },
  'raw html kept by sanitize': { has: ['<details>', '<kbd>Ctrl</kbd>', '<sub>2</sub>'] },
  'raw html stripped by sanitize': { lacks: ['<script', 'onerror', '<iframe', 'onclick', 'javascript:'] },
  'links and url transform': { has: ['href="./docs/readme.md"', 'href="irc://example.com"'], lacks: ['javascript:', 'data:', 'vbscript:', 'ftp:'] },
  'mentions and slash links': { has: ['slash-command', '/compact</span>', '@Bob', '<a href="" '], lacks: ['slash://command'] },
  'legacy mention shortcodes': { has: ['@Alice'] },
  'file cards': { has: ['report.pdf', 'legacy.zip'], lacks: ['javascript:'] },
  images: { has: ['<img src="https://example.com/a.png" alt="alt text"'], lacks: ['javascript:'] },
  'code blocks': { has: ['typescript', 'indented code'] },
  'headings, quotes, rules, nested lists': { has: ['<h4>H4</h4>', '<blockquote', '<hr'] },
}

const cached = (markdown: string, props: Omit<MarkdownProps, 'children'>): string =>
  renderToStaticMarkup(<Markdown {...props}>{markdown}</Markdown>)

const reference = (markdown: string, props: Omit<MarkdownProps, 'children'>): string =>
  renderToStaticMarkup(<ReferenceMarkdown {...props}>{markdown}</ReferenceMarkdown>)

// Every tree a render sees is frozen, misses included, so these renders also
// show that neither `toJsxRuntime` nor any of the four component sets writes
// to a node: a write would throw a TypeError here.
describe('Markdown parity with react-markdown', () => {
  let parses: boolean[]

  beforeEach(() => {
    markdownTrees.cache.clear()
    parses = []
    const get = markdownTrees.get.bind(markdownTrees)
    vi.spyOn(markdownTrees, 'get').mockImplementation((content) => {
      const entry = get(content)
      parses.push(entry.parsed)
      return entry
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    markdownTrees.cache.clear()
  })

  for (const { name, markdown } of PARITY_CORPUS) {
    it(`${name}: identical on a miss, on hits, and per component set`, () => {
      for (const variant of VARIANTS) {
        expect(cached(markdown, variant.props), `${variant.name}`).toBe(reference(markdown, variant.props))
      }
      // Once more for the first variant, after the others reused its tree.
      const html = cached(markdown, VARIANTS[0]!.props)
      expect(html).toBe(reference(markdown, VARIANTS[0]!.props))
      for (const piece of SHOWS[name]?.has ?? []) expect(html).toContain(piece)
      for (const piece of SHOWS[name]?.lacks ?? []) expect(html).not.toContain(piece)

      // The minimal/full/terminal variants share one preprocessed string and
      // so one parse; `cdnDomain` can change preprocessing (file cards), in
      // which case the renderer variant is a second key.
      const distinctContents = new Set(markdownTrees.cache.keys())
      // Every render went through the cache (one lookup each), not the server path.
      expect(parses).toHaveLength(VARIANTS.length + 1)
      expect(distinctContents.size).toBeGreaterThan(0)
      expect(parses.filter(Boolean)).toHaveLength(distinctContents.size)
      expect(parses.filter((parsed) => !parsed).length).toBe(parses.length - distinctContents.size)
    })
  }

  it('is not vacuous: one cached tree renders differently per component set', () => {
    const markdown = '[@Bob](mention://member/u_1)\n\n![pic](https://example.com/a.png)\n\n- [x] done'
    const outputs = VARIANTS.map((variant) => cached(markdown, variant.props))
    expect(new Set(outputs).size).toBe(VARIANTS.length)
    expect(outputs[3]).toContain('data-mention="member"')
    expect(outputs[0]).not.toContain('data-mention')
    expect(parses).toEqual([true, false, false, false])
  })

  it('reuses the processor without carrying state between documents', () => {
    const [footnotes, links] = [PARITY_CORPUS[5]!.markdown, PARITY_CORPUS[14]!.markdown]
    for (const markdown of [footnotes, links, footnotes, links]) {
      markdownTrees.cache.clear()
      expect(cached(markdown, {})).toBe(reference(markdown, {}))
    }
  })
})

describe('renderMarkdownTree', () => {
  afterEach(() => markdownTrees.cache.clear())

  it('matches react-markdown for arbitrary component maps over one tree', () => {
    const markdown = PARITY_CORPUS.map((entry) => entry.markdown).join('\n\n')
    const { tree } = markdownTrees.get(markdown)
    const maps: Array<Partial<Components> | undefined> = [
      undefined,
      { p: ({ children }) => <p data-map="a">{children}</p>, a: 'span' },
      { p: ({ children }) => <section data-map="b">{children}</section>, code: ({ children }) => <kbd>{children}</kbd> },
    ]
    for (const components of maps) {
      const expected = renderToStaticMarkup(
        <ReactMarkdown
          remarkPlugins={markdownPipeline.remarkPlugins}
          rehypePlugins={markdownPipeline.rehypePlugins}
          urlTransform={markdownPipeline.urlTransform}
          components={components}
        >
          {markdown}
        </ReactMarkdown>,
      )
      expect(renderToStaticMarkup(renderMarkdownTree(tree, components))).toBe(expected)
    }
  })

  it('hands components a frozen node, so an edit throws instead of leaking', () => {
    const { tree } = markdownTrees.get('a paragraph')
    expect(Object.isFrozen(tree)).toBe(true)
    const mutate: Partial<Components> = {
      p: ({ node, children }) => {
        ;(node!.properties as Record<string, unknown>).id = 'edited'
        return <p>{children}</p>
      },
    }
    expect(() => renderToStaticMarkup(renderMarkdownTree(tree, mutate))).toThrow(TypeError)
    expect(renderToStaticMarkup(renderMarkdownTree(tree, undefined))).toBe('<p>a paragraph</p>')
  })
})
