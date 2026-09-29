#!/usr/bin/env bun
// Production Next + real local API + temporary SQLite + Chromium.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";
import { seedZeroJumpFixture } from "./zero-jump-fixture";
import { launchBrowser, mktContext } from "../../frontend/scripts/perf/lib/harness";

const root = resolve(import.meta.dir, "../..");
const out = join(root, "reports/performance/MUL-444-step3");
mkdirSync(out, { recursive: true });
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) throw new Error(name);
}
function port(start: number): number {
  for (let p = start; p < start + 100; p++) {
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: p, fetch: () => new Response() });
      probe.stop(true);
      return p;
    } catch {}
  }
  throw new Error("No free local port");
}
async function waitHttp(url: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await Bun.sleep(150);
  }
  throw new Error("Local Next service did not start");
}

const db = new Database(":memory:");
const store = new MultiremiStore(db);
const fixture = await seedZeroJumpFixture(store);
const chat = store.createChatSession({ agentId: fixture.parentOwnerAgentId,
  workspaceId: fixture.workspaceId, creatorId: fixture.userId, title: "Chat log browser probe" });
for (let index = 1; index <= 40; index++)
  store.sendChatMessage(chat.id, { body: `Chat history ${index}` });
const credential = (await store.createAccessToken({ name: "MUL-444 Chat local probe", type: "pat", purpose: "session",
  workspaceId: fixture.workspaceId, userId: fixture.userId, expiresInDays: 1 })).token;
const apiPort = port(18700);
const proxyPort = port(18800);
const webPort = port(18900);
const origin = `http://localhost:${webPort}`;
const upstream = `http://127.0.0.1:${apiPort}`;
let ssrMode: "ok" | "401" | "503" | "timeout" = "ok";
const server = startMultiremiServer({ store, port: apiPort, hostname: "127.0.0.1", authToken: null, backgroundJobs: false });
const seeded = store.conversationLogWindow(chat.id, { before: 30 });
check("seeded Chat session exposes a 30-row log tail", seeded.entries.length === 30,
  { rows: seeded.entries.length, head: seeded.head_seq });
