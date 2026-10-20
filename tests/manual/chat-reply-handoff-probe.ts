#!/usr/bin/env bun
/**
 * Records, per animation frame, whether a Chat reply is on screen while its
 * turn ends: from the live view (`[data-chat-live-final]`) through the
 * persisted reply row landing in the log. Run it against
 * chat-switch-harness.ts with CHAT_SWITCH_AGENT_MS (the fake agent completes
 * each turn with a Markdown reply) and a web server built against that API.
 *
 *   CHAT_PROBE_TOKEN=... bun run tests/manual/chat-reply-handoff-probe.ts
 *
 * The fake agent writes no trace, so the probe answers the page's live trace
 * read (`GET /api/turns/:id/trace`) itself: a running turn with one command
 * and a final reply that already holds the marker text the persisted reply
 * also contains ("The change touches three places"), tagged `#k` for the k-th
 * attempt the page read. The trace socket stays the real one.
 *
 * For each turn k of a run it reports the frames where neither the live reply
 * #k nor the k-th persisted reply after the sent message is on screen, between
 * the last live frame and the first persisted one (`blank`), frames that show
 * both (`dup`), and persisted replies that vanish again after showing (`drop`).
 * With CHAT_PROBE_STOP_AT_MS the turn is stopped instead, and the outcome is
 * its notice row (`[data-turn-notice]`) against the live turn view.
 *
 * Env:
 *   CHAT_PROBE_WEB         web origin (default http://localhost:3391)
 *   CHAT_PROBE_SLUG        workspace slug (default local)
 *   CHAT_PROBE_HOST_MAP    resolve this host name to 127.0.0.1 (e.g. chathandoff.test, with WEB
 *                          http://chathandoff.test:3391): an insecure origin, so the log replica
 *                          runs in per-tab memory as on a plain-HTTP deployment
 *   CHAT_PROBE_CHROME      Chromium executable
 *   CHAT_PROBE_SESSION     send in this chat; empty starts a new chat each run
 *   CHAT_PROBE_RUNS        sends, each in a freshly loaded page (default 3)
 *   CHAT_PROBE_LATENCY     added request latency in ms (CDP)
 *   CHAT_PROBE_QUEUE_AT_MS queue a follow-up this long after the send (released when the turn ends)
 *   CHAT_PROBE_STOP_AT_MS  stop the turn this long after the send
 *   CHAT_PROBE_WATCH_MS    stop watching this long after the last outcome lands (default 3000)
 *   CHAT_PROBE_TIMEOUT_MS  give a run up this long after the send (default 60000)
 *   CHAT_PROBE_OUT         write every run's frames as JSON here
 */
import { chromium } from "playwright-core";

const WEB = process.env.CHAT_PROBE_WEB ?? "http://localhost:3391";
const SLUG = process.env.CHAT_PROBE_SLUG ?? "local";
const TOKEN = process.env.CHAT_PROBE_TOKEN ?? "";
const SESSION = process.env.CHAT_PROBE_SESSION ?? "";
const RUNS = Number(process.env.CHAT_PROBE_RUNS ?? 3);
const LATENCY = Number(process.env.CHAT_PROBE_LATENCY ?? 0);
const QUEUE_AT = Number(process.env.CHAT_PROBE_QUEUE_AT_MS ?? 0);
const STOP_AT = Number(process.env.CHAT_PROBE_STOP_AT_MS ?? 0);
const WATCH_MS = Number(process.env.CHAT_PROBE_WATCH_MS ?? 3000);
const TIMEOUT_MS = Number(process.env.CHAT_PROBE_TIMEOUT_MS ?? 60_000);
const OUT = process.env.CHAT_PROBE_OUT ?? "";
const HOST_MAP = process.env.CHAT_PROBE_HOST_MAP ?? "";
const MARK = "The change touches three places";
if (!TOKEN) throw new Error("CHAT_PROBE_TOKEN is required");

const finalText = (k: number) => [
  `Here is what I found (live #${k}). ${MARK}:`, "",
  "1. `packages/core/session-log/issue-log.ts` — the replica window",
  "2. `packages/views/chat/components/chat-window.tsx` — the page shell",
  "3. `packages/views/common/session-log/session-log-list.tsx` — reveal", "",
  "filler sentence so the row wraps over several lines in the reading column. ".repeat(4),
].join("\n");

