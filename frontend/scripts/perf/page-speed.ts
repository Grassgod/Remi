#!/usr/bin/env bun
/**
 * Standalone read-only page-speed probe (MUL-367 part 2).
 *
 * Opens the main workspace pages in headless Chromium, measures how long the
 * main content region takes to show real (non-skeleton) content, and records
 * the `/api/**` traffic each load produces: call count, bytes, the slowest call
 * and its raw `Server-Timing` value once the API ships that header.
 *
 * Read-only guarantee: every `/api/**` request that is not GET/HEAD is aborted
 * inside `page.route()` and reported under `blockedWrites`. This script never
 * writes to the target.
 *
 * Credentials: the token comes from `MULTIREMI_QA_WEB_TOKEN` only. It is put
 * into `localStorage.multimira_token` for the target origin and is never
 * printed, logged, stored in an output file, or passed through argv.
 *
 * Usage:
 *   MULTIREMI_QA_WEB_TOKEN=... bun run frontend/scripts/perf/page-speed.ts \
 *     --base-url http://n37-117-209.byted.org --rounds 3 \
 *     --out reports/performance --name MUL-367-page-speed-baseline-<date>
 *
 * Compare a later run against a stored baseline:
 *   ... --compare reports/performance/MUL-367-page-speed-baseline-<date>.json
 *
 * Operating notes and result paths: docs/dev/performance.md
 */

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, hostname, platform, release as osRelease, totalmem } from "node:os";
import { join, resolve } from "node:path";

const TOKEN_ENV = "MULTIREMI_QA_WEB_TOKEN";
const DEFAULT_BASE_URL = "http://n37-117-209.byted.org";
const DEFAULT_ROUNDS = 3;
const DEFAULT_OUT_DIR = "reports/performance";
const VIEWPORT = { width: 1440, height: 900 };
const READY_TIMEOUT_MS = 60_000;
const DEFAULT_QUIET_MS = 800;
const DEFAULT_SETTLE_CAP_MS = 20_000;

/** Main pages, in the order one round visits them. */
const PAGE_SEQUENCE = [
  { key: "issues", path: "/{slug}/issues" },
  { key: "my-issues", path: "/{slug}/my-issues" },
  { key: "chat", path: "/{slug}/chat" },
  { key: "inbox", path: "/{slug}/inbox" },
  { key: "agents", path: "/{slug}/agents" },
  { key: "runtimes", path: "/{slug}/runtimes" },
  { key: "projects", path: "/{slug}/projects" },
  { key: "workbench", path: "/{slug}/workbench" },
  { key: "settings", path: "/{slug}/settings" },
  { key: "autopilots", path: "/{slug}/autopilots" },
  { key: "skills", path: "/{slug}/skills" },
] as const;

type PageKey = (typeof PAGE_SEQUENCE)[number]["key"];

/**
 * One readiness rule for every page, so the numbers stay comparable: the
 * workspace content region exists, its page heading is rendered, and no
 * skeleton placeholder is left inside it.
 */
const READY_SELECTOR = '[data-slot="sidebar-inset"]';
const READY_RULE_SOURCE =
  '主内容区域（[data-slot="sidebar-inset"]）出现 H1 标题，且区域内没有 data-slot="skeleton" 骨架占位';

/** Runs in the page; keep it self-contained so it survives serialization. */
function readyPredicate(selector: string): boolean {
  const inset = document.querySelector(selector);
  if (!inset) return false;
  const heading = inset.querySelector("h1");
  if (!heading || !(heading.textContent ?? "").trim()) return false;
  if (inset.querySelectorAll('[data-slot="skeleton"]').length > 0) return false;
  return (inset as HTMLElement).innerText.trim().length > 0;
}

interface Options {
  baseUrl: string;
  rounds: number;
  outDir: string;
  name: string | null;
  compare: string | null;
  quietMs: number;
  settleCapMs: number;
  skipInboxProbe: boolean;
  skipInboxGuard: boolean;
  /** Re-render Markdown/HTML from an existing report JSON, without measuring. */
  renderOnly: string | null;
}

interface ApiCall {
  method: string;
  /** Query removed and ID-like segments replaced with `:id`. */
  path: string;
  status: number | null;
  durationMs: number;
  encodedBytes: number;
  decodedBytes: number;
  transferBytes: number;
  /** Raw header value; null until the API ships `Server-Timing`. */
  serverTiming: string | null;
}

type GuardLabel = "inbox-guard" | "inbox-guard-click";

interface BlockedWrite {
  round: number;
  page: PageKey | GuardLabel;
  method: string;
  path: string;
  /** How many identical attempts the page made (mutations retry while aborted). */
  attempts: number;
}

interface PageRound {
  round: number;
  /** 1 means the first load of a fresh context, so it pays app-shell cold start. */
  order: number;
  coldShellStart: boolean;
  url: string;
  readyMs: number | null;
  readyTimeout: boolean;
  heading: string | null;
  lcpMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
  apiCalls: number;
  apiEncodedBytes: number;
  apiDecodedBytes: number;
  apiTransferBytes: number;
  slowestApi: ApiCall | null;
  /** Top patterns by summed duration; `serverTiming` is the first header seen. */
  apiTopPatterns: PatternAggregate[];
  blockedWrites: number;
  /** Present only when the navigation or readiness wait failed. */
  navigationError?: string;
  wallClockMs?: number;
}

interface Median {
  readyMs: number | null;
  lcpMs: number | null;
  domContentLoadedMs: number | null;
  apiCalls: number | null;
  apiEncodedBytes: number | null;
  apiDecodedBytes: number | null;
  slowestApiMs: number | null;
}

interface PageSummary {
  key: PageKey;
  path: string;
  url: string;
  rounds: PageRound[];
  median: Median;
}

interface InboxProbeResult {
  path: string;
  status: number | null;
  decodedBytes: number | null;
  encodedBytes: number | null;
  itemCount: number | null;
  extra: Record<string, number | string | boolean | null>;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    baseUrl: DEFAULT_BASE_URL,
    rounds: DEFAULT_ROUNDS,
    outDir: DEFAULT_OUT_DIR,
    name: null,
    compare: null,
    quietMs: DEFAULT_QUIET_MS,
    settleCapMs: DEFAULT_SETTLE_CAP_MS,
    skipInboxProbe: false,
    skipInboxGuard: false,
    renderOnly: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--base-url":
        opts.baseUrl = next().replace(/\/+$/, "");
        break;
      case "--rounds":
        opts.rounds = Number.parseInt(next(), 10);
        break;
      case "--out":
        opts.outDir = next();
        break;
      case "--name":
        opts.name = next();
        break;
      case "--compare":
        opts.compare = next();
        break;
      case "--quiet-ms":
        opts.quietMs = Number.parseInt(next(), 10);
        break;
      case "--settle-cap-ms":
        opts.settleCapMs = Number.parseInt(next(), 10);
        break;
      case "--skip-inbox-probe":
        opts.skipInboxProbe = true;
        break;
      case "--skip-inbox-guard":
        opts.skipInboxGuard = true;
        break;
      case "--render-only":
        opts.renderOnly = next();
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.rounds) || opts.rounds < 1) throw new Error("--rounds must be >= 1");
  return opts;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Standalone read-only page-speed probe. Token is read from " + TOKEN_ENV + " only.",
      "",
      "  --base-url <url>       target origin (default " + DEFAULT_BASE_URL + ")",
      "  --rounds <n>           repetitions per page, each in a fresh context (default " + DEFAULT_ROUNDS + ")",
      "  --out <dir>            output directory (default " + DEFAULT_OUT_DIR + ")",
      "  --name <stem>          output file stem (default mul367-page-speed-<timestamp>)",
      "  --compare <baseline>   also emit a before/after comparison table",
      "  --quiet-ms <n>         keep sampling until the network is quiet this long (default " + DEFAULT_QUIET_MS + ")",
      "  --settle-cap-ms <n>    hard cap for that quiet window (default " + DEFAULT_SETTLE_CAP_MS + ")",
      "  --skip-inbox-probe     skip the inbox payload measurement",
      "  --skip-inbox-guard     skip the inbox auto-read guard check",
      "  --render-only <json>   re-render .md/.html from an existing report JSON (no network)",
      "",
    ].join("\n"),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Drops the query and replaces ID-like path segments with `:id`. Identifiers we
 * already know from `/api/me` + `/api/workspaces` are masked by value, because a
 * workspace id such as `local` or a slug is not recognisable by shape.
 */
