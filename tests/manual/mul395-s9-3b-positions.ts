import { resolve } from "node:path";
import { launchBrowser, mktContext, attachCollectors, readResourceEntries, sanitizePath } from "../../frontend/scripts/perf/lib/harness";
import { installRecorderOnContext, readRecorder, freezeRecorder, readRecorderSummary, computeJumps } from "../../frontend/scripts/perf/lib/jump-recorder";
import { profilesFor } from "../../frontend/scripts/perf/lib/selectors";
import { computeRoundMeasurement } from "../../frontend/scripts/perf/lib/round-measurement";

const phase = process.argv[2]!;
const base = process.argv[3]!;
const marker = process.env.MUL395_S9_3B_FIXTURE_AUTH;
if (!marker) throw new Error("Local fixture authentication must be supplied in memory");
const browser = await launchBrowser();
const results: unknown[] = [];
const gated = (url: URL) => /\/api\/(pins|invitations|cli\/latest-version|inbox\/summary|squads|agent-task-snapshot|issues\/child-progress)(?:[/?]|$)/.test(url.pathname)
  || /\/api\/chat\//.test(url.pathname)
  || (url.pathname === "/api/issues" && url.searchParams.get("statuses") === "in_review,blocked")
  || url.pathname === "/api/issues/iss_pin_me";