/** A running turn's `view=turn` page: one command, then the final reply. */
function tracePage(attemptId: string, turnId: string | null, k: number) {
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const command = { id: "cmd_1", parent_id: null, status: "completed", started_at: iso(2000), completed_at: iso(1900),
    type: "command", tool: "Bash", source: "shell", command: "cat issue-log.ts", cwd: null,
    actions: [{ type: "read", command: "cat issue-log.ts", name: "issue-log.ts", path: "issue-log.ts" }],
    output: null, exit_code: 0, duration_ms: 100 };
  const final = { id: "final_1", parent_id: null, status: "completed", started_at: iso(1000), completed_at: iso(900),
    type: "agent_message", text: finalText(k), phase: "final" };
  const turn = { id: attemptId, turn_id: turnId, agent_id: "agent", agent_name: "Switch Perf Agent", provider: "codex",
    requested_model: null, model: null, status: "running", error: null, started_at: iso(3000), completed_at: null,
    duration_ms: null, final_item_id: "final_1", final_started_at: iso(1000), context_usage: null,
    stats: { item_count: 2, tool_call_count: 1, process_item_count: 1, type_histogram: [] } };
  return { view: "turn", format: "v2", turn, items: STOP_AT > 0 ? [command] : [command, final],
    next_item_cursor: null, head: 3, closed: false, state: "ok", source: "daemon" };
}

type Frame = { t: number; lives: number[]; mounted: number[]; live: boolean; rows: number; notices: number; running: boolean };
type RunResult = { run: number; sentAt: number; doneAt: number[]; frames: Frame[]; secure: boolean };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_PROBE_CHROME,
  args: HOST_MAP ? [`--host-resolver-rules=MAP ${HOST_MAP} 127.0.0.1`] : [] });
const results: RunResult[] = [];
for (let run = 1; run <= RUNS; run++) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "multimira_auth", value: TOKEN, url: WEB }]);
  const attempts = new Map<string, number>();
  await context.route(/\/api\/turns\/[^/]+\/trace\?/, async (route) => {
    const url = new URL(route.request().url());
    const pathId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const attemptId = url.searchParams.get("attempt_id") ?? pathId;
    if (!attempts.has(attemptId)) attempts.set(attemptId, attempts.size + 1);
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(tracePage(attemptId, url.searchParams.get("attempt_id") ? pathId : null, attempts.get(attemptId)!)) });
  });
  await context.addInitScript(({ token, mark }) => {
    localStorage.setItem("multimira_token", token);
    const w = window as unknown as { __frames: unknown[]; __done: number[]; __sent: string | null; __recording: boolean };
    w.__frames = []; w.__done = []; w.__sent = null; w.__recording = false;
    // Lifecycle events that settle the pending turn, timed in page time.
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args) {
        const socket = new target(...(args as [string]));
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string" && /"type":"(chat:done|task:cancelled|task:failed)"/.test(event.data)) w.__done.push(performance.now());
        });
        return socket;
      },
    });
    const onScreen = (element: Element, root: DOMRect) => {
      const rect = element.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= root.top || rect.top >= root.bottom) return false;
      return (element as HTMLElement).checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;
    };
    const tick = () => {
      const scroll = document.querySelector<HTMLElement>('[data-perf-scroll="session-log"]');
      if (w.__recording && scroll) {
        const root = scroll.getBoundingClientRect();
        const finals = [...document.querySelectorAll("[data-chat-live-final]")].filter(element => element.textContent?.includes(mark));
        const tag = (element: Element) => Number(/live #(\d+)/.exec(element.textContent ?? "")?.[1] ?? 0);
        const lives = finals.filter(element => onScreen(element, root)).map(tag);
        const rows = [...scroll.querySelectorAll<HTMLElement>('[data-perf-item="message"]')];
        const sentIndex = w.__sent ? rows.findIndex(row => row.textContent?.includes(w.__sent!)) : -1;
        const after = sentIndex < 0 ? [] : rows.slice(sentIndex + 1).filter(row => onScreen(row, root));
        w.__frames.push({
          // `mounted`: live replies in the DOM, on screen or not (a pinned list can scroll a frame late).
          t: Math.round(performance.now()), lives, mounted: finals.map(tag),
          live: [...document.querySelectorAll("[data-chat-live-turn]")].some(element => onScreen(element, root)),
          rows: after.filter(row => row.textContent?.includes(mark)).length,
          notices: after.filter(row => row.querySelector("[data-turn-notice]")).length,
          running: !!document.querySelector('[data-chat-composer] button[aria-label="Stop"]'),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { token: TOKEN, mark: MARK });
  const page = await context.newPage();
  if (LATENCY > 0) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
  }
  await page.goto(`${WEB}/${SLUG}/chat${SESSION ? `?session=${SESSION}` : ""}`);
  await page.waitForSelector('[data-chat-composer] [contenteditable="true"]', { timeout: 60_000 });
  const secure = await page.evaluate(() => isSecureContext);
  await page.waitForTimeout(2000);
  const sent = `handoff probe ${run} ${Date.now().toString(36)}`;
  await page.evaluate((text) => {
    const w = window as unknown as { __sent: string; __recording: boolean };
    w.__sent = text; w.__recording = true;
  }, sent);
  await page.click('[data-chat-composer] [contenteditable="true"]');
  await page.keyboard.type(sent);
  const sentAt = await page.evaluate(() => performance.now());
  await page.keyboard.press("ControlOrMeta+Enter");
  const turns = QUEUE_AT > 0 ? 2 : 1;
  const started = Date.now();
  if (QUEUE_AT > 0) {
    await page.waitForTimeout(QUEUE_AT);
    await page.click('[data-chat-composer] [contenteditable="true"]');
    await page.keyboard.type(`queued follow-up ${run}`);
    await page.keyboard.press("ControlOrMeta+Enter");
  }
  if (STOP_AT > 0) {
    await page.waitForTimeout(STOP_AT);
    await page.click('[data-chat-composer] button[aria-label="Stop"]');
  }
  // Watch until every turn's outcome has stayed on screen for WATCH_MS.
  let landedAt = 0;
  while (Date.now() - started < TIMEOUT_MS) {
    await page.waitForTimeout(250);
    const last = await page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames.at(-1) ?? null);
    const landed = !!last && (STOP_AT > 0 ? last.notices >= 1 : last.rows >= turns);
    if (!landed) { landedAt = 0; continue; }
    landedAt ||= Date.now();
    if (Date.now() - landedAt >= WATCH_MS) break;
  }
  const { frames, done } = await page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __done: number[] };
    return { frames: w.__frames, done: w.__done };
  });
  results.push({ run, sentAt, doneAt: done, frames, secure });
  await context.close();
}
await browser.close();
if (OUT) await Bun.write(OUT, JSON.stringify(results, null, 1));

