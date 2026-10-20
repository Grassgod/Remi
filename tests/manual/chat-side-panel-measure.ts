#!/usr/bin/env bun
/**
 * Records the Chat side panel (子代理 / 后台任务) opening and closing in
 * headless Chromium against chat-switch-harness.ts started with
 * CHAT_SWITCH_SUBAGENTS=1.
 *
 *   CHAT_PANEL_TOKEN=... CHAT_PANEL_CHAT=<first chat id> bun run tests/manual/chat-side-panel-measure.ts
 *
 * For each open and close through the header toggle it records every
 * animation frame: the drawer's width (page split) or the overlay's offset
 * (floating window), the conversation's distance from its bottom and its
 * column width, plus long tasks and long animation frames. It reports frame
 * intervals, how long each change took to settle, and whether the
 * conversation stayed pinned. The harness writes no traces, so the script
 * answers the panel's trace reads (`GET /api/turns/:id/trace`) with a
 * finished turn that ran three subagents.
 *
 * Env:
 *   CHAT_PANEL_WEB      web origin (default http://localhost:3421)
 *   CHAT_PANEL_SLUG     workspace slug (default local)
 *   CHAT_PANEL_ROUNDS   open/close cycles per scenario (default 3)
 *   CHAT_PANEL_CPU      CPU throttling rate (default 1)
 *   CHAT_PANEL_SHOTS    directory for header and panel screenshots (default: none)
 *   CHAT_PANEL_CHROME   Chromium executable (default: Playwright's own)
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";

const WEB = process.env.CHAT_PANEL_WEB ?? "http://localhost:3421";
const SLUG = process.env.CHAT_PANEL_SLUG ?? "local";
const TOKEN = process.env.CHAT_PANEL_TOKEN ?? "";
const CHAT = process.env.CHAT_PANEL_CHAT ?? "";
const ROUNDS = Number(process.env.CHAT_PANEL_ROUNDS ?? 3);
const CPU = Number(process.env.CHAT_PANEL_CPU ?? 1);
const SHOTS = process.env.CHAT_PANEL_SHOTS ?? "";
if (!TOKEN || !CHAT) throw new Error("CHAT_PANEL_TOKEN and CHAT_PANEL_CHAT are required");

/** A finished turn that ran three subagents, as a daemon's `view=turn` page. */
function tracePage(attemptId: string, turnId: string | null) {
  const base = Date.now() - 10 * 60_000;
  const iso = (seconds: number) => new Date(base + seconds * 1000).toISOString();
  const done = (id: string, start: number, end: number) => ({ id, status: "completed", started_at: iso(start), completed_at: iso(end) });
  const items: Record<string, unknown>[] = [
    { ...done("in:1", 0, 0), parent_id: null, type: "user_message", origin: "input", text: "审阅一下飞书步骤文案的改动", message_ids: [], attachments: [], steer: null },
  ];
  const agents = [["sa:review", "审阅文案差异", "Explore"], ["sa:plan", "列出回归测试清单", "Plan"], ["sa:check", "核对翻译", "general-purpose"]] as const;
  agents.forEach(([id, name, type], index) => {
    items.push({ ...done(id, 1 + index, 30 + index * 5), parent_id: null, type: "subagent", tool: "Agent", title: name, name, agent_type: type,
      background: index === 0, model: "haiku", thread_id: null, prompt: `${name}：看看 \`chat.json\` 的改动。`, output: `${name}完成。`, duration_ms: (29 + index * 4) * 1000 });
    for (let step = 0; step < 4; step++) {
      items.push({ ...done(`${id}:cmd${step}`, 2 + index + step, 3 + index + step), parent_id: id, type: "command", tool: "Bash", source: "shell",
        command: `cat locales/${["zh-Hans", "en", "ja", "ko"][step]}/chat.json`, cwd: null,
        actions: [{ type: "read", command: "cat chat.json", name: "chat.json", path: "chat.json" }], output: null, exit_code: 0, duration_ms: 40 });
    }
    items.push({ ...done(`${id}:reply`, 28 + index * 5, 29 + index * 5), parent_id: id, type: "agent_message", text: `${name}：结论见上。`, phase: "final" });
  });
  items.push({ ...done("final", 45, 48), parent_id: null, type: "agent_message", text: "审阅完了。", phase: "final" });
  const turn = { id: attemptId, turn_id: turnId, agent_id: "agent", agent_name: "Switch Perf Agent", provider: "claude",
    requested_model: null, model: null, status: "completed", error: null, started_at: iso(0), completed_at: iso(48),
    duration_ms: 48_000, final_item_id: "final", final_started_at: iso(45), context_usage: null,
    stats: { item_count: items.length, tool_call_count: 12, process_item_count: 3, type_histogram: [] } };
  return { view: "turn", format: "v2", turn, items, next_item_cursor: null, head: items.length + 1, closed: true, state: "ok", source: "daemon" };
}

