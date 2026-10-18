/**
 * Test-only support for the parsed-Markdown cache: the reference renderer that
 * `Markdown` must match, the parity corpus, and the chat replies the
 * microbenchmark renders. Not exported from the package index.
 */
import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import { cn } from '@multiremi/ui/lib/utils'
import { createComponents, markdownPipeline, type MarkdownProps } from './Markdown'
import { preprocessFileCards } from './file-cards'
import { preprocessLinks } from './linkify'
import { preprocessMentionShortcodes } from './mentions'

/**
 * `Markdown` as it rendered before the cache: same preprocessing, same
 * components, and `react-markdown` running the whole pipeline on every render.
 */
export function ReferenceMarkdown({
  children,
  mode = 'minimal',
  className,
  onUrlClick,
  onFileClick,
  renderMention,
  renderImage,
  renderFileCard,
  cdnDomain,
}: MarkdownProps): React.JSX.Element {
  const components = createComponents(mode, onUrlClick, onFileClick, renderMention, renderImage, renderFileCard)
  let processed = preprocessMentionShortcodes(children)
  processed = preprocessLinks(processed)
  processed = preprocessFileCards(processed, cdnDomain ?? '')
  return (
    <div className={cn('markdown-content break-words', className)}>
      <ReactMarkdown
        remarkPlugins={markdownPipeline.remarkPlugins}
        rehypePlugins={markdownPipeline.rehypePlugins}
        urlTransform={markdownPipeline.urlTransform}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

export const CDN_DOMAIN = 'cdn.example.com'

/** Inputs covering every feature the pipeline or the components treat specially. */
export const PARITY_CORPUS: Array<{ name: string; markdown: string }> = [
  { name: 'empty', markdown: '' },
  { name: 'prose with soft breaks', markdown: 'line one\nline two\n\nsecond paragraph with **bold**, _em_ and `inline code`.' },
  {
    name: 'gfm table with alignment',
    markdown: '| left | center | right |\n| :--- | :---: | ---: |\n| a | b | c |\n| `x` | **y** | [z](https://example.com) |',
  },
  { name: 'gfm task list', markdown: '- [ ] todo\n- [x] done\n  - [ ] nested' },
  { name: 'strikethrough, double tilde only', markdown: '~~gone~~ but ~kept~ as text' },
  { name: 'footnotes', markdown: 'A claim.[^1] Another.[^note]\n\n[^1]: First source.\n[^note]: Second source.' },
  { name: 'autolink literals and bare urls', markdown: 'Visit www.example.com or https://example.com/a?b=1#c, mail me@example.com.' },
  { name: 'cjk url terminator', markdown: '请看 https://example.com/path。然后继续' },
  { name: 'inline math', markdown: 'Energy is $E = mc^2$ and $\\alpha + \\beta$.' },
  { name: 'block math', markdown: '$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$' },
  { name: 'invalid math', markdown: 'Broken: $\\frac{1}{$ end' },
  {
    name: 'raw html kept by sanitize',
    markdown: '<details><summary>More</summary>\n\nhidden **text**\n\n</details>\n\n<kbd>Ctrl</kbd>+<kbd>C</kbd> H<sub>2</sub>O<br>x<sup>2</sup>\n\n<img src="https://example.com/pic.png" alt="pic">',
  },
  {
    name: 'raw html stripped by sanitize',
    markdown: '<script>alert(1)</script>\n<img src="x" onerror="alert(1)">\n<iframe src="https://evil.test"></iframe>\n<style>body{}</style>\n<div onclick="x()" style="color:red">div text</div>\n<a href="javascript:alert(1)">js link</a>',
  },
  { name: 'raw code tag and comment', markdown: '<code>uv run pytest</code> <!-- a comment --> &amp; &lt;tag&gt;' },
  {
    name: 'links and url transform',
    markdown: [
      '[ok](https://example.com) [mail](mailto:a@example.com) [rel](./docs/readme.md) [abs](/home/me/app.ts)',
      '[js](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [vb](vbscript:msgbox) [anchor](#top) [query](?x=1)',
      '<https://angle.example.com> [ftp](ftp://example.com/f) [irc](irc://example.com)',
    ].join('\n'),
  },
  {
    name: 'mentions and slash links',
    markdown: '[@Bob](mention://member/u_1) [@Agent](mention://agent/a_1) [#12](mention://issue/iss_1) [P](mention://project/p_1) [@all](mention://all/all) [odd](mention://unknown/x) [/deploy](slash://skill/abc) [bad](slash://other/abc)',
  },
  { name: 'legacy mention shortcodes', markdown: 'Ping [@ id="u_42" label="Alice"] and [@ id="" label="Nobody"].' },
  {
    name: 'file cards',
    markdown: [
      '!file[report.pdf](https://files.example.com/report.pdf)',
      '[legacy.zip](https://cdn.example.com/up/legacy.zip)',
      '[picture.png](https://cdn.example.com/up/picture.png)',
      '!file[attached](/api/attachments/att_1/content)',
      '!file[bad](javascript:alert(1))',
    ].join('\n\n'),
  },
  { name: 'images', markdown: '![alt text](https://example.com/a.png) ![](https://example.com/b.png) ![x](javascript:alert(1))' },
  {
    name: 'code blocks',
    markdown: '```ts\nconst a: number = 1\n```\n\n```\nno language\n```\n\n    indented code\n\nand `inline` too\n\n```python\ndef f():\n    return 1\n```',
  },
  {
    name: 'headings, quotes, rules, nested lists',
    markdown: '# H1\n## H2\n### H3\n#### H4\n\n> quoted\n> > nested\n\n---\n\n1. one\n2. two\n   - a\n   - b\n\n* star',
  },
  { name: 'cjk and emoji', markdown: '中文段落，**加粗**和`代码`。🚀 测试' },
]

/** One chat reply with the shape the Chat switch harness seeds, varied per index. */
export function chatReply(index: number): string {
  return [
    `Here is what I found for **step ${index}**. The change touches three places:`,
    '',
    '1. `packages/core/session-log/issue-log.ts` — the replica window',
    '2. `packages/views/chat/components/chat-window.tsx` — the page shell',
    `3. See [the plan](https://example.com/plan/${index}) and https://example.com/issues/${index}`,
    '',
    '```ts',
    'export function useIssueLog(sessionId: string) {',
    `  const replica = useMemo(() => new IssueLogReplica(sessionId), [sessionId]); // ${index}`,
    '  return useSyncExternalStore(replica.subscribe, replica.getSnapshot);',
    '}',
    '```',
    '',
    '| step | before | after |',
    '| --- | --- | --- |',
    `| read | ${index * 3} ms | ${index} ms |`,
    '| paint | 120 ms | 40 ms |',
    '',
    index % 3 === 0 ? `The cost grows as $O(n \\log n)$ for ${index} rows.` : `> Note ${index}: nothing else changed.`,
    '',
    'filler sentence so the row wraps over several lines in the reading column. '.repeat(4),
  ].join('\n')
}