function sanitizePath(rawUrl: string, origin: string, knownIds: string[] = []): string {
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    // Already a path.
  }
  const segments = pathname.split("/").filter(Boolean);
  // Structural segments are never masked even if a workspace happens to be
  // named after one; everything else that matches a known identifier is.
  const reserved = new Set([
    "api",
    "multiremi",
    "workspaces",
    "workspace",
    "v1",
    "me",
    "health",
    "auth",
    "login",
    "static",
  ]);
  const masked = new Set(knownIds.filter((id) => id.length >= 2 && !reserved.has(id)));
  const cleaned = segments.map((segment) => {
    if (masked.has(segment)) return ":id";
    const isIdLike =
      /^[0-9a-f]{8,}$/i.test(segment) ||
      /^[0-9a-f-]{20,}$/i.test(segment) ||
      /^[A-Z]{2,}-\d+$/.test(segment) ||
      /^(att|iss|tsk|agt|cmt|mem|prj|run|sess|ses|pdoc|wsp|repo|usr|evt)_[A-Za-z0-9]+$/.test(segment) ||
      /^[a-z]{2,}_[A-Za-z0-9]{8,}$/.test(segment) ||
      (/^[0-9a-f-]{6,}$/i.test(segment) && segment.includes("-"));
    return isIdLike ? ":id" : segment;
  });
  return "/" + cleaned.join("/");
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function medianOfRounds(rounds: PageRound[]): Median {
  return {
    readyMs: round1(median(rounds.map((r) => r.readyMs).filter((v): v is number => v !== null))),
    lcpMs: round1(median(rounds.map((r) => r.lcpMs).filter((v): v is number => v !== null))),
    domContentLoadedMs: round1(
      median(rounds.map((r) => r.domContentLoadedMs).filter((v): v is number => v !== null)),
    ),
    apiCalls: median(rounds.map((r) => r.apiCalls)),
    apiEncodedBytes: median(rounds.map((r) => r.apiEncodedBytes)),
    apiDecodedBytes: median(rounds.map((r) => r.apiDecodedBytes)),
    slowestApiMs: round1(
      median(
        rounds
          .map((r) => r.slowestApi?.durationMs)
          .filter((v): v is number => v !== undefined && v !== null),
      ),
    ),
  };
}

/** Finds a Chromium in the Playwright cache the way tests/integration/e2e-frontend-ours.ts does. */
function resolveCachedChromium(): string {
  const root = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  if (!existsSync(root)) return "";
  const dirs = readdirSync(root)
    .filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();
  for (const dir of dirs) {
    const candidate = join(root, dir, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

// ── Measurement ──────────────────────────────────────────────────────────────

interface PageCollectors {
  apiResponses: Map<string, { method: string; url: string; status: number | null; serverTiming: string | null }>;
  blockedWrites: BlockedWrite[];
  requestStart: Map<unknown, number>;
  /** Identifiers masked by value, not shape (workspace id/slug, member id). */
  knownIds: string[];
}

function attachCollectors(
  page: Page,
  round: number,
  pageKey: PageKey | GuardLabel,
  knownIds: string[],
): PageCollectors {
  const collectors: PageCollectors = {
    apiResponses: new Map(),
    blockedWrites: [],
    requestStart: new Map(),
    knownIds,
  };

  // Read-only guard: only GET/HEAD reach the server. Everything else is
  // aborted and reported, so a page that tries to write cannot do so.
  void page.route("**/api/**", async (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD") {
      await route.continue();
      return;
    }
    const safePath = sanitizePath(route.request().url(), "", collectors.knownIds);
    const existing = collectors.blockedWrites.find(
      (write) => write.method === method && write.path === safePath,
    );
    if (existing) existing.attempts += 1;
    else
      collectors.blockedWrites.push({
        round,
        page: pageKey,
        method,
        path: safePath,
        attempts: 1,
      });
    await route.abort();
  });

  page.on("request", (request) => {
    if (request.url().includes("/api/")) collectors.requestStart.set(request, Date.now());
  });

  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    const request = response.request();
    const started = collectors.requestStart.get(request);
    if (started !== undefined) collectors.requestStart.delete(request);
    const existing = collectors.apiResponses.get(url);
    collectors.apiResponses.set(url, {
      method: request.method(),
      url,
      status: response.status(),
      serverTiming: response.headers()["server-timing"] ?? existing?.serverTiming ?? null,
    });
  });

  return collectors;
}

/**
 * Polls the readiness rule until it holds, the timeout expires, or the page
 * navigates (evaluation errors during a navigation are retried, not fatal).
 * Afterwards it keeps sampling until the network has been quiet for `quietMs`
 * (hard-capped by `settleCapMs`) so byte accounting covers the whole load. A
 * readiness timeout still gets the quiet window, so a slow page reports
 * numbers instead of nothing.
 */
async function waitForReadyAndSettle(
  page: Page,
  startedAt: number,
  quietMs: number,
  settleCapMs: number,
  timeoutMs: number,
): Promise<{ readyMs: number | null; readyTimeout: boolean; heading: string | null }> {
  let ready = false;
  const readyDeadline = startedAt + timeoutMs;
  while (Date.now() < readyDeadline) {
    try {
      if (await page.evaluate(readyPredicate, READY_SELECTOR)) {
        ready = true;
        break;
      }
    } catch {
      // Execution context destroyed by a navigation or a client-side redirect;
      // retry on the next tick.
    }
    await page.waitForTimeout(100);
  }
  const readyMs = ready ? Date.now() - startedAt : null;

  const heading = await page
    .evaluate((selector) => {
      const inset = document.querySelector(selector);
      return inset?.querySelector("h1")?.textContent?.trim() ?? null;
    }, READY_SELECTOR)
    .catch(() => null);

  let lastActivity = Date.now();
  const bump = () => {
    lastActivity = Date.now();
  };
  page.on("request", bump);
  page.on("response", bump);
  const deadline = Date.now() + settleCapMs;
  try {
    while (Date.now() < deadline) {
      if (Date.now() - lastActivity >= quietMs) break;
      await page.waitForTimeout(100);
    }
  } finally {
    page.off("request", bump);
    page.off("response", bump);
  }

  return { readyMs, readyTimeout: !ready, heading };
}

