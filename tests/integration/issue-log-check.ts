#!/usr/bin/env bun
// Local SQLite + real API + production Next + Chromium. No credential files or traces.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";
import { seedZeroJumpFixture } from "./zero-jump-fixture";
import { launchBrowser, mktContext } from "../../frontend/scripts/perf/lib/harness";
import { installRecorderOnContext, readRecorder, computeJumps, computeFirstRealMs, type PerfProfileConfig } from "../../frontend/scripts/perf/lib/jump-recorder";
import { BodyHtmlBackfillTask } from "../../packages/server/src/render/body-html-backfill.js";

const root = resolve(import.meta.dir, "../..");
const webDir = join(root, "frontend/apps/web");
const out = join(root, "reports/performance/MUL-444-step1");
mkdirSync(out, { recursive: true });
const results: Array<Record<string, unknown>> = [];
const check = (name: string, ok: boolean, detail: Record<string, unknown> = {}) => {
  results.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
  if (!ok) throw new Error(name);
};
function port(start: number): number {
  for (let p = start; p < start + 100; p++) {
    try { const s = Bun.serve({ hostname: "0.0.0.0", port: p, reusePort: false, fetch: () => new Response() }); s.stop(true); return p; } catch {}
  }
  throw new Error("No free local port");
}
async function waitHttp(url: string) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise(r => setTimeout(r, 150)); }
  throw new Error("Local service did not start");
}
const db = new Database(":memory:");
const store = new MultiremiStore(db);
const fixture = await seedZeroJumpFixture(store);
const credential = (await store.createAccessToken({ name: "MUL-444 local fixture", type: "pat", purpose: "session",
  workspaceId: fixture.workspaceId, userId: fixture.userId, expiresInDays: 1 })).token;
const apiPort = port(18400);
const proxyPort = port(18500);
const webPort = port(18600);
const origin = `http://localhost:${webPort}`;
const upstream = `http://127.0.0.1:${apiPort}`;
let mode = "ok";
let logs = "";
const headers = { Authorization: `Bearer ${credential}`, "X-Workspace-Slug": fixture.workspaceSlug, "Content-Type": "application/json" };
const server = startMultiremiServer({ store, port: apiPort, hostname: "127.0.0.1", authToken: null, backgroundJobs: false });
const proxy = Bun.serve({ hostname: "127.0.0.1", port: proxyPort, async fetch(request) {
  const url = new URL(request.url);
  if (request.headers.has("cookie") && !request.headers.has("authorization") && url.pathname.endsWith("/log")) {
    if (mode === "timeout") await new Promise(r => setTimeout(r, 1_100));
    if (mode !== "ok") return new Response("unavailable", { status: mode === "401" ? 401 : 503 });
  }
  return fetch(new Request(`${upstream}${url.pathname}${url.search}`, request));
} });
let web: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
const xss = [
  '<script>window.__xss=1</script>',
  '<img src="/missing-xss" onerror="window.__xss=2">',
  '<svg onload="window.__xss=3"><script>window.__xss=4</script></svg>',
  '<a href="javascript:window.__xss=5" onclick="window.__xss=6">XSS link</a>',
  '<iframe srcdoc="<script>parent.__xss=7</script>"></iframe>',
  '<details open ontoggle="window.__xss=8">XSS details</details>',
  '```html\n<script>window.__xss=9</script>\n```',
].join("\n\n");
const profile: PerfProfileConfig = { name: "contract", scrollRoot: "[data-session-log-scroll]", items: "[data-perf-item]",
  skeleton: '[data-slot="skeleton"]', anchors: [{ name: "latest-message", selector: '[data-perf-anchor="latest-message"]', pick: "first", visibility: "contained" }],
  rule: { kind: "anchor", anchors: ["latest-message"] } };
