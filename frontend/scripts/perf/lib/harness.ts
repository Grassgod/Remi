/**
 * Browser plumbing shared by the MUL-383 page-speed probe: identity resolution,
 * the read-only write guard, API/resource collection and the ambient anchor.
 *
 * Ported from the MUL-367 `page-speed.ts`, with the read-only guarantee and the
 * token handling kept exactly as they were: the token comes from
 * `MULTIREMI_QA_WEB_TOKEN` only, is written into the target origin's
 * `localStorage.multimira_token`, and never reaches argv, a log line or a report.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  inboxItemsFromBody,
  injectInboxTarget,
  isInboxReadStateEndpoint,
  isStubbedWrite,
  rewriteInboxReadState,
  STUBBED_WRITES,
  stubbedReadResponseBody,
  stubbedWriteItemId,
} from "./stub-writes";

export const TOKEN_ENV = "MULTIREMI_QA_WEB_TOKEN";
export const VIEWPORT = { width: 1440, height: 900 };
export const READY_TIMEOUT_MS = 20_000;

export interface Identity {
  memberName: string | null;
  memberId: string | null;
  workspaceId: string | null;
  workspaceSlug: string;
  workspaceName: string | null;
}

export interface BlockedWrite {
  round: number;
  page: string;
  method: string;
  path: string;
  /** How many identical attempts the page made (mutations retry while aborted). */
  attempts: number;
}

export interface ApiResponseInfo {
  method: string;
  url: string;
  status: number | null;
  serverTiming: string | null;
  clientVersion: string | null;
}

export interface StubbedWrite {
  round: number;
  page: string;
  method: string;
  path: string;
  /** How many times this allowed write was fulfilled. */
  attempts: number;
}

export interface ApiCollectors {
  responses: Map<string, ApiResponseInfo>;
  blockedWrites: BlockedWrite[];
  /**
   * Writes the allow-list fulfilled instead of aborting. Kept separate from
   * `blockedWrites` so the read-only guarantee stays auditable: everything in
   * `blockedWrites` was stopped, everything in `stubbedWrites` never left the
   * browser. See `lib/stub-writes.ts`.
   */
  stubbedWrites: StubbedWrite[];
  /** Item ids this context has stubbed a mark-read for. */
  stubbedItemIds: Set<string>;
  /**
   * Snapshot of the inbox bodies this context served, so a stubbed POST can answer
   * with the item the server would have returned. Keyed by item id.
   */
  inboxItemSnapshot: Map<string, Record<string, unknown>>;
  /** Identifiers masked by value, not shape (workspace id/slug, member id). */
  knownIds: string[];
  webClientVersion: string | null;
  /** Response bodies of timeline requests, keyed by request URL. */
  timelineBodies: Map<string, unknown>;
  /**
   * The deep-link target this round wants on the browser's first inbox page, or
   * null for every other scenario. See `injectInboxTarget`.
   */
  inboxTarget: Record<string, unknown> | null;
  /** True once a first-page response had to have the target added. */
  inboxInjected: boolean;
  /** GET `/api/inbox/page` responses served before the first stubbed write. */
  inboxPageRequestsBeforeStub: number;
  /** Stubbed-write counters seen at the moment the first stub was fulfilled. */
  inboxPageRequestsAtFirstStub: number | null;
}

/**
 * Drops the query and replaces ID-like path segments with `:id`. Identifiers we
 * already know from `/api/me` + `/api/workspaces` are masked by value, because a
 * workspace id such as `local` is not recognisable by shape.
 */
export function sanitizePath(rawUrl: string, origin: string, knownIds: string[] = []): string {
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    // Already a path.
  }
  const segments = pathname.split("/").filter(Boolean);
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
      /^(att|iss|tsk|agt|cmt|mem|prj|run|sess|ses|pdoc|wsp|repo|usr|evt|inb)_[A-Za-z0-9]+$/.test(segment) ||
      /^[a-z]{2,}_[A-Za-z0-9]{8,}$/.test(segment) ||
      (/^[0-9a-f-]{6,}$/i.test(segment) && segment.includes("-"));
    return isIdLike ? ":id" : segment;
  });
  return "/" + cleaned.join("/");
}

