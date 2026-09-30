#!/usr/bin/env bun
// Local browser probe for role=all and UI/runtime route splitting; data stays in memory.
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";
import { seedZeroJumpFixture } from "./zero-jump-fixture";
import { launchBrowser, mktContext } from "../../frontend/scripts/perf/lib/harness";

const root = resolve(import.meta.dir, "../..");
const outArg = process.argv.indexOf("--out");
const out = outArg >= 0 && process.argv[outArg + 1]
  ? resolve(process.argv[outArg + 1])
  : join(root, "reports/performance/MUL-444-step4");
mkdirSync(out, { recursive: true });
const results: Array<Record<string, unknown>> = [];
function check(name: string, ok: boolean, detail: Record<string, unknown> = {}) {
  results.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) throw new Error(name);
}
function port(start: number): number {
  for (let value = start; value < start + 100; value++) {
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: value, fetch: () => new Response() });
      probe.stop(true);
      return value;
    } catch {}
  }
  throw new Error("No free local port");
}
async function waitHttp(url: string) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await Bun.sleep(150);
  }
  throw new Error("Local Next service did not start");
}

const db = openSqliteDatabase(":memory:");
const store = new MultiremiStore(db);
const fixture = await seedZeroJumpFixture(store);
store.markTaskTraceDaemon(fixture.runningTaskId, "rt_trace_fixture");
const credential = (await store.createAccessToken({ name: "MUL-444 trace local probe", type: "pat", purpose: "session",
  workspaceId: fixture.workspaceId, userId: fixture.userId, expiresInDays: 1 })).token;
const allPort = port(19400);
const uiPort = port(19500);
const runtimePort = port(19600);
const webPort = port(19700);
const proxyPort = port(19800);
const origin = `http://127.0.0.1:${webPort}`;
const authHeaders = { Authorization: `Bearer ${credential}`, "X-Workspace-Slug": fixture.workspaceSlug };
let readerReachable = true;
const traceEvents = [1, 2, 3].map(seq => ({ seq, ts: "2026-08-08T00:00:00Z", type: "tool_use",
  tool: "Read", tool_call_id: `trace-${seq}`, input: { file_path: `/tmp/example-${seq}.ts` } }));
const daemonTraceReader = {
  async read({ afterSeq = 0 }: { afterSeq?: number }) {
    if (!readerReachable) return { ok: false as const, code: "daemon_unreachable" as const, last_seen_at: "2026-08-08T00:00:00Z" };
    const events = traceEvents.filter(event => event.seq > afterSeq);
    return { ok: true as const, events, next_after_seq: events.at(-1)?.seq ?? afterSeq,
      head: 3, eof: true, closed: false };
  },
};
const all = startMultiremiServer({ store, apiRole: "all", daemonTraceReader,
  port: allPort, hostname: "127.0.0.1", authToken: null, backgroundJobs: false });
const ui = startMultiremiServer({ store, apiRole: "ui", daemonTraceReader,
  port: uiPort, hostname: "127.0.0.1", authToken: null, backgroundJobs: false });
const runtime = startMultiremiServer({ store, apiRole: "runtime", daemonTraceReader,
  port: runtimePort, hostname: "127.0.0.1", authToken: null, backgroundJobs: false });