type Frame = { t: number; drawer: number | null; overlay: number | null; gap: number | null; column: number | null; stick: string | null; button: boolean; panel: boolean };
type Recording = { frames: Frame[]; longTasks: number[]; loafs: number[]; clickAt: number };

async function openContext(reducedMotion: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await context.addCookies([{ name: "multimira_auth", value: TOKEN, url: WEB }]);
  await context.route(/\/api\/turns\/[^/]+\/trace\?/, async (route) => {
    const url = new URL(route.request().url());
    const pathId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const attemptId = url.searchParams.get("attempt_id") ?? pathId;
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(tracePage(attemptId, url.searchParams.get("attempt_id") ? pathId : null)) });
  });
  await context.addInitScript((token) => {
    localStorage.setItem("multimira_token", token);
    const w = window as unknown as Record<string, unknown>;
    w.__startRecording = () => {
      const frames: Frame[] = [];
      const longTasks: number[] = [];
      const loafs: number[] = [];
      const observers: PerformanceObserver[] = [];
      for (const [type, sink] of [["longtask", longTasks], ["long-animation-frame", loafs]] as const) {
        try {
          const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) sink.push(Math.round(entry.duration)); });
          observer.observe({ type, buffered: false });
          observers.push(observer);
        } catch { /* not supported */ }
      }
      let running = true;
      // Sampled in a task the frame's rAF queues, which runs after that frame
      // rendered: the layout read is what was painted, after the list's own
      // ResizeObserver compensation, not the state before it.
      const channel = new MessageChannel();
      let frameTime = 0;
      channel.port1.onmessage = () => sample(frameTime);
      const tick = (t: number) => {
        if (!running) return;
        frameTime = t;
        channel.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      const sample = (t: number) => {
        const scroll = document.querySelector<HTMLElement>("[data-session-log-scroll]");
        const drawer = document.querySelector<HTMLElement>("[data-subagent-panel-drawer]");
        const overlay = document.querySelector<HTMLElement>('[data-subagent-panel-mode="overlay"]');
        const host = overlay?.parentElement?.getBoundingClientRect();
        frames.push({
          t,
          drawer: drawer ? Math.round(drawer.getBoundingClientRect().width * 10) / 10 : null,
          overlay: overlay && host ? Math.round((overlay.getBoundingClientRect().left - host.left) * 10) / 10 : null,
          gap: scroll ? Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) : null,
          column: scroll?.firstElementChild ? Math.round((scroll.firstElementChild as HTMLElement).getBoundingClientRect().width) : null,
          stick: scroll?.dataset.stickState ?? null,
          button: !!document.querySelector("[data-session-log-scroll-bottom]"),
          panel: !!document.querySelector("[data-subagent-panel]"),
        });
      };
      requestAnimationFrame(tick);
      w.__stopRecording = () => {
        running = false;
        for (const observer of observers) observer.disconnect();
        return { frames, longTasks, loafs };
      };
    };
  }, TOKEN);
  const page = await context.newPage();
  if (CPU > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: CPU });
  return { context, page };
}

