/** D0: production Web + S7 memory API; raw CPU/timeline profiles stay in /tmp. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";
import { seedZeroJumpFixture } from "../integration/zero-jump-fixture";
import { scrubInheritedEnv, HERMETIC_ENV_RUN_ROOT_PATHS } from "../setup/hermetic-env-policy";
import { installFirstScreenHotspotIds } from "../fixtures/multiremi/first-screen-hotspots-normalize";
import { launchBrowser, mktContext, attachCollectors } from "../../frontend/scripts/perf/lib/harness";

const root = resolve(import.meta.dir, "../..");
const out = process.env.MUL395_PROFILE_OUT ?? "/tmp/mul395-s96-d0-before";
const webDir = process.env.MUL395_PROFILE_WEB_DIR ?? join(root, "frontend/apps/web");
mkdirSync(out, { recursive: true });
scrubInheritedEnv();
for (const [name, relative] of Object.entries(HERMETIC_ENV_RUN_ROOT_PATHS)) process.env[name] = join(out, "state", relative);
const db = openSqliteDatabase(":memory:");
const restore = installFirstScreenHotspotIds();
const store = new MultiremiStore(db);
const fixture = await seedZeroJumpFixture(store);
restore();
const minted = await store.createAccessToken({ name: "D0 local profile", type: "pat", userId: fixture.userId, workspaceId: fixture.workspaceId });
const api = startMultiremiServer({ store, port: 16695, hostname: "127.0.0.1", authToken: "d0-local-fixture-root", backgroundJobs: false });
const web = Bun.spawn(["bun", "x", "next", "start", "--hostname", "127.0.0.1", "--port", "3395"], {
  cwd: webDir, env: { ...process.env, REMOTE_API_URL: "http://127.0.0.1:16695" },
  stdout: Bun.file(join(out, "web.log")), stderr: Bun.file(join(out, "web-errors.log")),
});
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch("http://127.0.0.1:3395/login").then(r => r.ok, () => false)) break;
    await Bun.sleep(200);
    if (attempt === 99) throw new Error("Web not ready");
  }
  browser = await launchBrowser();
  const context = await mktContext(browser, minted.token, [], "http://127.0.0.1:3395");
  await context.addInitScript(() => {
    performance.setResourceTimingBufferSize(10_000);
    const data = { tasks: [] as Array<{ start: number; duration: number }>, states: [] as Array<{ time: number; state: string }> };
    (window as unknown as { __d0: typeof data }).__d0 = data;
    new PerformanceObserver(list => {
      for (const task of list.getEntries()) data.tasks.push({ start: task.startTime, duration: task.duration });
    }).observe({ type: "longtask", buffered: true });
    const observe = () => {
      let last = "";
      const sample = () => {
        const roots = [...document.querySelectorAll('[data-perf-scroll="issue-detail"]')];
        const state = roots.at(-1)?.getAttribute("data-perf-state") ?? "";
        if (state && state !== last) { data.states.push({ time: performance.now(), state, rows: roots.at(-1)?.querySelectorAll('[data-perf-key]').length } as typeof data.states[number]); last = state; }
      };
      new MutationObserver(sample).observe(document.documentElement, { subtree: true, attributes: true, childList: true });
      sample();
    };
    if (document.documentElement) observe(); else document.addEventListener("DOMContentLoaded", observe, { once: true });
  });
  const page = await context.newPage();
  attachCollectors(page, 1, "detail-long", [fixture.workspaceSlug]);
  const windows: Array<{ bytes: number; entries: number; head: number; timing: unknown }> = [];
  page.on("response", async response => {
    const url = new URL(response.url());
    if (url.pathname.endsWith("/log") && url.searchParams.get("before") === "30") {
      const body = await response.body().catch(() => null);
      if (body) { const parsed = JSON.parse(body.toString()); windows.push({ bytes: body.length, entries: parsed.entries?.length ?? 0, head: parsed.head_seq, timing: response.request().timing() }); }
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  let navStart = metrics.metrics.find(m => m.name === "NavigationStart")!.value * 1e6;
  await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  const trace: unknown[] = [];
  cdp.on("Tracing.dataCollected", event => trace.push(...event.value));
  // No network, screenshots, arguments or storage categories: credentials never enter the trace.
  await cdp.send("Tracing.start", { categories: "toplevel,v8.execute,disabled-by-default-v8.cpu_profiler", transferMode: "ReportEvents" });
  await cdp.send("Profiler.start");
  const navigation = await page.goto(`http://127.0.0.1:3395/${fixture.workspaceSlug}/issues/${fixture.longIssueId}`, { waitUntil: "commit" });
  const html = await navigation!.text();
  const ssrSeed = html.includes(`head_${fixture.longDefaultSessionId}`);
  await page.waitForSelector('[data-perf-scroll="issue-detail"][data-perf-state="ready"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  navStart = (await cdp.send("Performance.getMetrics")).metrics.find(m => m.name === "NavigationStart")!.value * 1e6;
  const { profile } = await cdp.send("Profiler.stop");
  const finished = new Promise<void>(resolve => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.end"); await finished;
  const observation = await page.evaluate(() => {
    const data = (window as unknown as { __d0: { tasks: Array<{ start: number; duration: number }>; states: Array<{ time: number; state: string }> } }).__d0;
    const windows = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(r => /\/log\?/.test(r.name) && new URL(r.name).searchParams.get("before") === "30");
    const responseEnd = windows[0]?.responseEnd ?? null;
    const ready = data.states.find(s => s.state === "ready" && (responseEnd === null || s.time >= responseEnd))?.time ?? null;
    return { responseEnd, ready, renderMs: responseEnd === null || ready === null ? null : ready - responseEnd,
      tasks: data.tasks.filter(t => responseEnd !== null && t.start + t.duration >= responseEnd).slice(0, 3), states: data.states,
      roots: [...document.querySelectorAll('[data-perf-scroll="issue-detail"]')].map(root => ({state: root.getAttribute('data-perf-state'), height: root.getBoundingClientRect().height, keys: [...root.querySelectorAll('[data-perf-key]')].map(el => el.getAttribute('data-perf-key'))})),
      logResources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(r => /\/log\?/.test(r.name)).map(r => ({ path: new URL(r.name).pathname, query: new URL(r.name).search, start: r.startTime, responseEnd: r.responseEnd })) };
  });
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  let sampleTime = profile.startTime;
  const samples = (profile.samples ?? []).map((id, i) => { sampleTime += profile.timeDeltas?.[i] ?? 0; return { id, time: (sampleTime - navStart) / 1000 }; });
  const tasks = observation.tasks.map(task => {
    const counts = new Map<number, number>();
    for (const sample of samples) if (sample.time >= task.start && sample.time <= task.start + task.duration) counts.set(sample.id, (counts.get(sample.id) ?? 0) + 1);
    const stacks = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, count]) => {
      const stack: string[] = []; let cursor: number | undefined = id;
      while (cursor !== undefined) {
        const frame = nodes.get(cursor)?.callFrame;
        if (frame) stack.push(`${frame.functionName || "(anonymous)"} ${frame.url ? new URL(frame.url).pathname : ""}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`);
        cursor = parents.get(cursor);
      }
      return { count, stack };
    });
    return { ...task, stacks };
  });
  if (ssrSeed || observation.renderMs === null) throw new Error("CSR window/reveal baseline was not observed");
  const report = { fixture: "S7 memory SQLite / 250 comments / 3 sessions / 30-row tail", authMode: "bearer / fresh context / CSR document verified", ssrSeed,
    cookieNames: (await context.cookies()).map(cookie => cookie.name),
    commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim(), windows, ...observation, tasks };
  for (const [name, body] of Object.entries({ "summary.json": report, "cpu.cpuprofile": profile, "timeline.json": { traceEvents: trace } })) {
    const text = JSON.stringify(body, null, 2);
    if (text.includes(minted.token)) throw new Error("Credential detected; profile was not written");
    writeFileSync(join(out, name), text);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); web.kill("SIGTERM"); await web.exited; api.stop(true); db.close();
}
