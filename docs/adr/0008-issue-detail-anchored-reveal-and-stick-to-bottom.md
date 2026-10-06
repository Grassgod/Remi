# ADR 0008: Issue detail hides, positions once, then sticks to the bottom

## Status

Accepted (MUL-390, child of MUL-383 §3.1/§3.2 S2). Supersedes the "ADR 0002"
draft the MUL-383 plan reserved for this decision; 0002 was taken by the
repository wiki list change ([ADR 0002](0002-repository-wiki-list-without-bodies.md)).
The two hooks it describes are implemented by MUL-450
(`views/common/use-anchored-reveal.ts`, `views/common/use-stick-to-bottom.ts`).

## Context

The issue detail page renders the title, description, sub-issues, published
results, the live agent card and the comment timeline in one scroll root. The
timeline mounts virtualized at its last row, so the first user-visible frame is
already at the bottom — but the elements above it are still arriving. Comments
carry Shiki-highlighted code and images, the description and sub-issue sections
resolve on their own queries, and the session's agent stream row only appears
once `issueKeys.tasks(issueId)` settles. Each of those inserts or grows content
*above* the viewport, which shoves the reading position down. The user sees the
page settle at the bottom and then get dragged away from it, sometimes several
times.

Two acceptance rules come from the parent issue (MUL-383 §3.1): the first frame
that contains real content must already be at the final scroll position, and no
later arrival of real content may move the viewport. Enforcement is structural,
not temporal: `tests/integration/zero-jump-check.ts` (S7) counts viewport
movement over the `data-perf-*` DOM contract in CI, and
`frontend/scripts/perf/page-speed.ts` (S1) measures the same contract against a
deployed instance. Neither reads wall-clock numbers to decide pass or fail.

The message architecture v2 (`SessionLogList`) and Chat need the same behaviour,
so the mechanism cannot be owned by the issue timeline component.

## Decision

1. **Hide, then position once.** The activity content stays
   `visibility: hidden` (layout preserved, so it can be measured) until five
   gates hold, then a single frame positions the scroll root and reveals it:
   data ready (Issue, sessions and the target log window), list layout settled (for the flat deep-link path, trivially
   true), target position stable for two consecutive animation frames, images
   without intrinsic dimensions inside the viewport complete or `imageWaitMs` elapsed, and the reveal budget
   not exhausted. The budget is 800 ms by default; the main branch's flat
   deep-link path passes 1500 ms because a 250-comment page mounts every row
   synchronously there. Exhausting the budget still reveals, but publishes
   `data-perf-state="ready-forced"` and warns; CI and S1 treat `ready-forced`
   as a failure, so it is a diagnostic, not a fallback that counts as passing.

   S9-6 (MUL-395) removes the live card's initial reconcile from the data gate.
   Cached tasks can paint the card shell; `active-task`, subscribers and local
   directory resources are reconciled after reveal. The card, subscriber control,
   local hint and running row reserve layout slots before their late content
   arrives. A running page's measurement endpoint remains the actual visible,
   stable agent-stream row after reveal; an earlier ready attribute alone is
   insufficient. Late growth beyond the reserved slot uses the same pin state
   machine, including released readers and element anchors.