export function resolveCachedChromium(): string {
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

export async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveCachedChromium();
  return chromium.launch({
    executablePath: executablePath === "" ? undefined : executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/** Seeds the token and the LCP observer before any app code runs. */
export async function seedContext(context: BrowserContext, token: string, initScripts: unknown[] = []): Promise<void> {
  await context.addInitScript((value: string) => {
    try {
      window.localStorage.setItem("multimira_token", value);
    } catch {
      // A sandboxed context can refuse storage; the probe then reports the
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
      // Older engines without LCP support report null.
    }
  }, token);
  for (const script of initScripts) {
    await context.addInitScript(script as never);
  }
}

export async function mktContext(
  browser: Browser,
  token: string,
  initScripts: unknown[] = [],
  /** Target origin, when the caller needs the dashboard's session cookie too. */
  origin?: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: false });
  await seedContext(context, token, initScripts);
  if (origin) await seedSessionCookies(context, origin);
  return context;
}

/**
 * The dashboard routes are gated by `proxy.ts`, which reads the
 * `multimira_logged_in` cookie at request time — it cannot see the localStorage
 * token. Without this cookie every measured page is a login redirect, which
 * looks like a probe bug rather than a missing fixture. Token mode is what
 * `localStorage.multimira_token` (set by {@link seedContext}) drives for the
 * API calls themselves.
 */
export async function seedSessionCookies(context: BrowserContext, origin: string): Promise<void> {
  // `last_workspace_slug` is left to the app: it writes that cookie itself once
  // a workspace route renders, and the probe always navigates to an explicit
  // `/{slug}/...` path, so no redirect decision depends on it.
  await context.addCookies([{ name: "multimira_logged_in", value: "1", url: origin }]).catch(() => {});
}

/**
 * Attaches the read-only guard and the API collectors to one page.
 *
 * The guard aborts every non-GET/HEAD `/api/**` request inside `page.route()`,
 * so a page that tries to write cannot reach the server; each distinct
 * method+path pair is reported with its attempt count.
 */
export function attachCollectors(
  page: Page,
  round: number,
  label: string,
  knownIds: string[],
  options: { inboxTarget?: Record<string, unknown> | null } = {},
): ApiCollectors {
  const collectors: ApiCollectors = {
    responses: new Map(),
    blockedWrites: [],
    stubbedWrites: [],
    stubbedItemIds: new Set(),
    inboxItemSnapshot: new Map(),
    knownIds,
    webClientVersion: null,
    timelineBodies: new Map(),
    inboxTarget: options.inboxTarget ?? null,
    inboxInjected: false,
    inboxPageRequestsBeforeStub: 0,
    inboxPageRequestsAtFirstStub: null,
  };

  void page.route("**/api/**", async (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (method === "GET" || method === "HEAD") {
      await continueWithStubbedReadState(route, method, url, collectors);
      return;
    }
    // The allow-list is explicit and one entry long; anything else is aborted, so
    // production still never receives a write. See `lib/stub-writes.ts` for why
    // `POST /api/inbox/:id/read` is fulfilled rather than stopped: aborting it puts
    // the inbox into a retry loop that delays the URL commit past the assertion
    // window (measured on 209, MUL-384 `cmt_cxrxocj4vp3q`).
    if (isStubbedWrite(method, url)) {
      const safePath = sanitizePath(url, "", collectors.knownIds);
      const existing = collectors.stubbedWrites.find(
        (write) => write.method === method && write.path === safePath,
      );
      if (!existing) {
        // Freeze the page-request count at the first stub: anything after this is
        // the mark-read loop, not the initial load.
        collectors.inboxPageRequestsAtFirstStub = collectors.inboxPageRequestsBeforeStub;
      }
      if (existing) existing.attempts += 1;
      else collectors.stubbedWrites.push({ round, page: label, method, path: safePath, attempts: 1 });
      const itemId = stubbedWriteItemId(url);
      if (itemId) collectors.stubbedItemIds.add(itemId);
      await route.fulfill({
        status: 200,
        json: stubbedReadResponseBody(itemId ?? "", collectors.inboxItemSnapshot),
      });
      return;
    }
    const safePath = sanitizePath(url, "", collectors.knownIds);
    const existing = collectors.blockedWrites.find(
      (write) => write.method === method && write.path === safePath,
    );
    if (existing) existing.attempts += 1;
    else collectors.blockedWrites.push({ round, page: label, method, path: safePath, attempts: 1 });
    await route.abort();
  });

  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    const request = response.request();
    const clientVersion = request.headers()["x-client-version"] ?? null;
    if (!collectors.webClientVersion && clientVersion) collectors.webClientVersion = clientVersion;
    const existing = collectors.responses.get(url);
    collectors.responses.set(url, {
      method: request.method(),
      url,
      status: response.status(),
      serverTiming: response.headers()["server-timing"] ?? existing?.serverTiming ?? null,
      clientVersion: clientVersion ?? existing?.clientVersion ?? null,
    });
    if (new URL(url).pathname.endsWith("/timeline")) {
      void response
        .json()
        .then((body: unknown) => {
          collectors.timelineBodies.set(url, body);
        })
        .catch(() => {});
    }
  });

  return collectors;
}