const proxy = Bun.serve({ hostname: "127.0.0.1", port: proxyPort,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.has("cookie") && !request.headers.has("authorization") && url.pathname.endsWith("/log")) {
      if (ssrMode === "timeout") await Bun.sleep(1_100);
      if (ssrMode !== "ok") return new Response("unavailable", { status: ssrMode === "401" ? 401 : 503 });
    }
    try {
      return await fetch(new Request(`${upstream}${url.pathname}${url.search}`, request));
    } catch (error) {
      console.error("Chat local proxy error", error instanceof Error ? error.message : "unknown");
      return new Response("proxy failure", { status: 502 });
    }
  },
});
let web: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
let logs = "";
try {
  const authHeaders = { Authorization: `Bearer ${credential}`, "X-Workspace-Slug": fixture.workspaceSlug };
  const direct = await fetch(`${upstream}/api/sessions/${chat.id}/log?before=30`, { headers: authHeaders });
  const bridged = await fetch(`http://127.0.0.1:${proxyPort}/api/sessions/${chat.id}/log?before=30`, { headers: authHeaders });
  check("real Chat log endpoint survives the local API proxy", direct.status === 200 && bridged.status === 200,
    { direct: direct.status, proxy: bridged.status });
  const webEnv = { ...process.env, REMOTE_API_URL: `http://127.0.0.1:${proxyPort}`, NEXT_BUILD_CPUS: "8" };
  if (!process.argv.includes("--skip-build")) {
    const build = Bun.spawn({ cmd: ["bun", "run", "build"], cwd: join(root, "frontend/apps/web"),
      env: webEnv, stdout: "pipe", stderr: "pipe" });
    const output = new Response(build.stdout).text();
    const errors = new Response(build.stderr).text();
    const code = await build.exited;
    logs += (await output) + (await errors);
    if (code !== 0) throw new Error("Chat Next production build failed");
  }
  web = Bun.spawn({ cmd: ["bun", join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(webPort)],
    cwd: join(root, "frontend/apps/web"),
    env: webEnv, stdout: "pipe", stderr: "pipe" });
  if (web.stdout && typeof web.stdout !== "number")
    void new Response(web.stdout).text().then(value => { logs += value; });
  if (web.stderr && typeof web.stderr !== "number")
    void new Response(web.stderr).text().then(value => { logs += value; });
  await waitHttp(`${origin}/login`);
  browser = await launchBrowser();
  const context = await mktContext(browser, credential, [], origin);
  await context.addCookies([{ name: "multimira_auth", value: credential, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  const errors: string[] = [];
  const badResponses: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 400) badResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  const response = await page.goto(`${origin}/${fixture.workspaceSlug}/chat?session=${chat.id}`, { waitUntil: "domcontentloaded" });
  const rootSelector = '[data-perf-scroll="session-log"]';
  const scroll = page.locator(rootSelector);
  try {
    await page.waitForSelector(`${rootSelector}[data-perf-state="ready"]`, { timeout: 10_000 });
  } catch (error) {
    console.error("Chat first-frame diagnostic", JSON.stringify({ status: response?.status(),
      url: page.url(), html: (await page.content()).replaceAll(credential, "[redacted]").slice(0, 1000), errors }));
    throw error;
  }
  if (await scroll.count() === 0) throw new Error(`Chat list disappeared after hydration: ${badResponses.join(", ")}`);
  const first = await scroll.evaluate(element => ({
    count: element.querySelectorAll('[data-perf-item="message"]').length,
    bottom: Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
    skeletons: element.querySelectorAll('[data-slot="skeleton"]').length,
  }));
  check("SSR Chat opens on its latest 30 rows at the bottom", response?.ok() === true
    && first.count === 30 && first.bottom <= 2 && first.skeletons === 0, first);
  check("browser has no page error or credential in HTML", errors.length === 0 && !(await page.content()).includes(credential), errors);

  await scroll.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('[data-perf-scroll="session-log"]')?.getAttribute("data-stick-state") === "released");
  const previous = await scroll.locator('[data-perf-item="message"]').first().evaluate(element => ({
    key: element.getAttribute("data-perf-key"), top: element.getBoundingClientRect().top,
  }));
  await page.locator("[data-chat-earlier]").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-perf-scroll="session-log"] [data-perf-item="message"]').length > 30);
  const afterEarlier = await page.locator(`[data-perf-key="${previous.key}"]`).evaluate(element => element.getBoundingClientRect().top);
  check("manual earlier pagination preserves the old row position", Math.abs(afterEarlier - previous.top) <= 2,
    { before: previous.top, after: afterEarlier });

  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const sendPositions: number[] = [];
  for (let index = 1; index <= 10; index++) {
    const body = `Step 3 send ${index}`;
    await page.locator('[contenteditable="true"]').first().fill(body);
    await page.locator('button[aria-label="Send"], button[aria-label="Add to queue"]').first().click();
    await page.waitForFunction(text => [...document.querySelectorAll('[data-perf-item="message"]')]
      .some(row => row.textContent?.includes(text)), body);
    sendPositions.push(await scroll.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)));
  }
  const sendResult = await scroll.evaluate(element => ({
    bottom: Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
    eachOnce: Array.from({ length: 10 }, (_, index) => index + 1).every(index =>
      [...element.querySelectorAll('[data-perf-item="message"]')].filter(row =>
        new RegExp(`Step 3 send ${index}(?!\\d)`).test(row.textContent ?? "")).length === 1),
  }));
  check("ten sends remain single rows and pinned to the bottom", sendPositions.every(position => position <= 2)
    && sendResult.bottom <= 2 && sendResult.eachOnce, { ...sendResult, sendPositions });
  await context.setOffline(true);
  await Bun.sleep(200);
  await context.setOffline(false);
  await Bun.sleep(800);
  check("reconnect keeps each optimistic/server pair as one row", await scroll.evaluate(element =>
    [...element.querySelectorAll('[data-perf-item="message"]')].filter(row => row.textContent?.includes("Step 3 send 10")).length === 1));
  check("final page has no JavaScript errors", errors.length === 0, errors);
  await page.screenshot({ path: join(out, "chat-page.png") });
  await context.close();

  for (const mode of ["no-cookie", "401", "503", "timeout"] as const) {
    ssrMode = mode === "no-cookie" ? "ok" : mode;
    const degraded = await mktContext(browser, credential, [], origin);
    if (mode !== "no-cookie") await degraded.addCookies([{
      name: "multimira_auth", value: credential, url: origin, httpOnly: true, sameSite: "Strict",
    }]);
    const view = await degraded.newPage();
    let bearerRead = false;
    const failures: string[] = [];
    view.on("request", request => {
      if (new URL(request.url()).pathname.endsWith(`/sessions/${chat.id}/log`)
        && request.headers().authorization?.startsWith("Bearer ")) bearerRead = true;
    });
    view.on("response", response => {
      if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    const result = await view.goto(`${origin}/${fixture.workspaceSlug}/chat?session=${chat.id}`,
      { waitUntil: "domcontentloaded" });
    const initialHtml = await result?.text() ?? "";
    try {
      await view.waitForFunction(() => document.querySelectorAll('[data-perf-scroll="session-log"] [data-perf-item="message"]').length === 30,
        undefined, { timeout: 10_000 });
    } catch (error) {
      console.error("Chat degraded diagnostic", JSON.stringify({ mode, url: view.url(),
        rows: await view.locator('[data-perf-scroll="session-log"] [data-perf-item="message"]').count(),
        bearerRead, failures }));
      throw error;
    }
    check(`${mode} SSR shell recovers Chat rows with browser Bearer`, result?.status() === 200
      && !initialHtml.includes('data-perf-item="message"') && bearerRead
      && !initialHtml.includes(credential), { status: result?.status(), bearerRead });
    await degraded.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "Chat check failed");
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, "chat-check.json"), JSON.stringify({ results }, null, 2));
  writeFileSync(join(out, "chat-services.log"), logs.replaceAll(credential, "[redacted]"));
  await browser?.close();
  web?.kill();
  server.stop(true);
  proxy.stop(true);
  db.close();
}
