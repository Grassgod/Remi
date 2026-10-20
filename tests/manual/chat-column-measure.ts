#!/usr/bin/env bun
/**
 * Measures the Chat reading column in headless Chromium against
 * chat-switch-harness.ts: for each conversation-pane width, the column box,
 * and how far the composer's border sits from the message text's edges.
 *
 *   CHAT_SWITCH_API_PORT=16511 bun run tests/manual/chat-switch-harness.ts
 *   (frontend/apps/web) REMOTE_API_URL=http://127.0.0.1:16511 bunx next dev --webpack --port 3411
 *   CHAT_COLUMN_TOKEN=... CHAT_COLUMN_CHAT=chat_... bun run tests/manual/chat-column-measure.ts
 *
 * The token and the chat ids are the harness's `token=` and `chats=` lines;
 * the token is a local fixture credential and stays out of commits and reports.
 *
 * Each case sets the viewport so the conversation pane is the wanted width
 * with the app sidebar open or collapsed (the chat list stays at its default
 * 300px), then reads, from the page's own layout:
 *   pane     the `@container/chat-pane` element's width
 *   column   the message list's column box (`[data-session-log-scroll] > div`)
 *   text     its content box (box less the 16px padding): message text and the
 *            user bubble's right edge sit on it
 *   composer the composer's border box (`[data-chat-composer]`)
 * and prints `dL`/`dR`, composer minus text, which must be 0. Each case also
 * needs the log revealed as `ready` (not budget-forced), still at its end
 * (`bottomGap` <= 1px), still for 60 frames (`drift` <= 1px), and no row
 * held taller than its content by a cached height (`overReserved`). It then
 * resizes one page across the range (the pinned log reflows and stays at its
 * end) and checks the cases that must stay as before: the subagent split (the panel opened on
 * the 后台任务 view through the list's own `resolveChat` prop), the floating
 * window expanded on a wide viewport, and a mobile viewport.
 *
 * Env:
 *   CHAT_COLUMN_WEB        web origin (default http://localhost:3411)
 *   CHAT_COLUMN_SLUG       workspace slug (default local)
 *   CHAT_COLUMN_PANES      pane widths (default 1000,1200,1400,1600,1920)
 *   CHAT_COLUMN_SCROLLBARS=1  a 15px space-taking scrollbar on the list instead of an overlay one
 *   CHAT_COLUMN_CHROME     Chromium executable (default: Playwright's own)
 */
import { chromium, type Page } from "playwright-core";

const WEB = process.env.CHAT_COLUMN_WEB ?? "http://localhost:3411";
const SLUG = process.env.CHAT_COLUMN_SLUG ?? "local";
const TOKEN = process.env.CHAT_COLUMN_TOKEN ?? "";
const CHAT = process.env.CHAT_COLUMN_CHAT ?? "";
const PANES = (process.env.CHAT_COLUMN_PANES ?? "1000,1200,1400,1600,1920").split(",").map(Number);
const HEIGHT = 900;
if (!TOKEN || !CHAT) throw new Error("CHAT_COLUMN_TOKEN and CHAT_COLUMN_CHAT are required");

const SCROLLBARS = process.env.CHAT_COLUMN_SCROLLBARS === "1";
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_COLUMN_CHROME });

type Layout = {
  viewport: number; pane: number | null;
  column: number; textL: number; textR: number; composerL: number; composerR: number;
  composerColumn: number; bubbleR: number | null; scrollbar: number;
  /** `data-perf-state` of the log; `ready-forced` would mean the reveal hit its budget. */
  state: string | null;
  /** Distance from the end of the log; the opened chat is pinned there. */
  bottomGap: number;
  /** Largest movement of the scroll position or the last row over 60 frames. */
  drift: number;
  /** Rows whose cached `min-height` is taller than their content: a height reused from another width. */
  overReserved: number;
  /** Rows rendered with a cached `min-height` at all. */
  reserved: number;
};

async function open(sidebarOpen: boolean, width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT } });
  await context.addCookies([
    { name: "multimira_auth", value: TOKEN, url: WEB },
    { name: "multimira_logged_in", value: "1", url: WEB },
    { name: "sidebar_state", value: String(sidebarOpen), url: WEB },
  ]);
  await context.addInitScript((token) => { localStorage.setItem("multimira_token", token); }, TOKEN);
  const page = await context.newPage();
  await page.goto(`${WEB}/${SLUG}/chat?session=${CHAT}`, { timeout: 180_000 });
  await page.waitForSelector('[data-perf-scroll="session-log"][data-perf-state^="ready"]', { timeout: 120_000 });
  await page.waitForSelector("[data-chat-composer]");
  // A styled scrollbar always takes its width, like Windows' and Linux's.
  if (SCROLLBARS) await page.addStyleTag({ content: "[data-session-log-scroll]{scrollbar-width:auto!important;scrollbar-color:auto!important}[data-session-log-scroll]::-webkit-scrollbar{width:15px;background:#ddd}" });
  await settle(page);
  return page;
}