/**
 * Forwards a GET, rewriting the inbox read state first when this context has
 * stubbed any mark-read call.
 *
 * The rewrite is what makes the stub terminate: `useMarkInboxItemsRead` has no
 * `onSuccess` and invalidates on settle, so the loop only ends when the refetched
 * page reports `read: true` for the stubbed item. `unread-count` and `summary` are
 * deliberately left alone — they only drive the sidebar badge.
 */
async function continueWithStubbedReadState(
  route: Route,
  method: string,
  url: string,
  collectors: ApiCollectors,
): Promise<void> {
  const isInboxRead = isInboxReadStateEndpoint(method, url);
  // A deeplink round rewrites every inbox read-state response, whether or not a
  // mark-read has happened yet: the target has to be on the first page from the
  // very first load, and going through fetch+fulfill on every request keeps that
  // fixed cost identical in each deeplink round. Every other scenario keeps the
  // old behaviour (forward until a stub exists).
  const wantsInjection = collectors.inboxTarget !== null && isInboxRead;
  if (!isInboxRead || (!wantsInjection && collectors.stubbedItemIds.size === 0)) {
    await route.continue();
    return;
  }
  if (isInboxPageRequest(method, url) && collectors.inboxPageRequestsAtFirstStub === null) {
    collectors.inboxPageRequestsBeforeStub += 1;
  }
  try {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    for (const item of inboxItemsFromBody(body)) {
      const id = typeof item.id === "string" ? item.id : null;
      if (id) collectors.inboxItemSnapshot.set(id, item);
    }
    if (collectors.inboxTarget) {
      const target = collectors.inboxTarget;
      const targetId = typeof target.id === "string" ? target.id : null;
      const hasCursor = hasCursorParam(url);
      const injected = injectInboxTarget(body, target, { hasCursor });
      // "Injected" means the first page did not already carry the target — the
      // reader needs that to tell a natural first-screen hit from a prepared one.
      if (!hasCursor && targetId && !pageContainsId(body, targetId)) collectors.inboxInjected = true;
      for (const item of inboxItemsFromBody(injected)) {
        const id = typeof item.id === "string" ? item.id : null;
        if (id) collectors.inboxItemSnapshot.set(id, item);
      }
      await route.fulfill({
        response,
        json: rewriteInboxReadState(injected, collectors.stubbedItemIds),
      });
      return;
    }
    await route.fulfill({
      response,
      json: rewriteInboxReadState(body, collectors.stubbedItemIds),
    });
  } catch {
    // The rewrite must never turn a readable API into a failed one; an unreadable
    // body simply passes through and the self-check will catch a stuck loop.
    await route.continue();
  }
}