let routingMode: "all" | "split" = "all";
let runtimeTraceRequests = 0;
const proxy = Bun.serve({ hostname: "127.0.0.1", port: proxyPort, fetch(request) {
  const url = new URL(request.url);
  const trace = /^\/api\/tasks\/[^/]+\/trace$/.test(url.pathname);
  if (routingMode === "split" && trace) runtimeTraceRequests++;
  const targetPort = routingMode === "all" ? allPort : trace ? runtimePort : uiPort;
  return fetch(new Request(`http://127.0.0.1:${targetPort}${url.pathname}${url.search}`, request));
} });
let web: ReturnType<typeof Bun.spawn> | undefined;
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
let logs = "";
const states = ["ok", "backfilling", "unreachable", "lost", "not_found"] as const;
const expectedText: Record<typeof states[number], string> = {
  ok: "Live updates", backfilling: "Execution trace is being restored",
  unreachable: "Runtime rt_trace_fixture is offline",
  lost: "Execution trace was lost", not_found: "No execution trace is available",
};
function setState(state: typeof states[number]) {
  readerReachable = state !== "unreachable";
  const location = state === "ok" || state === "unreachable" ? "daemon"
    : state === "not_found" ? "none" : state;
  db.run("UPDATE multiremi_task_traces SET location = ?, runtime_id = ? WHERE task_id = ?",
    [location, location === "daemon" ? "rt_trace_fixture" : null, fixture.runningTaskId]);
}
try {
  const webEnv = { ...process.env, REMOTE_API_URL: `http://127.0.0.1:${proxyPort}`, NEXT_BUILD_CPUS: "8" };
  if (!process.argv.includes("--skip-build")) {
    const build = Bun.spawn({ cmd: ["bun", "run", "build"], cwd: join(root, "frontend/apps/web"),
      env: webEnv, stdout: "pipe", stderr: "pipe" });
    const output = new Response(build.stdout).text();
    const errors = new Response(build.stderr).text();
    const code = await build.exited;
    logs += (await output) + (await errors);
    check("production Next build", code === 0);
  }
  web = Bun.spawn({ cmd: ["bun", join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(webPort)],
    cwd: join(root, "frontend/apps/web"), env: webEnv, stdout: "pipe", stderr: "pipe" });
  if (web.stdout && typeof web.stdout !== "number") void new Response(web.stdout).text().then(value => { logs += value; });
  if (web.stderr && typeof web.stderr !== "number") void new Response(web.stderr).text().then(value => { logs += value; });
  await waitHttp(`${origin}/login`);
  browser = await launchBrowser();
  const context = await mktContext(browser, credential, [], origin);
  await context.addCookies([{ name: "multimira_auth", value: credential, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  const traceRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === `/api/tasks/${fixture.runningTaskId}/trace`)
      traceRequests.push(request.url());
  });
  await page.goto(`${origin}/${fixture.workspaceSlug}/issues/${fixture.runningIssueId}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-perf-anchor="agent-stream"] button').first().waitFor();
  check("trace endpoint stays idle before click", traceRequests.length === 0);
  for (const mode of ["all", "split"] as const) {
    routingMode = mode;
    const routedTrace = await fetch(`http://127.0.0.1:${proxyPort}/api/tasks/${fixture.runningTaskId}/trace?after_seq=0&limit=500`,
      { headers: authHeaders, signal: AbortSignal.timeout(5000) });
    check(`${mode} routed trace API responds`, routedTrace.status === 200,
      { status: routedTrace.status, runtimeRequests: runtimeTraceRequests });
    for (const state of states) {
      setState(state);
      const before = traceRequests.length;
      const beforeRuntime = runtimeTraceRequests;
      await page.locator('[data-perf-anchor="agent-stream"] button').first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText(expectedText[state], { exact: false }).waitFor();
      check(`${mode} browser renders ${state}`, traceRequests.length > before
        && (mode === "all" || runtimeTraceRequests > beforeRuntime),
      { requests: traceRequests.length - before, runtimeRequests: runtimeTraceRequests - beforeRuntime });
      await Bun.sleep(400);
      await page.screenshot({ path: join(out, `${mode}-${state}-desktop.png`) });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      if (state === "unreachable" && mode === "all") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('[data-perf-anchor="agent-stream"] button').first().evaluate(element => (element as HTMLElement).click());
        const mobileDialog = page.getByRole("dialog");
        await mobileDialog.getByText(expectedText[state], { exact: false }).waitFor();
        await Bun.sleep(400);
        await page.screenshot({ path: join(out, "unreachable-mobile.png") });
        const geometry = await mobileDialog.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height, viewport: innerWidth };
        });
        check("mobile trace dialog occupies the viewport", geometry.width === geometry.viewport, geometry);
        await page.keyboard.press("Escape");
        await mobileDialog.waitFor({ state: "hidden" });
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    }
  }
  await context.close();
} catch (error) {
  console.error(error instanceof Error ? error.message.replaceAll(credential, "[redacted]") : "Trace dialog probe failed");
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, "trace-dialog-check.json"), JSON.stringify({ results }, null, 2));
  writeFileSync(join(out, "services.log"), logs.replaceAll(credential, "[redacted]"));
  await browser?.close();
  web?.kill();
  all.stop(true);
  ui.stop(true);
  runtime.stop(true);
  proxy.stop(true);
  db.close();
}