/** Turn k's handoff: its live view, then its persisted outcome. */
function analyse(frames: Frame[], k: number) {
  const shownLive = (f: Frame) => (STOP_AT > 0 ? f.live : f.lives.includes(k));
  const shownRow = (f: Frame) => (STOP_AT > 0 ? f.notices >= 1 : f.rows >= k);
  const first = frames.findIndex(shownRow);
  if (first < 0) return { k, landed: false };
  let last = -1;
  for (let i = first; i >= 0; i--) if (shownLive(frames[i]!)) { last = i; break; }
  const gap = last < 0 ? [] : frames.slice(last + 1, first).filter(f => !shownLive(f) && !shownRow(f));
  const dup = frames.filter(f => shownLive(f) && shownRow(f)).length;
  const drop = frames.slice(first).filter(f => !shownRow(f)).length;
  return {
    k, landed: true, sawLive: last >= 0, blankFrames: gap.length,
    blankMs: gap.length ? frames[first]!.t - gap[0]!.t : 0, dupFrames: dup, dropFrames: drop,
    lastLiveT: last >= 0 ? frames[last]!.t : null, firstRowT: frames[first]!.t,
  };
}
for (const result of results) {
  const turns = QUEUE_AT > 0 ? [1, 2] : [1];
  for (const k of turns) {
    const report = analyse(result.frames, k);
    // The settling event the outcome followed: the last one before it landed.
    const firstRowT = (report as { firstRowT?: number }).firstRowT;
    const done = firstRowT === undefined ? undefined : result.doneAt.filter(t => t <= firstRowT).at(-1);
    process.stdout.write(`${JSON.stringify({ run: result.run, secure: result.secure, frames: result.frames.length,
      settleToRowMs: done !== undefined && firstRowT !== undefined ? Math.round(firstRowT - done) : null, ...report })}\n`);
  }
}