/** True for `GET /api/inbox/page` — the request the injection counts. */
function isInboxPageRequest(method: string, rawUrl: string): boolean {
  const upper = method.toUpperCase();
  return (upper === "GET" || upper === "HEAD") && pathnameWithoutQuery(rawUrl) === "/api/inbox/page";
}

/**
 * Whether this inbox-page request carries a cursor. The response shape cannot say,
 * and the injection behaves differently for the first page (add) and later pages
 * (remove), so the request URL is the signal.
 */
function hasCursorParam(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).searchParams.has("cursor");
  } catch {
    return /[?&]cursor=/.test(rawUrl);
  }
}

function pathnameWithoutQuery(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return (rawUrl.split("?")[0] ?? rawUrl).replace(/^https?:\/\/[^/]+/, "");
  }
}

function pageContainsId(body: unknown, id: string): boolean {
  return inboxItemsFromBody(body).some((item) => item.id === id);
}

export interface ResourceEntry {
  index: number;
  name: string;
  path: string;
  startMs: number;
  responseEndMs: number;
  durationMs: number;
  encodedBytes: number;
  decodedBytes: number;
  transferBytes: number;
  serverTiming: string | null;
  method: string;
  status: number | null;
  /** `script` entries feed the JS chunk accounting. */
  initiatorType: string;
}

/** Reads the page's own Resource Timing entries for `/api` and `script` requests. */
export async function readResourceEntries(page: Page, origin: string, knownIds: string[]): Promise<ResourceEntry[]> {
  const entries = await page
    .evaluate(() =>
      (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((entry) => entry.name.includes("/api/") || entry.initiatorType === "script")
        .map((entry) => ({
          name: entry.name,
          startMs: entry.startTime,
          responseEndMs: entry.responseEnd,
          durationMs: entry.duration,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          transferSize: entry.transferSize,
          initiatorType: entry.initiatorType,
          serverTiming: (entry as PerformanceResourceTiming & { serverTiming?: Array<{ name: string; duration?: number; description?: string }> }).serverTiming,
        })),
    )
    .catch(() => [] as Array<Record<string, unknown>>);

  return entries.map((entry, index) => {
    const timing = (entry.serverTiming ?? []) as Array<{ name: string; duration?: number; description?: string }>;
    const fromEntry = timing.length > 0
      ? timing
          .map((metric) =>
            metric.duration !== undefined
              ? `${metric.name};dur=${metric.duration.toFixed(1)}`
              : `${metric.name};desc="${metric.description ?? ""}"`,
          )
          .join(", ")
      : null;
    const name = String(entry.name);
    return {
      index,
      name,
      path: sanitizePath(name, origin, knownIds),
      startMs: Math.round(Number(entry.startMs ?? 0) * 10) / 10,
      responseEndMs: Math.round(Number(entry.responseEndMs ?? 0) * 10) / 10,
      durationMs: Math.round(Number(entry.durationMs ?? 0) * 10) / 10,
      encodedBytes: Number(entry.encodedBodySize ?? 0),
      decodedBytes: Number(entry.decodedBodySize ?? 0),
      transferBytes: Number(entry.transferSize ?? 0),
      serverTiming: fromEntry,
      method: "GET",
      status: null,
      initiatorType: String(entry.initiatorType ?? ""),
    };
  });
}

/** Parses a `Server-Timing` header into the API's `{total, db, dbp, dbq, dbb}` shape. */
export function parseServerTiming(raw: string | null): {
  total: number | null;
  db: number | null;
  dbp: number | null;
  dbq: number | null;
  dbb: number | null;
} {
  const out = { total: null, db: null, dbp: null, dbq: null, dbb: null } as {
    total: number | null;
    db: number | null;
    dbp: number | null;
    dbq: number | null;
    dbb: number | null;
  };
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const [name, ...params] = part.trim().split(";");
    const key = (name ?? "").trim();
    if (!(key in out)) continue;
    for (const param of params) {
      const [rawKey, rawValue] = param.split("=");
      if ((rawKey ?? "").trim() !== "dur") continue;
      const value = Number.parseFloat((rawValue ?? "").replace(/"/g, ""));
      if (Number.isFinite(value)) out[key as keyof typeof out] = value;
    }
  }
  return out;
}

export async function readWebVitals(page: Page): Promise<{
  lcpMs: number | null;
  domContentLoadedMs: number | null;
  loadEventMs: number | null;
}> {
  return page
    .evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const samples =
        (window as unknown as { __lcpValues?: number[] }).__lcpValues ??
        (performance.getEntriesByType("largest-contentful-paint") as PerformanceEntry[]).map((entry) => entry.startTime);
      const lcpValue = samples.length > 0 ? samples[samples.length - 1] : null;
      return {
        lcpMs: lcpValue === null ? null : Math.round(lcpValue! * 10) / 10,
        domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd * 10) / 10 : null,
        loadEventMs: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd * 10) / 10 : null,
      };
    })
    .catch(() => ({ lcpMs: null, domContentLoadedMs: null, loadEventMs: null }));
}