/**
 * Waits until the log's box, content and position have not changed for 1s:
 * presence answering late adds the offline banner above the composer, which
 * shortens the list (the pinned log follows it), and that is not what is
 * being measured.
 */
function settle(page: Page): Promise<void> {
  return page.evaluate(() => new Promise<void>((resolve) => {
    const scroll = document.querySelector<HTMLElement>("[data-session-log-scroll]")!;
    const sign = () => [scroll.clientHeight, scroll.clientWidth, scroll.scrollHeight, scroll.scrollTop,
      (scroll.firstElementChild as HTMLElement).getBoundingClientRect().width].join(",");
    let last = sign();
    let quiet = 0;
    const deadline = performance.now() + 10_000;
    const poll = setInterval(() => {
      const next = sign();
      quiet = next === last ? quiet + 1 : 0;
      last = next;
      if (quiet >= 10 || performance.now() > deadline) { clearInterval(poll); resolve(); }
    }, 100);
  }));
}

async function read(page: Page): Promise<Layout> {
  const drift = await page.evaluate(() => new Promise<number>((resolve) => {
    const scroll = document.querySelector<HTMLElement>("[data-session-log-scroll]")!;
    const last = () => [...scroll.querySelectorAll<HTMLElement>("[data-perf-item]")].at(-1)?.getBoundingClientRect().top ?? 0;
    const start = { top: scroll.scrollTop, row: last() };
    let max = 0;
    let frames = 0;
    const tick = () => {
      max = Math.max(max, Math.abs(scroll.scrollTop - start.top), Math.abs(last() - start.row));
      if (++frames < 60) requestAnimationFrame(tick); else resolve(max);
    };
    requestAnimationFrame(tick);
  }));
  const layout = await page.evaluate(() => {
    const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;
    const pane = document.querySelector('[data-panel][id="conversation"] > div');
    const scroll = document.querySelector<HTMLElement>("[data-session-log-scroll]")!;
    const column = scroll.firstElementChild as HTMLElement;
    const style = getComputedStyle(column);
    const box = column.getBoundingClientRect();
    const composer = document.querySelector<HTMLElement>("[data-chat-composer]")!;
    const bubbles = [...column.querySelectorAll<HTMLElement>(".rounded-\\[22px\\]")];
    return {
      viewport: window.innerWidth,
      pane: rect(pane)?.width ?? null,
      column: box.width,
      textL: box.left + parseFloat(style.paddingLeft),
      textR: box.right - parseFloat(style.paddingRight),
      composerL: composer.getBoundingClientRect().left,
      composerR: composer.getBoundingClientRect().right,
      composerColumn: composer.parentElement!.getBoundingClientRect().width,
      bubbleR: bubbles.length ? bubbles[bubbles.length - 1]!.getBoundingClientRect().right : null,
      scrollbar: scroll.offsetWidth - scroll.clientWidth,
      state: document.querySelector<HTMLElement>('[data-perf-scroll="session-log"]')?.dataset.perfState ?? null,
      bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      reserved: column.querySelectorAll('[data-perf-item][style*="min-height"]').length,
      overReserved: [...column.querySelectorAll<HTMLElement>('[data-perf-item][style*="min-height"]')].filter((row) => {
        const content = [...row.children].reduce((sum, child) => sum + child.getBoundingClientRect().height, 0)
          + parseFloat(getComputedStyle(row).paddingBottom);
        return parseFloat(row.style.minHeight) - content > 1;
      }).length,
    };
  });
  return { ...layout, drift } as Layout;
}

const r = (n: number | null) => n === null ? "-" : Number(n.toFixed(2)).toString();
function row(label: string, l: Layout): string {
  const dL = l.composerL - l.textL;
  const dR = l.composerR - l.textR;
  const bubble = l.bubbleR === null ? "-" : r(l.bubbleR - l.textR);
  return `${label.padEnd(26)} viewport=${String(l.viewport).padStart(4)} pane=${r(l.pane).padStart(7)} column=${r(l.column).padStart(6)}`
    + ` text=${r(l.textR - l.textL).padStart(6)} composerColumn=${r(l.composerColumn).padStart(6)}`
    + ` dL=${r(dL)} dR=${r(dR)} bubbleR-textR=${bubble} scrollbar=${l.scrollbar}`
    + ` state=${l.state} bottomGap=${r(l.bottomGap)} drift=${r(l.drift)} reserved=${l.reserved} overReserved=${l.overReserved}`;
}

const failures: string[] = [];
const edgesOk = (l: Layout) => Math.abs(l.composerL - l.textL) <= 0.5 && Math.abs(l.composerR - l.textR) <= 0.5
  && Math.abs(l.column - l.composerColumn) <= 0.5 && l.state === "ready" && l.bottomGap <= 1 && l.drift <= 1 && l.overReserved === 0;