const scenarios = [
  { name: "issues", path: "issues", shape: "list", kind: "issue", rounds: 5 },
  { name: "my-issues-all", path: "my-issues", shape: "list", kind: "issue", rounds: 5 },
  ...(phase === "after" ? [
    { name: "472-issues", path: "issues", shape: "list", kind: "issue", rounds: 1 },
    { name: "472-inbox", path: "inbox", shape: "list", kind: "inbox", rounds: 1 },
    { name: "472-detail", path: "issues/iss_detail", shape: "issue-detail", kind: "comment", rounds: 1 },
    { name: "MUL-454", path: "issues/iss_mul454", shape: "issue-detail", kind: "comment", rounds: 1 },
  ] as const : []),
] as const;
try {
  for (const scene of scenarios) for (const mode of ["cold", "warm"] as const) for (let round = 1; round <= scene.rounds; round++) {
    await fetch("http://127.0.0.1:18561/reset-inbox", { method: "POST" });
    const target = `/local/${scene.path}`;
    const context = await mktContext(browser, marker, [], base);
    await context.addInitScript(({ target, kind, all }) => {
      localStorage.setItem("multimira:chat:isOpen", "false");
      if (all) localStorage.setItem("multimira_my_issues_view:local", JSON.stringify({ state: { scope: "all" }, version: 0 }));
      const state = { firstVisible: null as number | null, navStart: 0, anchor: null as string | null,
        requests: [] as { path: string; start: number; method: string; role: string }[],
        samples: [] as { t: number; top: number; connected: boolean; visible: boolean }[] };
      (window as unknown as { __mul395: typeof state }).__mul395 = state;
      const fetchWindow = window as unknown as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
      const original = fetchWindow.fetch.bind(window);
      fetchWindow.fetch = (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.href, location.href);
        if (url.pathname.startsWith("/api/")) state.requests.push({ path: url.pathname, start: performance.now(), method: init?.method ?? "GET",
          role: url.pathname === "/api/issues/status-pages" ? "list"
            : url.pathname === "/api/issues" && url.searchParams.get("archived_only") === "true" ? "archive"
            : url.pathname === "/api/issues" && url.searchParams.get("limit") === "50" ? "list" : "other" });
        return original(input, init);
      };
      document.addEventListener("click", (event) => {
        const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
        if (link && new URL(link.href).pathname === target) state.navStart = performance.now();
      }, true);
      let locked: Element | null = null;
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.visibility !== "hidden" && style.display !== "none";
      };
      const tick = () => {
        if (location.pathname === target) {
          if (!locked) {
            locked = [...document.querySelectorAll(`[data-perf-item="${kind}"]`)].find(visible) ?? null;
            if (locked) { state.firstVisible = performance.now(); state.anchor = locked.getAttribute("data-perf-key"); }
          }
          if (locked) state.samples.push({ t: performance.now(), top: locked.getBoundingClientRect().top,
            connected: locked.isConnected, visible: visible(locked) });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, { target, kind: scene.kind, all: scene.name === "my-issues-all" });
    await installRecorderOnContext(context, { profiles: profilesFor({ modes: ["contract", "legacy"], shape: scene.shape }) });
    const page = await context.newPage();
    const collectors = attachCollectors(page, round, `${scene.name}:${mode}`, ["local"]);
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (gated(url)) await Bun.sleep(900);
      if (url.pathname === "/api/cli/latest-version") return route.fulfill({ json: { version: "999.0.0" } });
      if (route.request().method() === "GET" && (url.pathname === "/api/issues/status-pages"
        || (url.pathname === "/api/issues" && !gated(url)))) await Bun.sleep(300);
      await route.fallback();
    });
    const waitRow = (kind: string) => page.waitForFunction((kind) => [...document.querySelectorAll(`[data-perf-item="${kind}"]`)].some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
    }), kind, { timeout: 60000 });
    try {
      if (mode === "cold") await page.goto(`${base}${target}`, { waitUntil: "commit", timeout: 60000 });
      else {
        const entry = scene.path === "issues" ? "inbox" : "issues";
        await page.goto(`${base}/local/${entry}`, { waitUntil: "commit", timeout: 60000 });
        await waitRow(entry === "inbox" ? "inbox" : "issue");
        await page.waitForFunction(() => {
          const requests = (window as unknown as { __mul395: { requests: { start: number }[] } }).__mul395.requests;
          return performance.now() - (requests.at(-1)?.start ?? 0) >= 500;
        }, null, { timeout: 5000 }).catch(() => {});
        const link = page.locator(`a[href="${target}"]`).first();
        await link.hover();
        await page.waitForTimeout(150);
        await link.click();
        await page.waitForURL(`${base}${target}`, { waitUntil: "commit", timeout: 60000 });
      }
      await waitRow(scene.kind);
      await page.waitForFunction(() => (window as unknown as { __mul395: { firstVisible: number | null } }).__mul395.firstVisible !== null);
      await page.waitForTimeout(3000);
      await freezeRecorder(page);
      const buffer = (await readRecorder(page))!;
      const summary = await readRecorderSummary(page);
      const data = await page.evaluate(() => (window as unknown as { __mul395: {
        firstVisible: number; navStart: number; anchor: string; requests: { path: string; start: number; method: string; role: string }[];
        samples: { t: number; top: number; connected: boolean; visible: boolean }[];
      } }).__mul395);
      if (!data.anchor || data.samples.length < 20) throw new Error(`Missing real row evidence: ${scene.name}/${mode}`);
      const resources = await readResourceEntries(page, base, ["local"]);
      const measured = computeRoundMeasurement({ mode: "contract", shape: scene.shape, targetCommentId: null,
        navStartMs: data.navStart, frames: buffer.frames, shifts: buffer.shifts, stateTransitions: buffer.stateTransitions,
        resources, quietMs: 500, profileReady: summary?.profiles.contract.ready ?? false });
      const jump = computeJumps(buffer.frames, { profile: "contract", fromMs: data.firstVisible, toMs: data.firstVisible + 1500 });
      const tops = data.samples.map((sample) => sample.top);
      const shift = Math.max(...tops) - Math.min(...tops);
      const lastMove = data.samples.findLastIndex((sample) => Math.abs(sample.top - tops.at(-1)!) > 0.01);
      const finalPositionMs = data.samples[lastMove + 1]!.t - data.navStart;
      const requests = data.requests.filter((request) => request.start >= data.navStart).map((request) => ({
        ...request, path: sanitizePath(request.path, base, ["local"]), start: request.start - data.navStart,
      }));
      const firstScreenRequests = requests.filter((request) => request.start <= (measured.readyMs ?? finalPositionMs));
      const result = { phase, name: scene.name, mode, round, anchor: data.anchor, firstVisibleMs: data.firstVisible - data.navStart,
        finalPositionMs, readyMs: measured.readyMs, jump, fixedAnchorShiftPx: shift,
        disconnectedFrames: data.samples.filter((sample) => !sample.connected || !sample.visible).length,
        firstScreenRequests: firstScreenRequests.length, listRequests: firstScreenRequests.filter((request) => request.role === "list").length,
        archivedCountRequests: firstScreenRequests.filter((request) => request.role === "archive").length,
        requests, samples: data.samples.map((sample) => ({ ...sample, t: sample.t - data.navStart })),
        blockedWrites: collectors.blockedWrites };
      results.push(result);
      await Bun.write(resolve(import.meta.dir, `../../reports/performance/MUL-395-s9-3b/${phase}-positions.json`), JSON.stringify({
        beforeHead: process.env.MUL395_S9_3B_BEFORE_HEAD, viewport: "1440x900", primaryDelayMs: 300, deferredDelayMs: 900,
        observationMs: 3000, jumpWindowMs: 1500, results,
      }, null, 2));
      console.log(JSON.stringify({ ...result, samples: undefined, requests: undefined, blockedWrites: undefined }));
      if (phase === "after" && (shift !== 0 || jump.jumpPx !== 0 || result.disconnectedFrames !== 0)) throw new Error(`Position regression: ${scene.name}/${mode}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