/** Clicks the toggle and records frames until `settled` holds for 300ms (or 4s pass). */
async function record(page: Page, toggle: string, settled: string): Promise<Recording> {
  return page.evaluate(async ({ toggle, settled }) => {
    const w = window as unknown as Record<string, () => { frames: Frame[]; longTasks: number[]; loafs: number[] }>;
    w.__startRecording!();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const clickAt = performance.now();
    document.querySelector<HTMLElement>(toggle)!.click();
    const done = new Function(`return (${settled})`) as () => boolean;
    let since: number | null = null;
    await new Promise<void>((resolve) => {
      const check = () => {
        const now = performance.now();
        if (done()) since ??= now; else since = null;
        if ((since !== null && now - since >= 300) || now - clickAt > 4000) resolve();
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    const result = w.__stopRecording!();
    return { ...result, clickAt };
  }, { toggle, settled });
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : NaN;
};

/** The frames of one change: when it settled, frame intervals, the conversation's pinning. */
function summarize(label: string, recording: Recording, value: (frame: Frame) => number | null, final: number | null) {
  const frames = recording.frames.filter((frame) => frame.t >= recording.clickAt);
  const intervals = frames.slice(1).map((frame, index) => frame.t - frames[index]!.t);
  const settledAt = frames.findIndex((frame, index) => frames.slice(index).every((later) => value(later) === final));
  const moving = settledAt > 0 ? frames.slice(0, settledAt + 1) : frames;
  const movingIntervals = moving.slice(1).map((frame, index) => frame.t - moving[index]!.t);
  const columns = new Set(frames.map((frame) => frame.column));
  return {
    label,
    settle_ms: settledAt >= 0 ? Math.round(frames[settledAt]!.t - recording.clickAt) : null,
    moving_frames: moving.length,
    frame_p50: Math.round(percentile(movingIntervals, 0.5) * 10) / 10,
    frame_p95: Math.round(percentile(movingIntervals, 0.95) * 10) / 10,
    frame_max: Math.round(Math.max(0, ...intervals) * 10) / 10,
    over_25ms: movingIntervals.filter((interval) => interval > 25).length,
    long_tasks: recording.longTasks,
    long_frames: recording.loafs,
    gap_max: Math.max(...frames.map((frame) => frame.gap ?? 0)),
    gap_end: frames.at(-1)?.gap ?? null,
    stick: [...new Set(frames.map((frame) => frame.stick))].join("/"),
    stick_end: frames.at(-1)?.stick ?? null,
    button_frames: frames.filter((frame) => frame.button).length,
    columns: columns.size,
    column_first: frames[0]?.column ?? null,
    column_last: frames.at(-1)?.column ?? null,
    path: moving.map((frame) => value(frame)).filter((v) => v !== null).slice(0, 40).join(","),
  };
}

const PAGE_TOGGLE = '[data-side-panel-toggle="chat-side-panel-page"]';
const WINDOW_TOGGLE = '[data-side-panel-toggle="chat-side-panel-window"]';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_PANEL_CHROME });
const out = { push: (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`) };

async function pageSplit(reducedMotion: boolean) {
  const { context, page } = await openContext(reducedMotion);
  await page.goto(`${WEB}/${SLUG}/chat?session=${CHAT}`);
  await page.waitForSelector('[data-perf-scroll="session-log"][data-perf-state^="ready"]', { timeout: 60_000 });
  await page.waitForSelector(PAGE_TOGGLE, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const toggle = page.locator(PAGE_TOGGLE);
  out.push({ scenario: "page", reducedMotion, label: await toggle.getAttribute("aria-label"), badge: await toggle.locator("[data-side-panel-badge]").textContent().catch(() => null) });
  if (SHOTS && !reducedMotion) {
    await page.locator("[data-chat-page-header]").screenshot({ path: `${SHOTS}/page-header.png` });
  }
  for (let round = 1; round <= ROUNDS; round++) {
    const opened = await record(page, PAGE_TOGGLE, `(document.querySelector("[data-subagent-panel-drawer]")?.getBoundingClientRect().width ?? 0) >= 399.5`);
    out.push({ scenario: "page", reducedMotion, round, ...summarize("open", opened, (frame) => frame.drawer, 400) });
    if (SHOTS && round === 1 && !reducedMotion) await page.screenshot({ path: `${SHOTS}/page-open.png` });
    const closed = await record(page, PAGE_TOGGLE, `!document.querySelector("[data-subagent-panel-drawer]")`);
    out.push({ scenario: "page", reducedMotion, round, ...summarize("close", closed, (frame) => frame.drawer, null) });
  }
  // Esc inside the panel closes it and gives focus back to the toggle.
  await page.locator(PAGE_TOGGLE).click();
  await page.waitForSelector("[data-subagent-panel]");
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-subagent-panel-drawer]", { state: "detached", timeout: 3000 });
  out.push({ scenario: "page", reducedMotion, escape_focus_on_toggle: await page.evaluate((selector) => document.activeElement === document.querySelector(selector), PAGE_TOGGLE) });
  await context.close();
}

async function floatingWindow() {
  const { context, page } = await openContext(false);
  // The chat page makes this chat the active one; the window on another page opens it.
  await page.goto(`${WEB}/${SLUG}/chat?session=${CHAT}`);
  await page.waitForSelector('[data-perf-scroll="session-log"][data-perf-state^="ready"]', { timeout: 60_000 });
  await page.goto(`${WEB}/${SLUG}/issues`);
  await page.waitForTimeout(2000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/issues.png` });
  // The window remembers whether it was open; otherwise the FAB opens it.
  if (!await page.locator(WINDOW_TOGGLE).isVisible().catch(() => false)) {
    await page.locator('button[class*="bottom-2"][class*="right-2"]').first().click({ timeout: 30_000 });
  }
  await page.waitForSelector(WINDOW_TOGGLE, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const toggle = page.locator(WINDOW_TOGGLE);
  out.push({ scenario: "window", label: await toggle.getAttribute("aria-label"), badge: await toggle.locator("[data-side-panel-badge]").textContent().catch(() => null) });
  if (SHOTS) {
    const box = await page.locator("[data-floating-chat-window]").boundingBox();
    if (box) await page.screenshot({ path: `${SHOTS}/window-header.png`, clip: { x: box.x, y: box.y, width: box.width, height: 56 } });
  }
  for (let round = 1; round <= ROUNDS; round++) {
    const opened = await record(page, WINDOW_TOGGLE, `(() => { const o = document.querySelector('[data-subagent-panel-mode="overlay"]'); return !!o && Math.abs(o.getBoundingClientRect().left - o.parentElement.getBoundingClientRect().left) < 0.5; })()`);
    out.push({ scenario: "window", round, ...summarize("open", opened, (frame) => frame.overlay, 0) });
    if (SHOTS && round === 1) {
      const box = await page.locator("[data-floating-chat-window]").boundingBox();
      if (box) await page.screenshot({ path: `${SHOTS}/window-open.png`, clip: box });
    }
    // The overlay covers the header toggle: close with × as a reader would.
    const closed = await record(page, '[data-subagent-panel-mode="overlay"] [data-subagent-panel-close]', `!document.querySelector('[data-subagent-panel-mode="overlay"]')`);
    out.push({ scenario: "window", round, ...summarize("close", closed, (frame) => frame.overlay, null) });
    out.push({ scenario: "window", round, focus_on_toggle: await page.evaluate((selector) => document.activeElement === document.querySelector(selector), WINDOW_TOGGLE) });
  }
  await context.close();
}

await pageSplit(false);
await pageSplit(true);
await floatingWindow();

process.stdout.write(`cpu=${CPU}x rounds=${ROUNDS}\n`);
await browser.close();