async function ready(page: Page) {
  await page.waitForSelector('[data-session-log-scroll][data-perf-state="ready"]', { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('[data-session-log-scroll] [data-slot="skeleton"]'));
  await page.evaluate(() => new Promise<void>(done => { let n = 0; const tick = () => ++n === 100 ? done() : requestAnimationFrame(tick); tick(); }));
}
const capture = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) logs += decoder.decode(chunk);
};
try {
  const write = await fetch(`${upstream}/api/issues/${fixture.longIssueId}/comments`, { method: "POST", headers,
    body: JSON.stringify({ content: xss, issue_session_id: fixture.longDefaultSessionId, body_html: '<script>window.__xss=10</script>' }) });
  check("XSS API write accepted markdown", write.ok);
  const written = await write.json() as { id: string };
  check("XSS API response has comment id", typeof written.id === "string");
  // Exercise C4's second trusted path against an old row in this temporary DB.
  db.run("UPDATE multiremi_conversation_log SET body_html = NULL, render_version = NULL WHERE id = ?", [written.id]);
  await new BodyHtmlBackfillTask({ store }).runBatch();
  const logResponse = await fetch(`${upstream}/api/sessions/${fixture.longDefaultSessionId}/log?before=30`, { headers });
  const window = await logResponse.json() as { entries: Array<{ id: string; body_html: string | null }> };
  const html = window.entries.find(e => e.id === written.id)?.body_html;
  check("XSS API sanitized rendered body", typeof html === "string" && !/<script[\s>]|\son\w+=|javascript:/i.test(html));

  const env = { ...process.env, REMOTE_API_URL: `http://127.0.0.1:${proxyPort}`, NEXT_BUILD_CPUS: "8" };
  if (!process.argv.includes("--skip-build")) {
    console.log("Building production Next app");
    const build = Bun.spawn({ cmd: ["bun", "run", "build"], cwd: webDir, env, stdout: "pipe", stderr: "pipe" });
    const output = new Response(build.stdout).text();
    const errors = new Response(build.stderr).text();
    const code = await build.exited;
    const text = (await output) + (await errors);
    logs += text;
    if (code !== 0) { console.error(text.replaceAll(credential, "[redacted]").slice(-10_000)); throw new Error("Next build failed"); }
  }
  web = Bun.spawn({ cmd: ["bun", join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(webPort)], cwd: webDir, env, stdout: "pipe", stderr: "pipe" });
  void capture(web.stdout as ReadableStream<Uint8Array>); void capture(web.stderr as ReadableStream<Uint8Array>);
  await waitHttp(`${origin}/login`);
  browser = await launchBrowser();
  for (const entry of ["cold", "navigation"]) for (let round = 1; round <= 3; round++) {
    mode = "ok";
    const context = await mktContext(browser, credential, [], origin);
    await context.addCookies([{ name: "multimira_auth", value: credential, url: origin, httpOnly: true, sameSite: "Strict" }]);
    await installRecorderOnContext(context, { profiles: [profile] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const path = `/${fixture.workspaceSlug}/issues/${fixture.longIssueId}`;
    if (entry === "cold") await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });
    else {
      await page.goto(`${origin}/${fixture.workspaceSlug}/issues`, { waitUntil: "networkidle" });
      await page.locator(`[data-perf-key="${fixture.longIssueId}"]`).first().click();
    }
    await ready(page);
    const recorded = await readRecorder(page);
    if (!recorded) throw new Error("Recorder missing");
    const first = computeFirstRealMs(recorded.frames, "contract");
    // First visible content is the baseline; an absent root has no position.
    const jumps = computeJumps(recorded.frames.filter(f => first !== null && f.t >= first), { profile: "contract", fromMs: first });
    writeFileSync(join(out, `${entry}-${round}.frames.json`), JSON.stringify(recorded));
    await page.screenshot({ path: join(out, `${entry}-${round}.png`), fullPage: false });
    check(`${entry} #${round} jumps=0`, first !== null && jumps.jumpCount === 0, { jumps: jumps.jumpCount, movements: jumps });
    check(`${entry} #${round} no browser errors`, errors.length === 0, { count: errors.length });
    check(`${entry} #${round} XSS inert DOM`, await page.evaluate(() => !(window as unknown as { __xss?: number }).__xss
      && [...document.querySelectorAll('[data-entry-html] *')].every(el => ![...el.attributes].some(a => /^on/i.test(a.name)))
      && document.querySelectorAll('[data-entry-html] script').length === 0));
    const content = await page.content();
    check(`${entry} #${round} cookie absent from client output`, !content.includes(credential));
    await page.screenshot({ path: join(out, `${entry}-${round}.png`), fullPage: false });
    writeFileSync(join(out, `${entry}-${round}.frames.json`), JSON.stringify(recorded));
    await context.close();
  }
  for (const failure of ["no-cookie", "401", "timeout", "503"]) {
    mode = failure === "no-cookie" ? "ok" : failure;
    const context = await mktContext(browser, credential, [], origin);
    if (failure !== "no-cookie") await context.addCookies([{ name: "multimira_auth", value: credential, url: origin, httpOnly: true }]);
    const response = await context.request.get(`${origin}/${fixture.workspaceSlug}/issues/${fixture.longIssueId}`);
    const source = await response.text();
    check(`${failure} SSR shell only`, response.ok() && !source.includes('data-entry-html=""'));
    check(`${failure} SSR cookie excluded`, !source.includes(credential));
    const page = await context.newPage();
    await page.goto(`${origin}/${fixture.workspaceSlug}/issues/${fixture.longIssueId}`);
    await ready(page);
    check(`${failure} Bearer client fills list`, await page.locator('[data-perf-item="message"]').count() > 0);
    await context.close();
  }
  check("Cookie absent from local service logs", !logs.includes(credential));
} catch (error) {
  console.error(error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "Failed");
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, "report.json"), JSON.stringify({ step: 1, results }, null, 2));
  writeFileSync(join(out, "services.log"), logs.replaceAll(credential, "[redacted]"));
  await browser?.close(); web?.kill(); server.stop(true); proxy.stop(true); db.close();
  process.exit(process.exitCode ?? 0);
}