2. **Stick to the bottom after the reveal.** A separate state machine
   (`pinned | released | returning`) compensates for content that arrives
   after the reveal. It observes the content with `ResizeObserver`, which runs
   after layout and before paint, so growth above the viewport is absorbed in
   the same frame instead of as a visible correction on the next one. Bottom
   mode holds the distance to the end; element mode holds the target row's
   offset. Any real user scroll intent — wheel up, touch move, arrow/page
   keys, dragging the scrollbar — releases the pin. Returning to within the pin
   threshold, `pin()`, or the existing "back to latest" control re-engages it.

   The "back to latest" control drives the hook's own return trip rather than the
   virtualizer's `scrollToIndex(LAST)`. The virtualizer can only place the last
   *row* at the viewport edge, while the agent-stream row and the composer live
   below the list in the same scroll container; the trip therefore used to stop
   short of the end, inside the virtualizer's band but outside this hook's, so
   the machine stayed released and the next comment did not follow. The hook's
   trip travels to the end of the content and pins on its own threshold, which
   also means `pin()` adopts a zero distance instead of whatever gap the
   virtualizer happened to stop at.

   The state machine is also the single authority for following new content.
   The list is rendered by a virtualizer with its own, much wider notion of
   "at the bottom" (Virtuoso's default band is 120 px, roughly the composer
   below the timeline, against this hook's 24 px), so a reader parked between
   the two thresholds is released by the hook while the virtualizer still
   considers itself at the end. Letting the virtualizer follow on its own
   signal therefore drags that reader back on the next comment — the exact
   behaviour this issue removes. Follow only while the hook reports `pinned`,
   and re-pin on the virtualizer's at-bottom signal only together with a
   downward scroll since the release, so the band alone can never re-engage it.
   That gate is not enough on its own: `pin()` anchors at the distance present
   when it is called, so a consumer that pins from inside the wider band holds
   the page short of the end and later content maintains the gap rather than
   closing it. Only pin when the container is inside the hook's own threshold.

3. **The hooks are pure DOM modules with no data knowledge.** They live in
   `frontend/packages/views/common/` (the `views` package has the jsdom test
   runner; `packages/ui` has none) and receive the scroll element, the content
   element, an anchor (`bottom` or a comment id) and a caller-computed
   `dataReady` boolean. Deciding "the data is here" stays with the consumer,
   because only the consumer knows which queries the screen needs.
   `useAnchoredReveal` is the sole writer of `data-perf-state` and
   `data-perf-fresh`; the recorders only read them.

4. **The hooks land before their consumers.** They were implemented in MUL-450
   and merged to `main` on their own, then consumed by the current Virtuoso
   detail page here, and later by v2's `SessionLogList`. Wiring inside
   `issue-activity-section.tsx` / `issue-detail-main.tsx` is expected to be
   rewritten by C9 (MUL-444) when it replaces the list; the hooks, their tests
   and the DOM contract carry over.

## Alternatives considered

- **`column-reverse` on the scroll container.** The usual chat trick, and the
  page would open at the bottom for free. Virtuoso does not support a
  reverse-oriented container, and the description and sub-issues would render
  below the timeline.
- **`overflow-anchor` only.** The browser's own scroll anchoring. Safari does
  not implement it, Virtuoso disables it internally, and the sticky
  `AgentLiveCard` already confuses anchor selection on this page.
- **Reserve heights server-side** so nothing ever grows. Needs real metrics
  for markdown, Shiki output and images; only the browser has them. Images
  cannot be reserved either — attachment rows carry no intrinsic width/height
  today, so `aspect-ratio` has nothing to read.
- **Wait for the v2 list and do it there.** Would tie MUL-383's acceptance to
  an architecture change with no date, and v2 needs the same hooks regardless.

## Consequences

- **Positive:** the first content-bearing frame is the final one, and later
  arrivals no longer move the viewport. The same mechanism serves the detail
  page, the v2 session log and Chat.
- **Deliberate trade:** `firstRealMs` gets later — content is withheld until it
  can be shown in place — while the time to a settled page (`readyMs`) is
  what the acceptance measures. A user on a slow link sees the skeleton for
  longer instead of seeing the page move.
- **`ready-forced` is a failure signal.** It is reported separately by both
  probes rather than folded into the ready time, so a budget that is too
  tight shows up as a defect instead of a latency win.
- **Two budgets exist until MUL-393** replaces the deep-link flat path with a
  windowed one; the 1500 ms exception then goes away.
- **The virtualizer's own at-bottom signal is not authoritative.** It is wider
  than the hook's threshold by design (a composer sits below the list), so
  consumers must gate both following and re-pinning on the hook's state; the
  signal alone only says "the last row is near", not "the reader wants to be
  at the end".
- **`CodeBlock.tsx`'s minimal loading placeholder must wrap the same way as
  its highlighted output** (`break-all`); otherwise a long line re-flows the
  block when Shiki resolves.
- **C9 redoes the wiring, not the rules.** The gates computed inside
  `issue-activity-section.tsx` are specific to the Virtuoso path and will be
  discarded when the list is replaced.

### S9-6：SSR 首次定位等待侧栏实际宽度

SSR 定位脚本在原有显示偏好门禁之外读取 SidebarProvider 的 `data-sidebar-width-ready`，等本地宽度恢复；展开的桌面侧栏仍在原 CSS 宽度动画中时，按实际 gap 宽度继续等待，再按原揭示契约的两帧稳定门禁等待正文宽度、滚动高度及滚动位置稳定，用最终布局首次定位；不改面板注册。每个日志根最多一个宽度等待帧链；已完成定位的根不重新定位。侧栏 DOM、动画、日志滚动状态机、预算和记录器阈值均未修改。带 seed 的 `detail-long-sidebar::cold` 与普通 CSR 分别验证；正式 SSR 脚本测试覆盖偏好完成但宽度未恢复，以及恢复值已写入而动画未完成两条路径。

### S9-6：流式 SSR 缓冲区中的日志图片

日志正文的图片若未声明 `loading`，在渲染时补 `loading="lazy"`；保留原 URL、尺寸及显式加载偏好。浏览器因此等隐藏的 SSR 缓冲区放入实际页面后才加载图片，避免流式放置前后的重复读取。该处理只作用于 `EntryHtml` 的渲染副本，不改日志数据和滚动布局。原生 Chromium 回归用与 S7 相同的请求路由方式验证：隐藏缓冲区到实际容器的读取由 2 次降为 1 次；容器仍为 `visibility:hidden` 时图片可以完成加载，加载后的自然尺寸一致。撤去处理后同一断言必须失败；S7 继续对整轮全部附件 content 读取执行原有单次门禁。
