import type { Root } from 'hast'
import { describe, expect, it } from 'vitest'
import { markdownPipeline } from './Markdown'
import {
  MARKDOWN_TREE_CACHE_LIMITS,
  MarkdownTreeCache,
  createMarkdownTreeSource,
  freezeTree,
} from './markdown-tree'
import { chatReply } from './markdown-test-fixtures'

const tree = (): Root => ({ type: 'root', children: [] })
const limits = { maxEntries: 3, maxTotalWeight: 100, maxEntryWeight: 50 }

describe('MarkdownTreeCache', () => {
  it('misses, then hits with the stored tree', () => {
    const cache = new MarkdownTreeCache(limits)
    const a = tree()
    expect(cache.get('a')).toBeUndefined()
    expect(cache.set('a', a, 1)).toBe(true)
    expect(cache.get('a')).toBe(a)
    expect(cache.size).toBe(1)
  })

  it('evicts the least recently used entry, counting hits as use', () => {
    const cache = new MarkdownTreeCache(limits)
    for (const key of ['a', 'b', 'c']) cache.set(key, tree(), 1)
    cache.get('a')
    cache.set('d', tree(), 1)
    expect(cache.keys()).toEqual(['c', 'a', 'd'])
    // `peek` reads without promoting.
    cache.peek('c')
    cache.set('e', tree(), 1)
    expect(cache.keys()).toEqual(['a', 'd', 'e'])
  })

  it('evicts until the summed weight fits the budget', () => {
    const cache = new MarkdownTreeCache({ maxEntries: 10, maxTotalWeight: 10, maxEntryWeight: 10 })
    cache.set('a', tree(), 4)
    cache.set('b', tree(), 4)
    cache.set('c', tree(), 2)
    expect(cache.totalWeight).toBe(10)
    cache.set('d', tree(), 5)
    expect(cache.keys()).toEqual(['c', 'd'])
    expect(cache.totalWeight).toBe(7)
    // Storing a key again replaces it rather than counting it twice.
    cache.set('c', tree(), 3)
    expect(cache.keys()).toEqual(['d', 'c'])
    expect(cache.totalWeight).toBe(8)
  })

  it('does not store a tree over the per-entry cap, and evicts nothing for it', () => {
    const cache = new MarkdownTreeCache(limits)
    cache.set('kept', tree(), 40)
    expect(cache.set('heavy', tree(), 51)).toBe(false)
    expect(cache.keys()).toEqual(['kept'])
    expect(cache.totalWeight).toBe(40)
  })

  it('deletes by key, or only while the key still holds a given tree', () => {
    const cache = new MarkdownTreeCache(limits)
    const first = tree()
    cache.set('k', first, 5)
    cache.set('k', tree(), 6)
    expect(cache.delete('k', first)).toBe(false)
    expect(cache.size).toBe(1)
    expect(cache.delete('k')).toBe(true)
    expect(cache.size).toBe(0)
    expect(cache.totalWeight).toBe(0)
  })

  it('ships bounds that hold ten retained chats of chat replies', () => {
    // ~10 retained chats x ~30 rows, one Markdown per row.
    const { maxEntries, maxTotalWeight, maxEntryWeight } = MARKDOWN_TREE_CACHE_LIMITS
    expect(maxEntries).toBeGreaterThanOrEqual(300)
    const source = createMarkdownTreeSource(markdownPipeline)
    for (let i = 0; i < 300; i++) source.get(chatReply(i))
    expect(source.cache.size).toBe(300)
    expect(source.cache.totalWeight).toBeLessThan(maxTotalWeight / 2)
    expect(maxEntryWeight).toBeLessThanOrEqual(maxTotalWeight / 10)
  })
})

describe('freezeTree', () => {
  it('freezes every object and weighs objects plus string characters', () => {
    const value: Root = {
      type: 'root',
      children: [{ type: 'element', tagName: 'p', properties: { className: ['x'] }, children: [{ type: 'text', value: 'hi' }] }],
    }
    // root, children[], element, properties, className[], children[], text = 7 objects;
    // strings: root 4, element 7 + p 1, x 1, text 4 + hi 2 = 19.
    expect(freezeTree(value)).toBe(26)
    const element = value.children[0] as unknown as { properties: { className: string[] }; children: object[] }
    expect([value, value.children, element, element.properties, element.properties.className, element.children[0]].every(Object.isFrozen)).toBe(true)
    // Already frozen objects are not counted again.
    expect(freezeTree(value)).toBe(0)
  })
})

describe('createMarkdownTreeSource', () => {
  it('parses on a miss, stores a frozen tree, and returns it on a hit', () => {
    const source = createMarkdownTreeSource(markdownPipeline)
    const miss = source.get('**hi** [x](slash://other/abc)')
    expect(miss.parsed).toBe(true)
    expect(Object.isFrozen(miss.tree)).toBe(true)
    const hit = source.get('**hi** [x](slash://other/abc)')
    expect(hit).toEqual({ tree: miss.tree, parsed: false })
    // The urlTransform pass ran before storing: sanitize keeps the `slash:` href,
    // the transform empties it because it is not a skill link.
    const paragraph = miss.tree.children[0] as { children: Array<{ tagName?: string; properties?: Record<string, unknown> }> }
    expect(paragraph.children.find((node) => node.tagName === 'a')?.properties?.href).toBe('')
  })

  it('weighs a KaTeX-heavy body far above its length, and skips storing one over the cap', () => {
    const source = createMarkdownTreeSource(markdownPipeline, { maxEntries: 10, maxTotalWeight: 100_000, maxEntryWeight: 10_000 })
    const prose = 'plain words '.repeat(40)
    const math = '$\\sum_{i=1}^{n} \\frac{x_i^2}{\\sigma}$ '.repeat(12)
    source.get(prose)
    expect(source.cache.peek(prose)).toBeDefined()
    expect(source.cache.totalWeight).toBeLessThan(prose.length * 4)

    expect(source.get(math).parsed).toBe(true)
    expect(source.cache.peek(math)).toBeUndefined()
    expect(source.get(math).parsed).toBe(true)
    expect(source.cache.keys()).toEqual([prose])
  })
})