type ResourceEntry = {
  name: string;
  duration: number;
  encodedBodySize: number;
  decodedBodySize: number;
  transferSize: number;
};

/** Reads the page's own Resource Timing entries; falls back to the live map. */
async function collectApiCalls(
  page: Page,
  origin: string,
  collectors: PageCollectors,
): Promise<ApiCall[]> {
  const entries = await page
    .evaluate(() =>
      (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      )
        .filter((entry) => entry.name.includes("/api/"))
        .map((entry) => ({
          name: entry.name,
          duration: entry.duration,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          transferSize: entry.transferSize,
        })),
    )
    .catch((): ResourceEntry[] => []);

  const calls: ApiCall[] = [];
  const matchedUrls = new Set<string>();

  // Resource Timing entries are per request, so repeated identical URLs each
  // produce one row. Response headers are matched by URL (the last response
  // wins when a URL is fetched more than once).
  for (const entry of entries) {
    const matched = collectors.apiResponses.get(entry.name);
    if (matched) matchedUrls.add(entry.name);
    calls.push({
      method: matched?.method ?? "GET",
      path: sanitizePath(entry.name, origin, collectors.knownIds),
      status: matched?.status ?? null,
      durationMs: round1(entry.duration) ?? 0,
      encodedBytes: entry.encodedBodySize,
      decodedBytes: entry.decodedBodySize,
      transferBytes: entry.transferSize,
      serverTiming: matched?.serverTiming ?? null,
    });
  }

  // A response we saw but that never published a resource entry (aborted or
  // blocked) still counts, so the API number never under-reports.
  for (const [url, info] of collectors.apiResponses) {
    if (matchedUrls.has(url)) continue;
    calls.push({
      method: info.method,
      path: sanitizePath(url, origin, collectors.knownIds),
      status: info.status,
      durationMs: 0,
      encodedBytes: 0,
      decodedBytes: 0,
      transferBytes: 0,
      serverTiming: info.serverTiming,
    });
  }

  calls.sort((a, b) => b.durationMs - a.durationMs);
  return calls;
}

async function readWebVitals(page: Page): Promise<{
  lcpMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
}> {
  return page
    .evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined;
      const samples =
        (window as unknown as { __lcpValues?: number[] }).__lcpValues ??
        (performance.getEntriesByType("largest-contentful-paint") as PerformanceEntry[]).map(
          (entry) => entry.startTime,
        );
      const lcpValue = samples.length > 0 ? samples[samples.length - 1] : null;
      return {
        lcpMs: lcpValue === null ? null : Math.round(lcpValue * 10) / 10,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd * 10) / 10 : null,
        loadEventMs: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd * 10) / 10 : null,
      };
    })
    .catch(() => ({ lcpMs: null, domContentLoadedMs: null, loadEventMs: null }));
}

/**
 * Seeds the token (auth is token mode) and installs the LCP observer before any
 * app code runs. Without the observer the entry list stays empty: Chromium only
 * queues `largest-contentful-paint` entries once something observes the type.
 */
async function seedContext(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript((value: string) => {
    try {
      window.localStorage.setItem("multimira_token", value);
    } catch {
      // Sandboxed contexts can refuse storage; the probe then reports the
      // resulting login redirect instead of hiding it.
    }
    try {
      const store: number[] = [];
      (window as unknown as { __lcpValues?: number[] }).__lcpValues = store;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.push(entry.startTime);
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      // Older engines without LCP support simply report null.
    }
  }, token);
}

async function mktContext(browser: Browser, token: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ignoreHTTPSErrors: false,
  });
  await seedContext(context, token);
  return context;
}

/**
 * Proves the abort guard itself works: a deliberate POST to `/api/inbox/unread-count`
 * must be blocked. Without this, a silent guard failure would look identical to
 * "the page never wrote anything".
 */
async function verifyWriteGuard(browser: Browser, token: string, baseUrl: string): Promise<{
  blocked: boolean;
  target: string;
  detail: string;
}> {
  const target = "/api/inbox/unread-count";
  const context = await mktContext(browser, token);
  const page = await context.newPage();
  let blocked = false;
  try {
    await page.route("**/api/**", async (route) => {
      if (route.request().method() === "GET" || route.request().method() === "HEAD") {
        await route.continue();
        return;
      }
      blocked = true;
      await route.abort();
    });
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT_MS });
    await page.evaluate(async (path: string) => {
      try {
        await fetch(path, { method: "POST" });
      } catch {
        // expected: the route handler aborts it
      }
    }, target);
    await page.waitForTimeout(500);
  } catch (error) {
    return { blocked, target, detail: `probe error: ${(error as Error).message}` };
  } finally {
    await context.close();
  }
  return {
    blocked,
    target,
    detail: blocked
      ? "POST 被 page.route 拦截并 abort，护栏生效"
      : "POST 未被拦截，护栏失效：本次 blockedWrites 不能作为只读证据",
  };
}

// ── Workspace discovery ──────────────────────────────────────────────────────

interface Identity {
  memberName: string | null;
  memberId: string | null;
  workspaceId: string | null;
  workspaceSlug: string;
  workspaceName: string | null;
}

/** Resolves the workspace slug from `/api/me` + `/api/workspaces` (no query is logged). */
async function resolveIdentity(baseUrl: string, token: string): Promise<Identity> {
  const headers = { Authorization: `Bearer ${token}` };
  const meRes = await fetch(`${baseUrl}/api/me`, { headers });
  if (!meRes.ok) throw new Error(`GET /api/me -> ${meRes.status}`);
  const me = (await meRes.json()) as { name?: string; id?: string };
  const wsRes = await fetch(`${baseUrl}/api/workspaces`, { headers });
  if (!wsRes.ok) throw new Error(`GET /api/workspaces -> ${wsRes.status}`);
  const workspaces = (await wsRes.json()) as Array<{ id?: string; slug?: string; name?: string }>;
  const first = workspaces.find((workspace) => workspace.slug);
  if (!first?.slug) throw new Error("no workspace slug available for this token");
  return {
    memberName: me.name ?? null,
    memberId: me.id ?? null,
    workspaceId: first.id ?? null,
    workspaceSlug: first.slug,
    workspaceName: first.name ?? null,
  };
}

