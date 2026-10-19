#!/usr/bin/env bun
/**
 * Sends a Chat message in headless Chromium against chat-switch-harness.ts (run
 * with CHAT_SWITCH_AGENT_MS so turns get a reply) and records, per animation
 * frame, the log rows on screen (`data-perf-key`), whether the composer shows
 * its stop button and the live turn view, every WebSocket frame and every
 * `GET /api/sessions/:id/log` with the entries it returned. Written to check
 * that a reply's rows stay on screen after it lands.
 *
 *   CHAT_PROBE_TOKEN=... bun run tests/manual/chat-send-rows-probe.ts
 *
 * Env:
 *   CHAT_PROBE_WEB / _SLUG     web origin (default http://localhost:3331) / workspace slug
 *   CHAT_PROBE_HOST_MAP        resolve this host name to 127.0.0.1 (e.g. chatrows.test, with
 *                              WEB http://chatrows.test:3331): an insecure origin, so the page
 *                              has no Web Locks or OPFS and the log replica runs in memory
 *   CHAT_PROBE_CHROME          Chromium executable
 *   CHAT_PROBE_SESSION         send in this chat instead of a new one
 *   CHAT_PROBE_FROM_SESSION    open this chat first, then start a new chat from the sidebar
 *   CHAT_PROBE_FROM_PAGE       open this page first, then reach Chat by a client navigation
 *   CHAT_PROBE_STORED_SESSION  a chat the browser's storage names as open (a returning user):
 *                              /chat shows it, then the probe starts a new chat
 *   CHAT_PROBE_LEADER_TAB      open this page in another tab first (it holds the replica lock)
 *   CHAT_PROBE_CLOSE_LEADER_AT_MS  close that tab this long after the send
 *   CHAT_PROBE_BLIP_AT_MS      close the page's WebSockets this long after the send (they reconnect)
 *   CHAT_PROBE_STEER_AT_MS     send a second message this long after the first (a steer)
 *   CHAT_PROBE_LATENCY         added request latency in ms
 *   CHAT_PROBE_WATCH_MS        how long to watch after the send (default 45000)
 *   CHAT_PROBE_LOOP            then start N more new chats, stopping at the first one whose
 *                              rows drop after its reply showed
 *   CHAT_PROBE_OUT             write rows, frames and reads as JSON here (holds the token's
 *                              WebSocket auth frame: keep it private and delete it)
 */
import { chromium } from "playwright-core";

const WEB = process.env.CHAT_PROBE_WEB ?? "http://localhost:3331";
const SLUG = process.env.CHAT_PROBE_SLUG ?? "local";
const TOKEN = process.env.CHAT_PROBE_TOKEN ?? "";
const SESSION = process.env.CHAT_PROBE_SESSION ?? "";
const WATCH_MS = Number(process.env.CHAT_PROBE_WATCH_MS ?? 45_000);
const LATENCY = Number(process.env.CHAT_PROBE_LATENCY ?? 0);
const MESSAGE = process.env.CHAT_PROBE_MESSAGE ?? "年后";
const OUT = process.env.CHAT_PROBE_OUT ?? "";
const BLIP_AT = Number(process.env.CHAT_PROBE_BLIP_AT_MS ?? 0);
const LEADER_TAB = process.env.CHAT_PROBE_LEADER_TAB ?? "";
/** Send a second message this long after the first, while its turn runs (a steer). */
const STEER_AT = Number(process.env.CHAT_PROBE_STEER_AT_MS ?? 0);
/** Open this chat first, then start a new chat from the sidebar. */
const FROM_SESSION = process.env.CHAT_PROBE_FROM_SESSION ?? "";
/** Open this page first, then reach Chat by a client navigation. */
const FROM_PAGE = process.env.CHAT_PROBE_FROM_PAGE ?? "";
/** The chat a returning user's storage names as open: /chat opens it, then a new chat starts. */
const STORED_SESSION = process.env.CHAT_PROBE_STORED_SESSION ?? "";
/** Close the leader tab this long after the send (0: keep it). */
const CLOSE_LEADER_AT = Number(process.env.CHAT_PROBE_CLOSE_LEADER_AT_MS ?? 0);
let leaderPage: import("playwright-core").Page | null = null;
if (!TOKEN) throw new Error("CHAT_PROBE_TOKEN is required");

// CHAT_PROBE_HOST_MAP=chatrows.test maps that name to 127.0.0.1, so a WEB of
// http://chatrows.test:3331 is an insecure context like a plain-HTTP deployment:
// no Web Locks, no OPFS, and the replica runs in per-tab memory.
const HOST_MAP = process.env.CHAT_PROBE_HOST_MAP ?? "";
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_PROBE_CHROME,
  args: HOST_MAP ? [`--host-resolver-rules=MAP ${HOST_MAP} 127.0.0.1`] : [] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: "multimira_auth", value: TOKEN, url: WEB }]);
