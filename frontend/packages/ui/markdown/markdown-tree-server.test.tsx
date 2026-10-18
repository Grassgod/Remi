// No `window` here (Node environment): `Markdown` renders the way Next SSR and
// other server renderers do, through the same pipeline but without the cache.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Markdown, type MarkdownProps, markdownTrees } from './Markdown'
import { CDN_DOMAIN, PARITY_CORPUS, ReferenceMarkdown } from './markdown-test-fixtures'

const VARIANTS: Array<Omit<MarkdownProps, 'children'>> = [
  {},
  { mode: 'full' },
  { mode: 'terminal' },
  { cdnDomain: CDN_DOMAIN, renderMention: ({ type, id }) => <span data-mention={type}>{id}</span> },
]

describe('Markdown without a window', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    markdownTrees.cache.clear()
  })

  it('has no window in this environment', () => {
    expect(typeof window).toBe('undefined')
  })

  it('renders every corpus entry exactly like react-markdown, storing nothing', () => {
    markdownTrees.cache.clear()
    const get = vi.spyOn(markdownTrees, 'get')
    const parse = vi.spyOn(markdownTrees, 'parse')
    for (const { name, markdown } of PARITY_CORPUS) {
      for (const props of VARIANTS) {
        // Twice: a second render of the same body parses again.
        for (let pass = 0; pass < 2; pass++) {
          expect(renderToStaticMarkup(<Markdown {...props}>{markdown}</Markdown>), name).toBe(
            renderToStaticMarkup(<ReferenceMarkdown {...props}>{markdown}</ReferenceMarkdown>),
          )
        }
      }
    }
    expect(get).not.toHaveBeenCalled()
    expect(parse).toHaveBeenCalledTimes(PARITY_CORPUS.length * VARIANTS.length * 2)
    expect(markdownTrees.cache.size).toBe(0)
    expect(markdownTrees.cache.totalWeight).toBe(0)
  })

  it('hands the render a fresh, unfrozen tree', () => {
    const trees: unknown[] = []
    const parse = markdownTrees.parse.bind(markdownTrees)
    vi.spyOn(markdownTrees, 'parse').mockImplementation((content) => {
      const tree = parse(content)
      trees.push(tree)
      return tree
    })
    renderToStaticMarkup(<Markdown>{'**same** body'}</Markdown>)
    renderToStaticMarkup(<Markdown>{'**same** body'}</Markdown>)
    expect(trees).toHaveLength(2)
    expect(trees[0]).not.toBe(trees[1])
    expect(trees.some(Object.isFrozen)).toBe(false)
  })
})