/** Reads the live release so the report names the build it measured. */
async function readDeployedVersion(
  baseUrl: string,
  token: string,
): Promise<Record<string, string | null>> {
  try {
    const res = await fetch(`${baseUrl}/api/multiremi/platform/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as {
      currentRelease?: { version?: string; ref?: string; publishedAt?: string };
    };
    return {
      apiVersion: body.currentRelease?.version ?? null,
      apiRef: body.currentRelease?.ref ?? null,
      apiPublishedAt: body.currentRelease?.publishedAt ?? null,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * Ambient latency anchor. A production baseline is only comparable to a later
 * run if the server was in a similar state, so this measures a fixed, tiny
 * endpoint before and after the rounds. `/api/config` needs no auth state and
 * touches no user data.
 */
async function ambientProbe(baseUrl: string, samples = 7): Promise<{
  path: string;
  samplesMs: number[];
  minMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
}> {
  const samplesMs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const started = performance.now();
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      await res.arrayBuffer();
      if (res.ok) samplesMs.push(Math.round((performance.now() - started) * 10) / 10);
    } catch {
      // Unreachable target is reported by the run itself.
    }
  }
  return {
    path: "/api/config",
    samplesMs,
    minMs: samplesMs.length ? Math.min(...samplesMs) : null,
    medianMs: round1(median(samplesMs)),
    maxMs: samplesMs.length ? Math.max(...samplesMs) : null,
  };
}

// ── Inbox guard + payload probe ──────────────────────────────────────────────

/**
 * Probes the inbox write paths in throwaway contexts and aborts every write.
 *
 * Two entries are covered, because they behave differently:
 *   - plain `/inbox`: opening the page (no click) — does it auto-mark anything?
 *   - `/inbox` plus a click on the first row: the path that really marks read.
 *
 * Every non-GET/HEAD request is aborted, so the target keeps its state. The
 * page retries the aborted mutation while the row stays unread; the recorder
 * deduplicates identical method+path pairs so the report stays readable.
 */
async function inboxWriteGuard(
  browser: Browser,
  token: string,
  inboxUrl: string,
  quietMs: number,
  knownIds: string[],
): Promise<BlockedWrite[]> {
  const targets: Array<{ label: GuardLabel; clickFirstRow: boolean }> = [
    { label: "inbox-guard", clickFirstRow: false },
    { label: "inbox-guard-click", clickFirstRow: true },
  ];

  const blocked: BlockedWrite[] = [];
  const byKey = new Map<string, BlockedWrite>();
  const record = (label: GuardLabel, method: string, url: string) => {
    const path = sanitizePath(url, "", knownIds);
    const key = `${label} ${method} ${path}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.attempts += 1;
      return;
    }
    const write: BlockedWrite = { round: 0, page: label, method, path, attempts: 1 };
    byKey.set(key, write);
    blocked.push(write);
  };

  for (const target of targets) {
    const context = await mktContext(browser, token);
    const page = await context.newPage();
    void page.route("**/api/**", async (route) => {
      const method = route.request().method();
      if (method === "GET" || method === "HEAD") {
        await route.continue();
        return;
      }
      record(target.label, method, route.request().url());
      await route.abort();
    });
    try {
      const started = Date.now();
      await page.goto(inboxUrl, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT_MS });
      await waitForReadyAndSettle(page, started, quietMs, quietMs * 4, READY_TIMEOUT_MS);
      if (target.clickFirstRow) {
        // The inbox list rows are the role=button/tabindex=0 elements inside the
        // content region; clicking one is what marks a notification as read.
        const rows = page.locator(`${READY_SELECTOR} div[role="button"][tabindex="0"]`);
        const count = await rows.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 3); i++) {
          await rows.nth(i).click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(quietMs * 2);
          if (blocked.length > 0) break;
        }
      }
    } catch {
      // A guard probe failure must not fail the run; whatever was recorded is
      // still the evidence.
    } finally {
      await context.close();
    }
  }
  return blocked;
}

/** Measures the inbox endpoints the page actually uses. */
async function inboxPayloadProbe(baseUrl: string, token: string): Promise<InboxProbeResult[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const targets = [
    { path: "/api/inbox", kind: "list" as const },
    { path: "/api/inbox/summary", kind: "summary" as const },
    { path: "/api/inbox/unread-count", kind: "count" as const },
    { path: "/api/inbox/page?limit=50", kind: "page" as const },
  ];
  const results: InboxProbeResult[] = [];
  for (const target of targets) {
    try {
      const res = await fetch(`${baseUrl}${target.path}`, { headers });
      const buffer = await res.arrayBuffer();
      const decodedBytes = buffer.byteLength;
      let itemCount: number | null = null;
      const extra: Record<string, number | string | boolean | null> = {};
      try {
        const body = JSON.parse(new TextDecoder().decode(buffer)) as unknown;
        if (Array.isArray(body)) itemCount = body.length;
        else if (body && typeof body === "object") {
          const record = body as Record<string, unknown>;
          if (Array.isArray(record.items)) itemCount = record.items.length;
          if (typeof record.total === "number") extra.total = record.total;
          if (typeof record.unread === "number") extra.unread = record.unread;
          if (typeof record.attention === "number") extra.attention = record.attention;
          if (typeof record.count === "number") extra.count = record.count;
          if (typeof record.has_more === "boolean") extra.hasMore = record.has_more;
          if (typeof record.next_cursor === "string") extra.hasNextCursor = true;
        }
      } catch {
        extra.unparsable = true;
      }
      results.push({
        path: sanitizePath(target.path, ""),
        status: res.status,
        decodedBytes,
        encodedBytes: null,
        itemCount,
        extra,
      });
    } catch (error) {
      results.push({
        path: sanitizePath(target.path, ""),
        status: null,
        decodedBytes: null,
        encodedBytes: null,
        itemCount: null,
        extra: { error: (error as Error).message },
      });
    }
  }
  return results;
}

// ── Reporting ────────────────────────────────────────────────────────────────

