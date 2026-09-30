import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { resolveCachedChromium } from "../../../../frontend/scripts/perf/lib/harness";
import { installRecorderOnContext, readRecorder, freezeRecorder, readRecorderSummary, computeJumps } from "../../../../frontend/scripts/perf/lib/jump-recorder.ts";
import { profilesFor } from "../../../../frontend/scripts/perf/lib/selectors.ts";
import { computeRoundMeasurement } from "../../../../frontend/scripts/perf/lib/round-measurement.ts";

const marker = process.env.MUL472_R3_FIXTURE_AUTH;
if (!marker) throw new Error("MUL472_R3_FIXTURE_AUTH is required for the local fixture");
const phase = process.argv[2] ?? "after";
const base = `http://localhost:${phase === "before" ? 3560 : phase === "rework-before" ? 3562 : 3561}`;
const out = resolve(import.meta.dir, "..");
const gated = (path: string) => /\/api\/(pins|invitations|cli\/latest-version|inbox\/summary|squads|agent-task-snapshot)(?:[/?]|$)/.test(path)
  || /\/api\/chat\/(pending-tasks|sessions)(?:[/?]|$)/.test(path)
  || /\/api\/issues\/iss_pin_me(?:[/?]|$)/.test(path)
  || /\/api\/issues\/child-progress/.test(path)
  || (() => {
    const url = new URL(path, "http://localhost");
    return url.pathname === "/api/issues" && (url.searchParams.get("statuses") === "in_review,blocked"
      || (url.searchParams.get("limit") === "200" && ["in_review", "blocked"].includes(url.searchParams.get("status") ?? "")));
  })()
  || /\/api\/agents\?.*include_archived=true/.test(path);
const main = process.env.MUL472_R3_MAIN ?? "36fb03c47eba7914be7a4d026f19e360b83a0f83";
const browser = await chromium.launch({ executablePath: resolveCachedChromium() || undefined, headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const results: any[] = [];

async function contextFor(target: string, shape: "list" | "issue-detail") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: "multimira_token", value: marker, url: base },
    { name: "multimira_logged_in", value: "1", url: base },
    { name: "last_workspace_slug", value: "local", url: base },
  ]);
  await context.addInitScript(({ marker, target }) => {
    localStorage.setItem("multimira_token", marker);
    localStorage.setItem("multimira:chat:isOpen", "false");
    const w = window as any;
    const state = w.__mul472 = { requests: [], samples: [], allSamples: [], idleFires: [], firstVisible: null, navStart: 0, locked: null };
    const requestIdle = window.requestIdleCallback.bind(window);
    window.requestIdleCallback = (callback, options) => {
      const gateIdle = options?.timeout === 1000 && new Error().stack?.includes("scheduleAfterFirstIdle");
      return requestIdle((deadline) => {
        if (gateIdle) state.idleFires.push({ t: performance.now(), route: location.pathname });
        callback(deadline);
      }, options);
    };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.href, location.href);
      if (url.pathname.startsWith("/api/")) state.requests.push({ path: url.pathname + url.search, t: performance.now(), route: location.pathname, method: init?.method ?? "GET" });
      return fetchOriginal(input, init);
    };
    document.addEventListener("click", (event) => {
      const link = (event.target as Element)?.closest("a[href]") as HTMLAnchorElement | null;
      if (link && new URL(link.href).pathname === target) state.navStart = performance.now();
    }, true);
    let locked: Element | null = null;
    state.resetAnchor = () => { locked = null; state.samples = []; state.firstVisible = null; state.locked = null; };
    const tick = () => {
      const t = performance.now();
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.height > 0 && r.bottom > 0 && r.top < innerHeight && s.visibility !== "hidden" && s.display !== "none";
      };
      const row = [...document.querySelectorAll('[data-perf-item="issue"], [data-perf-item="inbox"], [data-perf-item="comment"]')].find(visible);
      if (row) state.allSamples.push({ t, route: location.pathname, key: row.getAttribute("data-perf-key"), top: row.getBoundingClientRect().top });
      if (location.pathname === target) {
        if (!locked && row) {
          locked = row;
          state.firstVisible = t;
          state.locked = row.getAttribute("data-perf-key") ?? row.id;
        }
        if (locked) state.samples.push({ t, route: location.pathname, key: locked.getAttribute("data-perf-key") ?? locked.id, top: locked.getBoundingClientRect().top, connected: locked.isConnected, visible: visible(locked) });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { marker, target });
  await installRecorderOnContext(context, { profiles: profilesFor({ modes: ["contract", "legacy"], shape }) });
  await context.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname + url.search;
    if (gated(path)) await new Promise((resolve) => setTimeout(resolve, 900));
    if (url.pathname === "/api/cli/latest-version") return route.fulfill({ json: { version: "999.0.0" } });
    if (route.request().method() === "GET" && /^\/api\/issues\?/.test(path) && !gated(path)) await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  return context;
}