await context.addInitScript(({ token, stored, slug }) => {
  localStorage.setItem("multimira_token", token);
  if (stored && !sessionStorage.getItem("probe-stored")) {
    sessionStorage.setItem("probe-stored", "1");
    localStorage.setItem(`multimira:chat:activeSessionId:${slug}`, stored);
  }
  const w = window as unknown as { __rows: unknown[]; __t0: number };
  w.__rows = [];
  // Filled by a build instrumented with `__chatLogTrace` pushes, if any.
  (w as unknown as { __chatLogTrace: unknown[] }).__chatLogTrace = [];
  const sockets: WebSocket[] = [];
  (w as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) { const socket = new target(...(args as [string])); sockets.push(socket); return socket; },
  });
  w.__t0 = performance.now();
  let last = "";
  const tick = () => {
    const rows = [...document.querySelectorAll<HTMLElement>('[data-perf-item="message"]')].map(r => r.dataset.perfKey ?? "?");
    const scroll = document.querySelector<HTMLElement>('[data-perf-scroll="session-log"]');
    // The composer's stop button is shown while the chat has a pending turn;
    // the live turn view is the footer the list draws from the live trace.
    const running = !!document.querySelector('[data-chat-composer] button[aria-label="Stop"], [data-chat-composer] button[aria-label="停止"]');
    const live = !!document.querySelector("[data-chat-live-turn]");
    const key = `${rows.join(",")}|${scroll?.dataset.perfState ?? ""}|${location.search}|${running}|${live}`;
    if (key !== last) {
      last = key;
      w.__rows.push({ t: Math.round(performance.now()), n: rows.length, rows, state: scroll?.dataset.perfState ?? null, url: location.search, running, live });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, { token: TOKEN, stored: STORED_SESSION, slug: SLUG });
const page = await context.newPage();
const events: Array<Record<string, unknown>> = [];
const start = Date.now();
const now = () => Date.now() - start;
page.on("console", (message) => {
  if (/replica|degraded/i.test(message.text())) events.push({ t: now(), type: "console", level: message.type(), text: message.text().slice(0, 400) });
  else if (message.type() === "error" || message.type() === "warning") events.push({ t: now(), type: "console", level: message.type(), text: message.text().slice(0, 400) });
});
page.on("pageerror", (error) => events.push({ t: now(), type: "pageerror", text: String(error).slice(0, 400) }));
page.on("websocket", (ws) => {
  events.push({ t: now(), type: "ws-open", url: ws.url().replace(/token=[^&]+/, "token=…") });
  ws.on("framereceived", (frame) => {
    const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
    events.push({ t: now(), type: "ws-in", text: text.slice(0, text.includes('"stream":"log"') ? 60_000 : 1500) });
  });
  ws.on("framesent", (frame) => {
    const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
    events.push({ t: now(), type: "ws-out", text: text.slice(0, 600) });
  });
  ws.on("close", () => events.push({ t: now(), type: "ws-close" }));
});
page.on("request", (request) => {
  const url = request.url();
  if (url.includes("/api/")) events.push({ t: now(), type: "req", method: request.method(), url: url.replace(WEB, "") });
});
page.on("response", async (response) => {
  const url = response.url();
  if (!/\/api\/sessions\/[^/]+\/log/.test(url)) return;
  try {
    const body = await response.json() as { entries?: Array<Record<string, unknown>>; head_seq?: number; has_more_before?: boolean; has_more_after?: boolean };
    events.push({ t: now(), type: "log-read", url: url.replace(WEB, ""), status: response.status(), head: body.head_seq,
      before: body.has_more_before, after: body.has_more_after,
      entries: (body.entries ?? []).map(e => `${e.seq}:${e.kind}:r${e.revision}${e.visibility ? `:${e.visibility}` : ""}`) });
  } catch (error) { events.push({ t: now(), type: "log-read", url, status: response.status(), error: String(error) }); }
});
if (LATENCY > 0) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
}

if (LEADER_TAB) {
  // Another tab of the app opened first holds the replica lock; the chat tab follows.
  const other = await context.newPage();
  leaderPage = other;
  await other.goto(`${WEB}/${SLUG}/${LEADER_TAB}`);
  await other.waitForTimeout(3000);
  events.push({ t: now(), type: "leader-tab-open" });
}
if (FROM_PAGE) {
  await page.goto(`${WEB}/${SLUG}/${FROM_PAGE}`);
  await page.waitForTimeout(3000);
  await page.click(`a[href="/${SLUG}/chat"]`);
  events.push({ t: now(), type: "nav-to-chat" });
} else await page.goto(`${WEB}/${SLUG}/chat${FROM_SESSION ? `?session=${FROM_SESSION}` : SESSION ? `?session=${SESSION}` : ""}`);
await page.waitForSelector('[data-chat-composer] [contenteditable="true"]', { timeout: 60_000 });
const context0 = await page.evaluate(() => ({ secure: isSecureContext, locks: typeof navigator.locks,
  storage: typeof navigator.storage }));
