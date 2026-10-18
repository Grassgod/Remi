#!/usr/bin/env bun
/**
 * Measures Chat switching in headless Chromium against chat-switch-harness.ts.
 *
 *   CHAT_SWITCH_TOKEN=... CHAT_SWITCH_CHATS=a,b,c bun run tests/manual/chat-switch-measure.ts
 *
 * Each switch clicks a sidebar row and records, from the click: when the new
 * chat's rows exist (hidden or not), when the list is revealed, and the reveal
 * state (`ready` or the budget-forced `ready-forced`). It also counts the
 * session log reads the switch started (`GET /api/sessions/:id/log`), how many
 * of them finished before the list was revealed (`blocking`), and how many were
 * the seq-0 head read (`anchor=0&before=1`).
 *
 * Each round switches to every other chat and ends on the one the page opened,
 * so round 1 is five first visits and one return. Samples are labelled `first`
 * (not yet shown in this page) or `again`; summaries are printed per round and
 * per label.
 *
 * Env:
 *   CHAT_SWITCH_WEB      web origin (default http://localhost:3291)
 *   CHAT_SWITCH_SLUG     workspace slug (default local)
 *   CHAT_SWITCH_CPU      CPU throttling rate (default 1)
 *   CHAT_SWITCH_LATENCY  added request latency in ms (default 0)
 *   CHAT_SWITCH_ROUNDS   passes over the chat list (default 2)
 *   CHAT_SWITCH_CHROME   Chromium executable (default: Playwright's own)
 */
import { chromium } from "playwright-core";

const WEB = process.env.CHAT_SWITCH_WEB ?? "http://localhost:3291";
const SLUG = process.env.CHAT_SWITCH_SLUG ?? "local";
const TOKEN = process.env.CHAT_SWITCH_TOKEN ?? "";
const CHATS = (process.env.CHAT_SWITCH_CHATS ?? "").split(",").filter(Boolean);
const CPU = Number(process.env.CHAT_SWITCH_CPU ?? 1);
const LATENCY = Number(process.env.CHAT_SWITCH_LATENCY ?? 0);
const ROUNDS = Number(process.env.CHAT_SWITCH_ROUNDS ?? 2);
const SETTLE_MS = 1200;
if (!TOKEN || CHATS.length < 2) throw new Error("CHAT_SWITCH_TOKEN and at least two CHAT_SWITCH_CHATS are required");

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHAT_SWITCH_CHROME });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: "multimira_auth", value: TOKEN, url: WEB }]);
await context.addInitScript((token) => {
  localStorage.setItem("multimira_token", token);
  performance.setResourceTimingBufferSize(100_000);
}, TOKEN);
const page = await context.newPage();
const warnings: string[] = [];
page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
const cdp = await context.newCDPSession(page);
if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
if (LATENCY > 0) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: -1, uploadThroughput: -1 });
}

await page.goto(`${WEB}/${SLUG}/chat?session=${CHATS[0]}`);
await page.waitForSelector('[data-perf-scroll="session-log"][data-perf-state^="ready"]', { timeout: 60_000 });
await page.waitForTimeout(1500);

type Switch = { t0: number; rowsMs: number | null; visibleMs: number | null; state: string | null };
type Reads = { logReads: number; blocking: number; headReads: number };
type Sample = { chat: string; round: number; visit: "first" | "again" } & Omit<Switch, "t0"> & Reads;
const samples: Sample[] = [];
const shown = new Set([CHATS[0]!]);
for (let round = 1; round <= ROUNDS; round++) {
  for (const chat of [...CHATS.slice(1), CHATS[0]!]) {
    const result = await page.evaluate((id) => new Promise<Switch>((resolve) => {
      const marker = `[data-session-log-id="${id}"]`;
      const target = document.querySelector<HTMLElement>(`[data-chat-session-row="${id}"]`);
      performance.clearResourceTimings();
      const t0 = performance.now();
      if (!target) { resolve({ t0, rowsMs: null, visibleMs: null, state: "no-row" }); return; }
      let rowsMs: number | null = null;
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-perf-state", "style"] });
      const timeout = setTimeout(() => { observer.disconnect(); resolve({ t0, rowsMs, visibleMs: null, state: "timeout" }); }, 15_000);
      function check(): void {
        const root = document.querySelector<HTMLElement>(marker);
        if (!root) return;
        const now = performance.now() - t0;
        if (rowsMs === null && root.querySelector('[data-perf-item="message"]')) rowsMs = now;
        const content = root.firstElementChild as HTMLElement | null;
        const state = root.dataset.perfState ?? null;
        if (rowsMs !== null && state !== "pending" && content?.style.visibility !== "hidden") {
          observer.disconnect(); clearTimeout(timeout);
          resolve({ t0, rowsMs: Math.round(rowsMs), visibleMs: Math.round(now), state });
        }
      }
      target.click();
    }), chat);
    await page.waitForTimeout(SETTLE_MS);
    const reads = await page.evaluate(({ id, t0, visibleMs }) => {
      const logs = performance.getEntriesByType("resource")
        .filter((entry) => entry.startTime >= t0 && entry.name.includes(`/api/sessions/${id}/log`)) as PerformanceResourceTiming[];
      return {
        logReads: logs.length,
        blocking: visibleMs === null ? logs.length : logs.filter((entry) => entry.responseEnd - t0 <= visibleMs).length,
        headReads: logs.filter((entry) => /[?&]anchor=0(&|$)/.test(entry.name) && /[?&]before=1(&|$)/.test(entry.name)).length,
      };
    }, { id: chat, t0: result.t0, visibleMs: result.visibleMs });
    samples.push({ chat, round, visit: shown.has(chat) ? "again" : "first",
      rowsMs: result.rowsMs, visibleMs: result.visibleMs, state: result.state, ...reads });
    shown.add(chat);
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
};
const summary = (label: string, group: Sample[]): string => {
  const visible = group.map(s => s.visibleMs).filter((v): v is number => v !== null);
  const rows = group.map(s => s.rowsMs).filter((v): v is number => v !== null);
  const sum = (key: keyof Reads) => group.reduce((total, s) => total + s[key], 0);
  return `${label} switches=${group.length} rows_p50=${median(rows)} rows_max=${Math.max(...rows)}`
    + ` visible_p50=${median(visible)} visible_max=${Math.max(...visible)} forced=${group.filter(s => s.state === "ready-forced").length}`
    + ` log_reads=${sum("logReads")} blocking_reads=${sum("blocking")} head_reads=${sum("headReads")}`;
};
for (const sample of samples) process.stdout.write(`${JSON.stringify(sample)}\n`);
process.stdout.write(`cpu=${CPU}x latency=${LATENCY}ms\n`);
for (let round = 1; round <= ROUNDS; round++) process.stdout.write(`${summary(`round=${round}`, samples.filter(s => s.round === round))}\n`);
for (const visit of ["first", "again"] as const) process.stdout.write(`${summary(`visit=${visit}`, samples.filter(s => s.visit === visit))}\n`);
process.stdout.write(`${summary("all", samples)}\n`);
process.stdout.write(`reveal warnings: ${warnings.filter(w => w.includes("useAnchoredReveal")).length}\n`);
await browser.close();
