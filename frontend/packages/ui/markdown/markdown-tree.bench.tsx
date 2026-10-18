// @vitest-environment jsdom
/**
 * Thirty chat replies, rendered the way a chat remount renders them.
 *
 *   cd frontend/packages/ui && bunx vitest bench --run markdown/markdown-tree.bench.tsx
 *
 * jsdom gives `window`, so `Markdown` caches as in a tab. `react-markdown` is
 * the path before the cache; `cold` empties the cache
 * first (a first visit); `warm` finds every tree cached (a return visit). The
 * `tree only` pair isolates the parse the cache skips. Timings are reported,
 * not asserted.
 */
import { renderToStaticMarkup } from 'react-dom/server'
// Bench files are dev-only like tests; the shared lint config lists only test globs.
// eslint-disable-next-line import-x/no-extraneous-dependencies
import { bench, describe } from 'vitest'
import { Markdown, markdownTrees } from './Markdown'
import { ReferenceMarkdown, chatReply } from './markdown-test-fixtures'

const replies = Array.from({ length: 30 }, (_, index) => chatReply(index + 1))
const options = { time: 2000, warmupTime: 500 }

const renderCached = (): string =>
  renderToStaticMarkup(<>{replies.map((reply, index) => <Markdown key={index}>{reply}</Markdown>)}</>)

describe('render 30 chat replies', () => {
  bench('react-markdown, no cache', () => {
    renderToStaticMarkup(<>{replies.map((reply, index) => <ReferenceMarkdown key={index}>{reply}</ReferenceMarkdown>)}</>)
  }, options)

  bench('cached, cold', () => {
    markdownTrees.cache.clear()
    renderCached()
  }, options)

  bench('cached, warm', () => {
    renderCached()
  }, { ...options, setup: () => { markdownTrees.cache.clear(); renderCached() } })
})

describe('tree only, 30 chat replies', () => {
  bench('cold', () => {
    markdownTrees.cache.clear()
    for (const reply of replies) markdownTrees.get(reply)
  }, options)

  bench('warm', () => {
    for (const reply of replies) markdownTrees.get(reply)
  }, { ...options, setup: () => { for (const reply of replies) markdownTrees.get(reply) } })
})