process.stdout.write(`context: ${JSON.stringify(context0)}\n`);
await page.waitForTimeout(2500);
if (FROM_SESSION || STORED_SESSION) {
  events.push({ t: now(), type: "opened", text: await page.evaluate(() => location.search) });
  const sidebarNew = page.locator("button", { hasText: /^New chat$|^新对话$|^新建对话$/ }).first();
  await sidebarNew.click();
  events.push({ t: now(), type: "new-chat" });
  await page.waitForTimeout(1500);
  if (OUT) await page.screenshot({ path: OUT.replace(/\.json$/, "-newchat.png") });
}
events.push({ t: now(), type: "typing" });
await page.click('[data-chat-composer] [contenteditable="true"]');
await page.keyboard.type(MESSAGE);
await page.keyboard.press("ControlOrMeta+Enter");
events.push({ t: now(), type: "sent" });
if (STEER_AT > 0) {
  await page.waitForTimeout(STEER_AT);
  await page.click('[data-chat-composer] [contenteditable="true"]');
  await page.keyboard.type("不用看那么多，看最近三张单子就行");
  await page.keyboard.press("ControlOrMeta+Enter");
  events.push({ t: now(), type: "sent", text: "steer" });
}
if (CLOSE_LEADER_AT > 0 && leaderPage) {
  await page.waitForTimeout(CLOSE_LEADER_AT);
  await leaderPage.close();
  events.push({ t: now(), type: "leader-closed" });
  await page.waitForTimeout(Math.max(0, WATCH_MS - CLOSE_LEADER_AT));
} else if (BLIP_AT > 0) {
  await page.waitForTimeout(BLIP_AT);
  events.push({ t: now(), type: "offline" });
  await page.evaluate(() => { for (const socket of (window as unknown as { __sockets: WebSocket[] }).__sockets) socket.close(); });
  await page.waitForTimeout(3000);
  events.push({ t: now(), type: "online" });
  await page.waitForTimeout(Math.max(0, WATCH_MS - BLIP_AT - 3000));
} else await page.waitForTimeout(WATCH_MS);
// CHAT_PROBE_LOOP=N: N more new chats in the same page, each watched for a drop
// in the rows of its own chat after its reply showed.
const LOOP = Number(process.env.CHAT_PROBE_LOOP ?? 0);
for (let i = 0; i < LOOP; i++) {
  const sidebarNew = page.locator("button", { hasText: /^New chat$/ }).first();
  await sidebarNew.click();
  await page.waitForTimeout(800 + Math.floor(Math.random() * 1500));
  await page.click('[data-chat-composer] [contenteditable="true"]');
  await page.keyboard.type(`${MESSAGE} ${i}`);
  await page.keyboard.press("ControlOrMeta+Enter");
  events.push({ t: now(), type: "sent", text: String(i) });
  const verdict = await page.evaluate(() => new Promise<string>((resolve) => {
    let replied = false; let max = 0; let session = ""; let repliedAt = 0;
    const started = performance.now();
    const tick = () => {
      const keys = [...document.querySelectorAll<HTMLElement>('[data-perf-item="message"]')].map(r => r.dataset.perfKey ?? "");
      const url = new URLSearchParams(location.search).get("session") ?? "";
      if (url && url !== session) { session = url; max = 0; replied = false; }
      if (!replied && keys.some(k => k.startsWith("msg_"))) { replied = true; repliedAt = performance.now(); }
      if (replied) max = Math.max(max, keys.length);
      if (replied && keys.length < max) { resolve(`DROP session=${session} from=${max} to=${keys.length} keys=${keys.join(",")}`); return; }
      if ((replied && performance.now() - repliedAt > 12_000) || performance.now() - started > 60_000) { resolve(`ok replied=${replied} rows=${keys.length}`); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  events.push({ t: now(), type: "verdict", text: verdict });
  process.stdout.write(`loop ${i}: ${verdict}\n`);
  if (verdict.startsWith("DROP")) { await page.waitForTimeout(3000); break; }
}
const rows = await page.evaluate(() => (window as unknown as { __rows: unknown[] }).__rows);
const t0 = await page.evaluate(() => Math.round(performance.timeOrigin));
const finalText = await page.evaluate(() => document.querySelector('[data-perf-scroll="session-log"]')?.textContent?.slice(0, 300) ?? null);
const trace = await page.evaluate(() => (window as unknown as { __chatLogTrace: unknown[] }).__chatLogTrace);
const result = { start, t0, rows, events, finalText, trace };
if (OUT) await Bun.write(OUT, JSON.stringify(result, null, 1));
for (const row of rows as Array<{ t: number; n: number; rows: string[]; state: string; url: string; running: boolean; live: boolean }>) {
  process.stdout.write(`rows t=${Math.round(t0 + row.t - start)} n=${row.n} state=${row.state} running=${row.running} live=${row.live} url=${row.url} keys=${row.rows.join(",")}\n`);
}
process.stdout.write(`final: ${finalText}\n`);
await browser.close();