function fmtMs(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function fmtBytes(value: number | null): string {
  if (value === null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

interface PatternAggregate {
  method: string;
  path: string;
  calls: number;
  totalMs: number;
  maxMs: number;
  encodedBytes: number;
  statuses: string;
  serverTiming: string | null;
}

/**
 * Groups calls by `method + path pattern` so a page that fans out to
 * `/api/issues?status=...` six times reports one row with six calls instead of
 * six identical-looking rows. `serverTiming` keeps the first non-null value:
 * the probe's own header sample, taken from the page's response objects.
 */
function aggregateByPattern(calls: ApiCall[]): PatternAggregate[] {
  const groups = new Map<string, PatternAggregate>();
  for (const call of calls) {
    const key = `${call.method} ${call.path}`;
    const existing = groups.get(key);
    if (existing) {
      existing.calls += 1;
      existing.totalMs += call.durationMs;
      existing.maxMs = Math.max(existing.maxMs, call.durationMs);
      existing.encodedBytes += call.encodedBytes;
      existing.statuses = existing.statuses === String(call.status)
        ? existing.statuses
        : `${existing.statuses}|${call.status}`;
      if (existing.serverTiming === null && call.serverTiming !== null) {
        existing.serverTiming = call.serverTiming;
      }
      continue;
    }
    groups.set(key, {
      method: call.method,
      path: call.path,
      calls: 1,
      totalMs: call.durationMs,
      maxMs: call.durationMs,
      encodedBytes: call.encodedBytes,
      statuses: String(call.status),
      serverTiming: call.serverTiming,
    });
  }
  return [...groups.values()].sort((a, b) => b.totalMs - a.totalMs);
}

function buildMarkdown(report: {
  meta: Record<string, unknown>;
  pages: PageSummary[];
  blockedWrites: BlockedWrite[];
  inboxProbe: InboxProbeResult[];
  inboxGuard: BlockedWrite[];
}): string {
  const lines: string[] = [];
  const meta = report.meta as {
    generatedAt?: string;
    baseUrl?: string;
    workspaceSlug?: string;
    memberName?: string;
    rounds?: number;
    runner?: string;
    mode?: string;
    readingRule?: string;
    byteAccounting?: string;
    apiVersion?: string | null;
    apiRef?: string | null;
  };

  lines.push("# MUL-367 页面测速基线");
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAt ?? "unknown"}`);
  lines.push(`- 目标：${meta.baseUrl ?? "unknown"}（工作区 \`${meta.workspaceSlug ?? "?"}\`）`);
  lines.push(`- 被测用户：${meta.memberName ?? "unknown"}`);
  lines.push(`- 运行机器：${meta.runner ?? "unknown"}`);
  lines.push(`- 运行模式：${meta.mode ?? "unknown"}`);
  lines.push(`- 每页轮数：${meta.rounds ?? "?"}`);
  lines.push(`- API 版本：${meta.apiVersion ?? "未知"}`);
  lines.push(`- 前端版本：${meta.apiRef ? "未知（未暴露版本接口）" : "未知"}`);
  lines.push("");
  lines.push("## 判定口径");
  lines.push("");
  lines.push(`- 就绪时间：从 \`page.goto\` 导航开始计时，到 ${meta.readingRule ?? "主内容区域出现非骨架内容"}。`);
  lines.push("- LCP / DOMContentLoaded 来自浏览器 Performance 条目，仅作参考。");
  lines.push(`- API 字节：${meta.byteAccounting ?? "encodedBodySize / decodedBodySize"}。`);
  lines.push("- 每轮使用一个全新的 browser context：第一页（issues）包含 app shell 冷启动成本，同轮后续页面复用该 shell。");
  const ambient = (meta as { ambientLatency?: { before?: { medianMs?: number | null; samplesMs?: number[] }; after?: { medianMs?: number | null; samplesMs?: number[] } } }).ambientLatency;
  if (ambient?.before || ambient?.after) {
    lines.push(
      `- 环境参照：\`/api/config\` 中位耗时 运行前 ${ambient.before?.medianMs ?? "-"} ms / 运行后 ${ambient.after?.medianMs ?? "-"} ms（原始样本前 ${JSON.stringify(ambient.before?.samplesMs ?? [])}，后 ${JSON.stringify(ambient.after?.samplesMs ?? [])}）。生产是共享环境，复跑对比前先核对这个参照。`,
    );
  }
  lines.push("");
  lines.push("## 每页中位数");
  lines.push("");
  lines.push("| 页面 | 就绪 ms | LCP ms | DOMContentLoaded ms | API 数 | API 传输字节 | 最慢 API ms |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const page of report.pages) {
    lines.push(
      `| ${page.key} | ${fmtMs(page.median.readyMs)} | ${fmtMs(page.median.lcpMs)} | ${fmtMs(page.median.domContentLoadedMs)} | ${page.median.apiCalls ?? "-"} | ${fmtBytes(page.median.apiEncodedBytes)} | ${fmtMs(page.median.slowestApiMs)} |`,
    );
  }
  lines.push("");
  lines.push("## 每轮明细");
  lines.push("");
  lines.push("| 轮 | 页面 | 就绪 ms | API 数 | 传输字节 | 解码字节 | 最慢 API | 耗时 ms | Server-Timing |");
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |");
  for (const page of report.pages) {
    for (const round of page.rounds) {
      const slowest = round.slowestApi;
      lines.push(
        `| ${round.round} | ${page.key} | ${fmtMs(round.readyMs)}${round.readyTimeout ? " (超时)" : ""} | ${round.apiCalls} | ${fmtBytes(round.apiEncodedBytes)} | ${fmtBytes(round.apiDecodedBytes)} | ${slowest ? `${slowest.method} \`${slowest.path}\`` : "-"} | ${slowest ? slowest.durationMs.toFixed(1) : "-"} | ${slowest?.serverTiming ?? "（本次发布无此头）"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## 每页 API Top 5（按 path 模式汇总，首轮）");
  lines.push("");
  for (const page of report.pages) {
    const reference = page.rounds[0];
    if (!reference?.apiTopPatterns.length) continue;
    lines.push(`### ${page.key}`);
    lines.push("");
    lines.push("| Method | Path 模式 | 次数 | 最慢 ms | 合计 ms | 合计传输字节 | Server-Timing |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
    for (const pattern of reference.apiTopPatterns) {
      lines.push(
        `| ${pattern.method} | \`${pattern.path}\` | ${pattern.calls} | ${pattern.maxMs.toFixed(1)} | ${pattern.totalMs.toFixed(1)} | ${fmtBytes(pattern.encodedBytes)} | ${pattern.serverTiming ?? "-"} |`,
      );
    }
    lines.push("");
  }
  lines.push("## 被拦截的写请求");
  lines.push("");
  if (report.blockedWrites.length === 0) {
    lines.push("无。页面加载过程中没有任何非 GET/HEAD 的 `/api/**` 请求。");
  } else {
    lines.push("| 轮 | 页面 | Method | Path | 尝试次数 |");
    lines.push("| ---: | --- | --- | --- | ---: |");
    for (const write of report.blockedWrites) {
      lines.push(
        `| ${write.round} | ${write.page} | ${write.method} | \`${write.path}\` | ${write.attempts} |`,
      );
    }
  }
  lines.push("");
  lines.push("## inbox 专项");
  lines.push("");
  lines.push("| 接口 | Status | 解码字节 | 条目数 | 备注 |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const probe of report.inboxProbe) {
    lines.push(
      `| \`${probe.path}\` | ${probe.status ?? "-"} | ${fmtBytes(probe.decodedBytes)} | ${probe.itemCount ?? "-"} | ${JSON.stringify(probe.extra)} |`,
    );
  }
  lines.push("");
  const selfTest = (meta as { writeGuardSelfTest?: { blocked?: boolean; target?: string; detail?: string } })
    .writeGuardSelfTest;
  if (selfTest) {
    lines.push(
      `只读护栏自检：对 \`${selfTest.target}\` 发 POST —— **${selfTest.blocked ? "已被拦截" : "未被拦截"}**。${selfTest.detail}`,
    );
    lines.push("");
  }
  if (report.inboxGuard.length === 0) {
    lines.push("inbox 页面打开时没有尝试任何写请求（自动标已读未触发）。");
  } else {
    lines.push(`inbox 页面打开时尝试了 ${report.inboxGuard.length} 个写请求，全部被 abort：`);
    lines.push("");
    for (const write of report.inboxGuard) {
      lines.push(
        `- \`${write.method} ${write.path}\`（${write.page}，尝试 ${write.attempts} 次，全部 abort）`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildComparison(
  baseline: { pages: PageSummary[]; meta: Record<string, unknown> },
  current: { pages: PageSummary[]; meta: Record<string, unknown> },
): string {
  const lines: string[] = [];
  lines.push("## 与基线对比");
  lines.push("");
  lines.push(`- 基线：${String(baseline.meta.generatedAt ?? "unknown")} (${String(baseline.meta.apiVersion ?? "unknown")})`);
  lines.push(`- 本次：${String(current.meta.generatedAt ?? "unknown")} (${String(current.meta.apiVersion ?? "unknown")})`);
  lines.push("");
  lines.push("| 页面 | 就绪 ms（基线 → 本次） | 差值 | 变化 | API 数 | 传输字节 | 差值 |");
  lines.push("| --- | --- | ---: | ---: | --- | --- | ---: |");
  for (const page of current.pages) {
    const before = baseline.pages.find((candidate) => candidate.key === page.key);
    const a = before?.median.readyMs ?? null;
    const b = page.median.readyMs ?? null;
    const delta = a !== null && b !== null ? b - a : null;
    const pct = a !== null && b !== null && a > 0 ? `${(((b - a) / a) * 100).toFixed(1)}%` : "-";
    const bytesA = before?.median.apiEncodedBytes ?? null;
    const bytesB = page.median.apiEncodedBytes ?? null;
    const bytesDelta = bytesA !== null && bytesB !== null ? bytesB - bytesA : null;
    lines.push(
      `| ${page.key} | ${fmtMs(a)} → ${fmtMs(b)} | ${delta === null ? "-" : delta.toFixed(1)} | ${pct} | ${before?.median.apiCalls ?? "-"} → ${page.median.apiCalls ?? "-"} | ${fmtBytes(bytesA)} → ${fmtBytes(bytesB)} | ${bytesDelta === null ? "-" : fmtBytes(bytesDelta)} |`,
    );
  }
  lines.push("");
  lines.push("> 差值只在同一台机器、同一网络位置、同一 rounds 下可比。");
  lines.push("");
  return lines.join("\n");
}

/**
 * Self-contained HTML rendering of one report: inline CSS, inline data, no
 * external stylesheet/script/font URL, no storage or parent-frame access. Safe
 * to attach to an issue comment (the preview iframe runs with `allow-scripts`
 * only) and safe to open from the filesystem.
 */
function buildHtml(report: {
  meta: Record<string, unknown>;
  pages: PageSummary[];
  blockedWrites: BlockedWrite[];
  inboxProbe: InboxProbeResult[];
  inboxGuard: BlockedWrite[];
}): string {
  const meta = report.meta as {
    generatedAt?: string;
    baseUrl?: string;
    workspaceSlug?: string;
    memberName?: string;
    rounds?: number;
    runner?: string;
    mode?: string;
    readingRule?: string;
    byteAccounting?: string;
    apiVersion?: string | null;
    ambientLatency?: {
      before?: { medianMs?: number | null };
      after?: { medianMs?: number | null };
    };
    writeGuardSelfTest?: { blocked?: boolean; target?: string; detail?: string };
  };
  const esc = (value: unknown): string =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const summaryRows = report.pages
    .map(
      (page) => `<tr>
    <td class="key">${esc(page.key)}</td>
    <td class="num${(page.median.readyMs ?? 0) >= 10000 ? " bad" : ""}">${fmtMs(page.median.readyMs)}</td>
    <td class="num">${fmtMs(page.median.lcpMs)}</td>
    <td class="num">${fmtMs(page.median.domContentLoadedMs)}</td>
    <td class="num">${page.median.apiCalls ?? "-"}</td>
    <td class="num">${fmtBytes(page.median.apiEncodedBytes)}</td>
    <td class="num">${fmtBytes(page.median.apiDecodedBytes)}</td>
    <td class="num">${fmtMs(page.median.slowestApiMs)}</td>
  </tr>`,
    )
    .join("\n");

  const humanBytes = (value: number | null): string =>
    value === null ? "n/a" : value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MiB` : `${(value / 1024).toFixed(1)} KiB`;
  const inboxBytes = report.inboxProbe.find((probe) => probe.path === "/api/inbox")?.decodedBytes ?? null;
  const inboxItems = report.inboxProbe.find((probe) => probe.path === "/api/inbox")?.itemCount ?? null;

  const roundRows = report.pages
    .map((page) =>
      page.rounds
        .map((round) => {
          const slowest = round.slowestApi;
          return `<tr>
      <td class="num">${round.round}</td>
      <td class="key">${esc(page.key)}</td>
      <td class="num">${fmtMs(round.readyMs)}${round.readyTimeout ? " ⚠" : ""}</td>
      <td class="num">${fmtMs(round.lcpMs)}</td>
      <td class="num">${round.apiCalls}</td>
      <td class="num">${fmtBytes(round.apiEncodedBytes)}</td>
      <td class="path">${slowest ? `${esc(slowest.method)} <code>${esc(slowest.path)}</code>` : "-"}</td>
      <td class="num">${slowest ? slowest.durationMs.toFixed(1) : "-"}</td>
      <td class="path">${slowest?.serverTiming ? esc(slowest.serverTiming) : "<span class=\"muted\">本次发布无此头</span>"}</td>
    </tr>`;
        })
        .join("\n"),
    )
    .join("\n");

  const patternBlocks = report.pages
    .map((page) => {
      const rows = page.rounds[0]?.apiTopPatterns ?? [];
      if (rows.length === 0) return "";
      return `<h3>${esc(page.key)}</h3>
  <div class="tablewrap"><table>
    <thead><tr><th>Method</th><th>Path 模式</th><th class="num">次数</th><th class="num">最慢 ms</th><th class="num">合计 ms</th><th class="num">合计传输</th><th>Server-Timing</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
      <td>${esc(row.method)}</td>
      <td class="path"><code>${esc(row.path)}</code></td>
      <td class="num">${row.calls}</td>
      <td class="num">${row.maxMs.toFixed(1)}</td>
      <td class="num">${row.totalMs.toFixed(1)}</td>
      <td class="num">${fmtBytes(row.encodedBytes)}</td>
      <td class="path">${row.serverTiming ? esc(row.serverTiming) : "-"}</td>
    </tr>`,
      )
      .join("")}</tbody>
  </table></div>`;
    })
    .join("\n");

  const blockedList = report.inboxGuard.length
    ? `<ul>${report.inboxGuard
        .map(
          (write) =>
            `<li><code>${esc(write.method)} ${esc(write.path)}</code> — ${esc(write.page)}，尝试 ${write.attempts} 次，全部 abort</li>`,
        )
        .join("")}</ul>`
    : "<p>无。打开 inbox 页面本身没有触发任何写请求。</p>";
  const pageLoadWrites = report.blockedWrites.length
    ? `<ul>${report.blockedWrites
        .map(
          (write) =>
            `<li><code>${esc(write.method)} ${esc(write.path)}</code> — 轮 ${write.round} / ${esc(write.page)}，尝试 ${write.attempts} 次</li>`,
        )
        .join("")}</ul>`
    : "<p>无。页面加载期间没有出现非 GET/HEAD 的 <code>/api/**</code> 请求。</p>";

  const inboxRows = report.inboxProbe
    .map(
      (probe) => `<tr>
      <td class="path"><code>${esc(probe.path)}</code></td>
      <td class="num">${probe.status ?? "-"}</td>
      <td class="num">${fmtBytes(probe.decodedBytes)}</td>
      <td class="num">${probe.itemCount ?? "-"}</td>
      <td class="path">${esc(JSON.stringify(probe.extra))}</td>
    </tr>`,
    )
    .join("\n");

  const ambient = meta.ambientLatency;
  const selfTest = meta.writeGuardSelfTest;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MUL-367 页面测速基线</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#1b2429;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:0}
header{background:#16202a;color:#fff;padding:28px 24px}
header h1{margin:0 0 8px;font-size:22px}
header p{margin:0;color:#c2ccd3;max-width:900px}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.meta span{border:1px solid #48565f;border-radius:4px;padding:4px 8px;font-size:12px;color:#e6ecef}
main{padding:20px 24px 40px;max-width:1280px}
section{margin:0 0 28px;padding-bottom:22px;border-bottom:1px solid #dde3e7}
h2{font-size:18px;margin:0 0 12px}
h3{font-size:14px;margin:16px 0 8px}
p{margin:0 0 10px}
ul{margin:0;padding-left:20px}
.tablewrap{overflow:auto;border:1px solid #dde3e7;border-radius:6px}
table{width:100%;border-collapse:collapse;min-width:760px}
th{position:sticky;top:0;background:#eef2f4;text-align:left;font-size:12px;color:#48565f;padding:8px 10px;border-bottom:1px solid #dde3e7}
td{padding:8px 10px;border-bottom:1px solid #eaeef0;vertical-align:top}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.key{font-weight:600}
.path{overflow-wrap:anywhere;max-width:360px}
.path code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.muted{color:#79868e}
.bad{color:#b42318;font-weight:700}
.callout{border-left:4px solid #946200;background:#fff8db;padding:10px 12px;border-radius:0 4px 4px 0;margin:12px 0}
.ok{color:#176b4d;font-weight:600}
.fail{color:#b42318;font-weight:600}
</style>
</head>
<body>
<header>
  <h1>MUL-367 · 页面测速基线</h1>
  <p>真实生产环境上的只读页面测速：每个主页面一条整页加载记录。所有非 GET/HEAD 的 <code>/api/**</code> 请求在浏览器侧被拦截并 abort。</p>
  <div class="meta">
    <span>${esc(meta.generatedAt)}</span>
    <span>${esc(meta.baseUrl)}</span>
    <span>工作区 ${esc(meta.workspaceSlug)}</span>
    <span>API ${esc(meta.apiVersion ?? "未知")}</span>
    <span>${esc(meta.rounds)} 轮 / 页</span>
    <span>${esc(meta.mode?.split(" via ")[0] ?? "")}</span>
  </div>
</header>
<main>
<section>
  <h2>结论与口径</h2>
  <div class="callout">
    <b>这组数字是「劣化态基线」。</b> 采集期间生产本身很慢：运行前后各 7 次 <code>/api/config</code> 的中位耗时分别是
    ${esc(ambient?.before?.medianMs ?? "-")} ms 与 ${esc(ambient?.after?.medianMs ?? "-")} ms。明天发布后复跑必须在<b>同一台机器</b>上，并先核对这个参照值，再谈页面数字的升降。
  </div>
  <p>就绪口径：${esc(meta.readingRule)}。每轮一个全新 browser context，逐页整页加载；每轮第一页（issues）含 app shell 冷启动，同轮后续页面复用该 shell。</p>
  <p>字节口径：${esc(meta.byteAccounting)}。运行机器：${esc(meta.runner)}。被测用户：${esc(meta.memberName)}。</p>
</section>
<section>
  <h2>每页中位数</h2>
  <div class="tablewrap"><table>
    <thead><tr><th>页面</th><th class="num">就绪 ms</th><th class="num">LCP ms</th><th class="num">DCL ms</th><th class="num">API 数</th><th class="num">API 传输</th><th class="num">API 解码</th><th class="num">最慢 API ms</th></tr></thead>
    <tbody>
${summaryRows}
    </tbody>
  </table></div>
</section>
<section>
  <h2>每轮明细</h2>
  <div class="tablewrap"><table>
    <thead><tr><th class="num">轮</th><th>页面</th><th class="num">就绪 ms</th><th class="num">LCP ms</th><th class="num">API 数</th><th class="num">传输字节</th><th>最慢 API</th><th class="num">耗时 ms</th><th>Server-Timing</th></tr></thead>
    <tbody>
${roundRows}
    </tbody>
  </table></div>
</section>
<section>
  <h2>每页 API Top 5（按 path 模式汇总，首轮）</h2>
  ${patternBlocks}
</section>
<section>
  <h2>只读护栏</h2>
  <p>护栏自检：对 <code>${esc(selfTest?.target)}</code> 发 POST — <span class="${selfTest?.blocked ? "ok" : "fail"}">${selfTest?.blocked ? "已被拦截" : "未被拦截"}</span>。${esc(selfTest?.detail)}</p>
  <h3>inbox 自动标已读</h3>
  ${blockedList}
  <h3>页面加载期间的写请求</h3>
  ${pageLoadWrites}
</section>
<section>
  <h2>inbox 体积核实</h2>
  <p>真实用户下 <code>/api/inbox</code> 返回 <b>${humanBytes(inboxBytes)}</b>（解码后），共 <b>${esc(inboxItems ?? "-")}</b> 条；页面实际使用的分页接口每页 50 条。</p>
  <div class="tablewrap"><table>
    <thead><tr><th>接口</th><th class="num">Status</th><th class="num">解码字节</th><th class="num">条目数</th><th>备注</th></tr></thead>
    <tbody>
${inboxRows}
    </tbody>
  </table></div>
</section>
</main>
</body>
</html>
`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * One load of one page inside a round's browser context. `order` 1 means the
 * first navigation of that context, which is the only load that pays app-shell
 * cold start; later pages in the same round reuse the shell.
 */
async function runPageRound(
  context: BrowserContext,
  token: string,
  url: string,
  pageKey: PageKey,
  round: number,
  order: number,
  opts: Options,
  allBlocked: BlockedWrite[],
  knownIds: string[],
): Promise<PageRound> {
  void token;
  const page = await context.newPage();
  const collectors = attachCollectors(page, round, pageKey, knownIds);
  const started = Date.now();

  let navigationError: string | null = null;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT_MS });
  } catch (error) {
    navigationError = (error as Error).message;
  }

  const ready = await waitForReadyAndSettle(
    page,
    started,
    opts.quietMs,
    opts.settleCapMs,
    READY_TIMEOUT_MS,
  );

  const vitals = await readWebVitals(page);
  const calls = await collectApiCalls(page, opts.baseUrl, collectors);
  const totalMs = Date.now() - started;

  await page.close();
  allBlocked.push(...collectors.blockedWrites);

  return {
    round,
    order,
    coldShellStart: order === 1,
    url,
    readyMs: round1(ready.readyMs),
    readyTimeout: ready.readyTimeout,
    heading: ready.heading,
    lcpMs: vitals.lcpMs,
    domContentLoadedMs: vitals.domContentLoadedMs,
    loadEventMs: vitals.loadEventMs,
    apiCalls: calls.length,
    apiEncodedBytes: calls.reduce((sum, call) => sum + call.encodedBytes, 0),
    apiDecodedBytes: calls.reduce((sum, call) => sum + call.decodedBytes, 0),
    apiTransferBytes: calls.reduce((sum, call) => sum + call.transferBytes, 0),
    slowestApi: calls[0] ?? null,
    apiTopPatterns: aggregateByPattern(calls).slice(0, 5),
    blockedWrites: collectors.blockedWrites.length,
    wallClockMs: totalMs,
    ...(navigationError ? { navigationError } : {}),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.renderOnly) {
    // Report iteration does not need a re-measurement: rebuild the Markdown and
    // HTML from the JSON a previous run already wrote.
    const source = resolve(opts.renderOnly);
    const report = JSON.parse(readFileSync(source, "utf8")) as {
      meta: Record<string, unknown>;
      pages: PageSummary[];
      blockedWrites: BlockedWrite[];
      inboxProbe: InboxProbeResult[];
      inboxGuard: BlockedWrite[];
    };
    const stem = source.replace(/\.json$/, "");
    writeFileSync(`${stem}.md`, buildMarkdown(report), "utf8");
    writeFileSync(`${stem}.html`, buildHtml(report), "utf8");
    process.stdout.write(`re-rendered ${stem}.md\nre-rendered ${stem}.html\n`);
    return;
  }

  const token = process.env[TOKEN_ENV];
  if (!token) {
    throw new Error(
      `${TOKEN_ENV} is empty. This probe reads the production token from that variable only; ` +
        "provide it via the QA Agent Custom Env and never paste it into a command line.",
    );
  }

  const chromiumPath = resolveCachedChromium();
  const identity = await resolveIdentity(opts.baseUrl, token);
  // Mask identifiers by value: a slug like `remi` or an id like `local` has no
  // distinctive shape, so shape-based masking alone would leak them.
  const knownIds = [identity.workspaceId, identity.workspaceSlug, identity.memberId].filter(
    (value): value is string => typeof value === "string" && value.length > 2,
  );
  const deployed = await readDeployedVersion(opts.baseUrl, token);
  const runner = `${hostname()} (${platform()} ${osRelease()} ${arch()}, ${cpus().length} vCPU, ${Math.round(totalmem() / 1024 ** 3)} GiB RAM)`;

  process.stdout.write(
    `page-speed: ${opts.baseUrl} workspace=${identity.workspaceSlug} rounds=${opts.rounds} pages=${PAGE_SEQUENCE.length}\n`,
  );

  const browser = await chromium.launch({
    executablePath: chromiumPath === "" ? undefined : chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const summaries = new Map<PageKey, PageSummary>();
  const allBlocked: BlockedWrite[] = [];
  let inboxGuard: BlockedWrite[] = [];
  const ambientBefore = await ambientProbe(opts.baseUrl);
  process.stdout.write(
    `  ambient /api/config before: min=${fmtMs(ambientBefore.minMs)}ms median=${fmtMs(ambientBefore.medianMs)}ms max=${fmtMs(ambientBefore.maxMs)}ms\n`,
  );
  const guardSelfTest = opts.skipInboxGuard
    ? null
    : await verifyWriteGuard(browser, token, opts.baseUrl);
  if (guardSelfTest) {
    process.stdout.write(
      `  guard self-test: ${guardSelfTest.blocked ? "PASS" : "FAIL"} (${guardSelfTest.detail})\n`,
    );
  }

  try {
    for (let round = 1; round <= opts.rounds; round++) {
      // One context per round: the first page pays the app-shell cold start and
      // the rest reuse its HTTP cache, which is what a real session looks like.
      const context = await mktContext(browser, token);
      try {
        let order = 0;
        for (const target of PAGE_SEQUENCE) {
          order += 1;
          const url = `${opts.baseUrl}${target.path.replace("{slug}", identity.workspaceSlug)}`;
          const result = await runPageRound(
            context,
            token,
            url,
            target.key,
            round,
            order,
            opts,
            allBlocked,
            knownIds,
          );
          const existing = summaries.get(target.key);
          if (existing) existing.rounds.push(result);
          else
            summaries.set(target.key, {
              key: target.key,
              path: target.path,
              url,
              rounds: [result],
              median: {} as Median,
            });
          const slowest = result.slowestApi;
          process.stdout.write(
            `  round ${round} ${target.key.padEnd(11)} ready=${fmtMs(result.readyMs)}ms api=${result.apiCalls} bytes=${fmtBytes(result.apiEncodedBytes)} slowest=${slowest ? `${slowest.path} ${slowest.durationMs.toFixed(0)}ms` : "-"}\n`,
          );
        }
      } finally {
        await context.close();
      }
    }

    if (!opts.skipInboxGuard) {
      const inboxUrl = `${opts.baseUrl}/${identity.workspaceSlug}/inbox`;
      inboxGuard = await inboxWriteGuard(browser, token, inboxUrl, opts.quietMs, knownIds);
    }
  } finally {
    await browser.close();
  }

  const pages = PAGE_SEQUENCE.map((target) => {
    const summary = summaries.get(target.key);
    if (!summary) throw new Error(`no samples collected for ${target.key}`);
    summary.median = medianOfRounds(summary.rounds);
    return summary;
  });

  const ambientAfter = await ambientProbe(opts.baseUrl);
  process.stdout.write(
    `  ambient /api/config after:  min=${fmtMs(ambientAfter.minMs)}ms median=${fmtMs(ambientAfter.medianMs)}ms max=${fmtMs(ambientAfter.maxMs)}ms\n`,
  );

  const inboxProbe = opts.skipInboxProbe ? [] : await inboxPayloadProbe(opts.baseUrl, token);

  const generatedAt = new Date().toISOString();
  const meta: Record<string, unknown> = {
    issue: "MUL-367",
    generatedAt,
    baseUrl: opts.baseUrl,
    workspaceSlug: identity.workspaceSlug,
    workspaceName: identity.workspaceName,
    memberName: identity.memberName,
    rounds: opts.rounds,
    runner,
    mode: "headless Chromium (no desktop session) via frontend/scripts/perf/page-speed.ts",
    viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
    readingRule: READY_RULE_SOURCE,
    byteAccounting:
      "encodedBodySize=压缩后传输体积，decodedBodySize=解压后 JSON 体积，transferSize=含响应头的传输体积",
    lcpNote: "LCP 由 PerformanceObserver 类型条目读取；无候选时为 null",
    // Only the cache revision is recorded: the absolute path embeds the
    // runner's home directory, which does not belong in a shared report.
    chromium:
      chromiumPath === ""
        ? "playwright default"
        : `playwright cached ${chromiumPath.split("/").slice(-3)[0] ?? "chromium"}`,
    writeGuardSelfTest: guardSelfTest,
    ambientLatency: { before: ambientBefore, after: ambientAfter },
    ambientNote:
      "生产为共享环境：同一台机器复跑时，先看 /api/config 的中位耗时是否与本次接近，再比较页面数字。",
    ...deployed,
  };

  const payload = {
    meta,
    pages,
    blockedWrites: allBlocked,
    inboxProbe: opts.skipInboxProbe ? [] : inboxProbe,
    inboxGuard: opts.skipInboxGuard ? [] : inboxGuard,
  };

  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const stem = opts.name ?? `mul367-page-speed-${generatedAt.replace(/[:.]/g, "-")}`;
  const jsonPath = join(outDir, `${stem}.json`);
  const mdPath = join(outDir, `${stem}.md`);
  const htmlPath = join(outDir, `${stem}.html`);
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeFileSync(
    htmlPath,
    buildHtml({ meta, pages, blockedWrites: allBlocked, inboxProbe: payload.inboxProbe, inboxGuard: payload.inboxGuard }),
    "utf8",
  );
  writeFileSync(
    mdPath,
    `${buildMarkdown({ meta, pages, blockedWrites: allBlocked, inboxProbe: payload.inboxProbe, inboxGuard: payload.inboxGuard })}`,
    "utf8",
  );

  process.stdout.write(`\nwrote ${jsonPath}\nwrote ${mdPath}\nwrote ${htmlPath}\n`);
  if (opts.compare) {
    const baseline = JSON.parse(readFileSync(resolve(opts.compare), "utf8")) as {
      pages: PageSummary[];
      meta: Record<string, unknown>;
    };
    const comparison = buildComparison(baseline, { pages, meta });
    const comparePath = join(outDir, `${stem}-compare.md`);
    writeFileSync(comparePath, comparison, "utf8");
    process.stdout.write(`wrote ${comparePath}\n`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`page-speed failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