export async function resolveIdentity(baseUrl: string, token: string): Promise<Identity> {
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

/** Reduces `ghcr.io/org/image@sha256:...` to `sha256:abcd1234` for the report. */
function digestOf(imageRef: string | undefined): string | null {
  if (!imageRef) return null;
  const digest = imageRef.split("@")[1];
  if (!digest) return null;
  const [algorithm, value] = digest.split(":");
  return value ? `${algorithm}:${value.slice(0, 12)}` : null;
}

/** Reads the live release so the report names the build it measured. */
export async function readDeployedVersion(
  baseUrl: string,
  token: string,
): Promise<Record<string, string | null>> {
  try {
    const res = await fetch(`${baseUrl}/api/multiremi/platform/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as {
      currentRelease?: { version?: string; ref?: string; publishedAt?: string; apiImage?: string; webImage?: string };
    };
    const current = body.currentRelease;
    return {
      apiVersion: current?.version ?? null,
      apiRef: current?.ref ?? null,
      apiPublishedAt: current?.publishedAt ?? null,
      apiImageDigest: digestOf(current?.apiImage),
      webImageDigest: digestOf(current?.webImage),
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Ambient latency anchor: `/api/config` needs no auth state and touches no user
 * data, so its median tells a later reader whether the shared server was in a
 * comparable state.
 */
export async function ambientProbe(baseUrl: string, samples = 7): Promise<{
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
      // An unreachable target is reported by the run itself.
    }
  }
  return {
    path: "/api/config",
    samplesMs,
    minMs: samplesMs.length ? Math.min(...samplesMs) : null,
    medianMs: median(samplesMs),
    maxMs: samplesMs.length ? Math.max(...samplesMs) : null,
  };
}

/**
 * Proves the abort guard itself works: a deliberate POST to
 * `/api/inbox/unread-count` must be blocked. Without this, a silently broken
 * guard looks identical to "the page never wrote anything".
 */
export async function verifyWriteGuard(
  browser: Browser,
  token: string,
  baseUrl: string,
): Promise<{ blocked: boolean; target: string; detail: string; allowedWrites: string[] }> {
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
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT_MS }).catch(() => {});
    await page.evaluate(async (path: string) => {
      try {
        await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      } catch {
        // The abort surfaces here; that is the expected outcome.
      }
    }, target);
    return {
      blocked,
      target,
      detail: blocked
        ? `deliberate POST ${target} was aborted by the guard`
        : `POST ${target} was NOT aborted — the write guard is not working`,
      allowedWrites: STUBBED_WRITES.map((rule) => rule.label),
    };
  } catch (error) {
    return {
      blocked,
      target,
      detail: (error as Error).message,
      allowedWrites: STUBBED_WRITES.map((rule) => rule.label),
    };
  } finally {
    await context.close();
  }
}