const expected = (pane: number) => Math.min(960, Math.max(768, 0.64 * pane));

for (const sidebarOpen of [true, false]) {
  // Learn how much the sidebar and the chat list take at this setting.
  const probe = await open(sidebarOpen, 1600);
  const chrome = 1600 - (await read(probe)).pane!;
  await probe.context().close();
  for (const target of PANES) {
    const page = await open(sidebarOpen, target + chrome);
    const layout = await read(page);
    const label = `sidebar=${sidebarOpen ? "open" : "collapsed"} pane~${target}`;
    process.stdout.write(`${row(label, layout)}\n`);
    const want = Math.min(layout.pane! - layout.scrollbar * 2, expected(layout.pane!));
    if (!edgesOk(layout) || Math.abs(layout.column - want) > 0.5) failures.push(label);
    await page.context().close();
  }
}

// Resizing the window across the range reflows the rows; the pinned log stays at its end.
{
  const page = await open(true, 1600);
  const chrome = 1600 - (await read(page)).pane!;
  for (const pane of [1200, 1600, 1400, 1200]) {
    await page.setViewportSize({ width: pane + chrome, height: HEIGHT });
    await settle(page);
    const layout = await read(page);
    process.stdout.write(`${row(`resize to pane ${pane}`, layout)}\n`);
    if (!edgesOk(layout) || Math.abs(layout.column - expected(layout.pane!)) > 0.5) failures.push(`resize ${pane}`);
  }
  await page.context().close();
}

// Subagent split: the conversation pane narrows; the column follows the pane.
{
  const page = await open(false, 1920);
  const before = await read(page);
  await page.evaluate((chat) => {
    const node = document.querySelector("[data-session-log-scroll]") as unknown as Record<string, unknown>;
    const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"))!;
    type Fiber = { memoizedProps?: Record<string, unknown>; return: Fiber | null };
    let fiber = node[key] as Fiber | null;
    while (fiber && typeof fiber.memoizedProps?.resolveChat !== "function") fiber = fiber.return;
    const resolve = fiber!.memoizedProps!.resolveChat as (id: string) => { open: () => void } | null;
    resolve(chat)!.open();
  }, CHAT);
  await page.waitForSelector('[data-subagent-panel-mode="split"]', { timeout: 10_000 });
  await settle(page);
  const split = await read(page);
  process.stdout.write(`${row("split: before", before)}\n${row("split: panel open", split)}\n`);
  if (!edgesOk(split) || Math.abs(split.column - expected(split.pane!)) > 0.5) failures.push("split");
  await page.context().close();
}

// Floating window, expanded on a wide viewport: stays 768px. The chat page
// stored the active chat; the window opens over the issues page.
{
  const page = await open(true, 1920);
  await page.evaluate(() => localStorage.setItem("multimira:chat:isOpen", "true"));
  await page.goto(`${WEB}/${SLUG}/issues`, { timeout: 180_000 });
  await page.waitForSelector("[data-floating-chat-window] [data-session-log-scroll]", { timeout: 120_000 });
  const expand = page.locator('[data-floating-chat-window] button:has(svg[class*="maximize"])');
  if (await expand.count()) await expand.first().click();
  await page.waitForTimeout(800);
  const floating = await page.evaluate(() => {
    const win = document.querySelector<HTMLElement>("[data-floating-chat-window]")!;
    const column = win.querySelector<HTMLElement>("[data-session-log-scroll]")!.firstElementChild as HTMLElement;
    const composer = win.querySelector<HTMLElement>("[data-chat-composer]")!;
    return { window: win.getBoundingClientRect().width, column: column.getBoundingClientRect().width,
      composerColumn: composer.parentElement!.getBoundingClientRect().width };
  });
  process.stdout.write(`floating expanded          window=${r(floating.window)} column=${r(floating.column)} composerColumn=${r(floating.composerColumn)}\n`);
  if (floating.window < 1200 || floating.column !== 768 || floating.composerColumn !== 768) failures.push("floating");
  await page.context().close();
}

// Mobile: fills the width with the 16px padding.
{
  const page = await open(true, 390);
  const mobile = await read(page);
  process.stdout.write(`${row("mobile 390", mobile)}\n`);
  // Below 800px a space-taking scrollbar narrows only the list (as before), so
  // the edges are compared with overlay scrollbars only.
  if ((!SCROLLBARS && !edgesOk(mobile)) || mobile.composerColumn !== 390) failures.push("mobile");
  await page.context().close();
}

await browser.close();
process.stdout.write(failures.length ? `FAIL ${failures.join(", ")}\n` : "PASS\n");
process.exit(failures.length ? 1 : 0);
