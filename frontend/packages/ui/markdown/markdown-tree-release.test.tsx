// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown, markdownTrees } from './Markdown'

describe('Markdown cache entries across mounts', () => {
  beforeEach(() => markdownTrees.cache.clear())
  afterEach(() => {
    cleanup()
    markdownTrees.cache.clear()
  })

  it('keeps one entry for content that grows while mounted (streaming)', () => {
    const chunks = ['Hel', 'Hello', 'Hello **wor', 'Hello **world**', 'Hello **world**\n\n- a\n- b']
    const view = render(<Markdown>{chunks[0]!}</Markdown>)
    for (const chunk of chunks.slice(1)) view.rerender(<Markdown>{chunk}</Markdown>)
    expect(markdownTrees.cache.keys()).toEqual([chunks.at(-1)])
    expect(view.container.querySelectorAll('li')).toHaveLength(2)
  })

  it('keeps the entry on unmount, so a remount (chat switch back) is a hit', () => {
    const content = 'A reply with `code` and a [link](https://example.com).'
    const first = render(<Markdown>{content}</Markdown>)
    const html = first.container.innerHTML
    const tree = markdownTrees.cache.peek(content)
    first.unmount()
    expect(markdownTrees.cache.peek(content)).toBe(tree)

    const again = render(<Markdown mode="full">{content}</Markdown>)
    expect(markdownTrees.cache.peek(content)).toBe(tree)
    expect(markdownTrees.cache.size).toBe(1)
    again.unmount()
    expect(render(<Markdown>{content}</Markdown>).container.innerHTML).toBe(html)
  })

  it('leaves an entry alone once another instance has stored a different tree for it', () => {
    const view = render(<Markdown>{'old text'}</Markdown>)
    const replaced = markdownTrees.get('replacement')
    markdownTrees.cache.delete('old text')
    const other = markdownTrees.get('old text').tree
    view.rerender(<Markdown>{'replacement'}</Markdown>)
    expect(markdownTrees.cache.peek('old text')).toBe(other)
    expect(markdownTrees.cache.peek('replacement')).toBe(replaced.tree)
  })
})