async function waitRow(page: any, kind: string) {
  await page.waitForFunction((kind: string) => [...document.querySelectorAll(`[data-perf-item="${kind}"]`)].some((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== "hidden";
  }), kind, { timeout: 60000 });
}

try {
  if (process.argv[3] === "path") {
    const reset = await fetch("http://127.0.0.1:16861/reset-inbox", { method: "POST" });
    if (!reset.ok) throw new Error("fixture inbox reset failed");
    const context = await contextFor("/local/issues", "list");
    const page = await context.newPage();
    try {
      await page.goto(`${base}/local/issues`, { waitUntil: "commit", timeout: 60000 });
      await waitRow(page, "issue");
      await page.waitForTimeout(3000);
      const inboxLink = page.locator('a[href="/local/inbox"]').first();
      await inboxLink.hover();
      await page.waitForTimeout(150);
      await inboxLink.click();
      await page.waitForURL(`${base}/local/inbox`, { waitUntil: "commit" });
      await waitRow(page, "inbox");
      await page.waitForTimeout(1500);
      await page.locator('[data-perf-item="inbox"]').first().click();
      const detailLink = page.locator('[data-slot="sidebar-inset"] a[href="/local/issues/iss_detail"]').first();
      await detailLink.waitFor({ state: "visible", timeout: 60000 });
      await detailLink.hover();
      await page.waitForTimeout(150);
      await detailLink.click();
      await page.waitForURL(`${base}/local/issues/iss_detail`, { timeout: 60000, waitUntil: "commit" });
      await waitRow(page, "comment");
      await page.waitForTimeout(3000);
      const data = await page.evaluate(() => ({ requests: (window as any).__mul472.requests, clicks: (window as any).__mul383Recorder.read().clicks }));
      const inboxClick = data.clicks.find((c: any) => c.href === `${base}/local/inbox`).t;
      const detailClick = data.clicks.find((c: any) => c.href === `${base}/local/issues/iss_detail`).t;
      const result = { phase, main, total: data.requests.length, initialIssues: data.requests.filter((r: any) => r.t < inboxClick).length, inboxLeg: data.requests.filter((r: any) => r.t >= inboxClick && r.t < detailClick).length, detailLeg: data.requests.filter((r: any) => r.t >= detailClick).length, hotTotal: data.requests.filter((r: any) => r.t >= inboxClick).length, requests: data.requests, clicks: data.clicks };
      writeFileSync(`${out}/MUL-472-r3-${phase}-hot-path.json`, JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ ...result, requests: undefined, clicks: undefined }));
    } finally { await context.close(); }
  } else if (process.argv[3] === "return") {
    for (let round = 1; round <= 3; round++) {
      const target = "/local/issues";
      const context = await contextFor(target, "list");
      const page = await context.newPage();
      try {
        await page.goto(`${base}${target}`, { waitUntil: "commit", timeout: 60000 });
        await waitRow(page, "issue");
        await page.waitForTimeout(3000);
        const inbox = page.locator('a[href="/local/inbox"]').first();
        await inbox.hover();
        await page.waitForTimeout(150);
        await inbox.click();
        await page.waitForURL(`${base}/local/inbox`, { waitUntil: "commit" });
        await waitRow(page, "inbox");
        await page.waitForTimeout(2200);
        const back = page.locator('a[href="/local/issues"]').first();
        await back.hover();
        await page.waitForTimeout(150);
        await page.evaluate(() => (window as any).__mul472.resetAnchor());
        await back.click();
        await page.waitForURL(`${base}${target}`, { waitUntil: "commit" });
        await waitRow(page, "issue");
        await page.waitForFunction(() => (window as any).__mul472.firstVisible !== null);
        await page.waitForTimeout(3000);
        await freezeRecorder(page);
        const data = await page.evaluate(() => (window as any).__mul472);
        const buffer = (await readRecorder(page))!;
        const first = data.firstVisible;
        const nav = data.navStart;
        const requests = data.requests.filter((request: any) => request.t >= nav);
        const tops = data.samples.filter((sample: any) => sample.t <= first + 1500).map((sample: any) => sample.top);
        const jump = computeJumps(buffer.frames, { profile: "contract", fromMs: first, toMs: first + 1500 });
        const result = { phase, main, round, firstVisibleMs: first - nav, anchor: data.locked, gatedRequests: requests.filter((request: any) => gated(request.path)).map((request: any) => ({ ...request, t: request.t - nav, afterFirstMs: request.t - first })), requests: requests.map((request: any) => ({ ...request, t: request.t - nav })), fixedAnchorShiftPx: Math.max(...tops) - Math.min(...tops), disconnectedFrames: data.samples.filter((sample: any) => !sample.connected || !sample.visible).length, jump, samples: data.samples.map((sample: any) => ({ ...sample, t: sample.t - nav })) };
        Object.assign(result, {
          gateIdleFires: data.idleFires.filter((idle: any) => idle.t >= nav).map((idle: any) => ({ ...idle, t: idle.t - nav })),
          gateIdleAfterFirstMs: data.idleFires.filter((idle: any) => idle.t >= nav).map((idle: any) => idle.t - first),
        });
        results.push(result);
        writeFileSync(`${out}/MUL-472-r3-${phase}-hot-return.json`, JSON.stringify({ phase, main, results }, null, 2));
        console.log(JSON.stringify({ ...result, samples: undefined }));
      } finally { await context.close(); }
    }
  } else {
  // Compile routes once, just as the previous --warmup runs did; measured contexts are new.
  const warmup = await contextFor("/local/issues/iss_detail", "issue-detail");
  const warmPage = await warmup.newPage();
  for (const [path, kind] of [["issues", "issue"], ["inbox", "inbox"], ["issues/iss_detail", "comment"]]) {
    await warmPage.goto(`${base}/local/${path}`, { waitUntil: "commit", timeout: 120000 });
    await waitRow(warmPage, kind);
    await warmPage.waitForTimeout(1800);
  }
  await warmup.close();

  for (const [name, path, shape, kind, n] of [
    ["issues", "issues", "list", "issue", 3],
    ["inbox", "inbox", "list", "inbox", 2],
    ["detail", "issues/iss_detail", "issue-detail", "comment", 3],
  ] as const) {
    for (const mode of ["cold", "warm"]) for (let round = 1; round <= n; round++) {
      const target = `/local/${path}`;
      const context = await contextFor(target, shape);
      const page = await context.newPage();
      try {
        if (mode === "cold") {
          await page.goto(`${base}${target}`, { waitUntil: "commit", timeout: 60000 });
        } else {
          const entry = name === "issues" ? "inbox" : "issues";
          await page.goto(`${base}/local/${entry}`, { waitUntil: "commit", timeout: 60000 });
          await waitRow(page, entry === "inbox" ? "inbox" : "issue");
          await page.waitForTimeout(2200);
          const link = page.locator(`a[href="${target}"]`).first();
          await link.hover();
          await page.waitForTimeout(150);
          await link.click();
          await page.waitForURL(`${base}${target}`, { timeout: 60000, waitUntil: "commit" });
        }
        await waitRow(page, kind);
        await page.waitForFunction(() => (window as any).__mul472.firstVisible !== null);
        await page.waitForTimeout(3000);
        await freezeRecorder(page);
        const buffer = (await readRecorder(page))!;
        const summary = await readRecorderSummary(page);
        const data = await page.evaluate(() => (window as any).__mul472);
        const first = data.firstVisible;
        const nav = data.navStart;
        const frames = buffer.frames.filter((frame) => frame.t >= nav);
        const selectorMode = summary?.contractDom ? "contract" : "legacy";
        const measured = computeRoundMeasurement({ mode: selectorMode, shape, targetCommentId: null, navStartMs: nav, frames, shifts: buffer.shifts, stateTransitions: buffer.stateTransitions, resources: [], quietMs: 500, profileReady: summary?.profiles[selectorMode].ready ?? false });
        const jump1500 = computeJumps(frames, { profile: selectorMode, fromMs: first, toMs: first + 1500 });
        const samples = data.samples.filter((sample: any) => sample.t <= first + 1500);
        const tops = samples.map((sample: any) => sample.top);
        const shift = Math.max(...tops) - Math.min(...tops);
        const requests = data.requests.filter((r: any) => r.t >= nav);
        const gatedRequests = requests.filter((r: any) => gated(r.path));
        const violations = gatedRequests.filter((r: any) => r.t <= first);
        const disconnectedFrames = data.samples.filter((sample: any) => !sample.connected || !sample.visible).length;
        const ui = await page.evaluate(() => ({
          pin: document.querySelector('a[href="/local/issues/iss_pin_me"]')?.textContent?.includes("Pinned fixture") === true,
          invitationDot: document.querySelector('[data-slot="sidebar-header"] .ring-sidebar.bg-brand') !== null,
          cliDot: document.querySelector('a[href="/local/runtimes"] .bg-destructive') !== null,
          workbenchBadge: document.querySelector('a[href="/local/workbench"]')?.textContent?.trim(),
        }));
        const allTops = data.samples.map((s: any) => s.top);
        const result = { phase, main, name, mode, round, disconnectedFrames, selectorMode, firstVisibleMs: first - nav, readyMs: measured.readyMs, anchor: data.locked, samples: samples.map((s: any) => ({ ...s, t: s.t - nav })), recorderFrames: frames.filter(f => f.t >= first && f.t <= first + 1500), jump1500, jumpAtReady: { count: measured.jumpCount, px: measured.jumpPx, scrollPx: measured.jumpScrollPx }, fixedAnchorShiftPx: shift, fixedAnchorShift3000Px: Math.max(...allTops) - Math.min(...allTops), requests: requests.map((r: any) => ({ ...r, t: r.t - nav })), gatedRequests: gatedRequests.map((r: any) => ({ ...r, t: r.t - nav, afterFirstMs: r.t - first })), violations: violations.length, firstScreenRequests: requests.filter((r: any) => r.t <= nav + (measured.readyMs ?? first - nav)).length, ui };
        results.push(result);
        writeFileSync(`${out}/MUL-472-r3-${phase}-timing.json`, JSON.stringify({ phase, main, base, fixture: "shared SQLite API 16860; gate response delay=900ms; primary list delay=300ms; viewport=1440x900; n=3/2/3", results }, null, 2));
        console.log(JSON.stringify({ phase, name, mode, round, first: result.firstVisibleMs, ready: result.readyMs, recorderPx: jump1500.jumpPx, fixedPx: shift, violations: violations.length, requests: requests.length, firstScreen: result.firstScreenRequests, gated: result.gatedRequests.map((r: any) => [r.path, Math.round(r.afterFirstMs)]) }));
      } finally { await context.close(); }
    }
  }
  }
} finally { await browser.close(); }
