#!/usr/bin/env bun
/** Isolated local Chromium + production Next check. No daemon/provider/external services. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { HERMETIC_ENV_RUN_ROOT_PATHS, scrubInheritedEnv } from "../setup/hermetic-env-policy";
import type { TraceEvent } from "@multiremi/contracts/trace";
import { agentMessage, fakeDaemonTraceReader, readCommand, sequence, traceTurn, turnCompleted, type FakeTraceRead } from "./turn-trace-browser-fixture";

const root = resolve(import.meta.dir, "../..");
const output = mkdtempSync(join(tmpdir(), "remi-durable-trace-browser-"));
scrubInheritedEnv();
process.env.NODE_ENV = "test";
process.env.MULTIREMI_TEST_RUN_ROOT = output;
for (const [key, path] of Object.entries(HERMETIC_ENV_RUN_ROOT_PATHS)) process.env[key] = join(output, path);
const [{ openSqliteDatabase }, { MultiremiStore }, { startMultiremiServer }, { createHub }, { createLocalHubTransport }, { seedZeroJumpFixture, markTaskRunning }, { launchBrowser, mktContext }] = await Promise.all([
  import("@multiremi/store/db/sqlite.js"), import("@multiremi/store.js"), import("@multiremi/api.js"),
  import("@multiremi/api/hub/hub-core.js"), import("@multiremi/api/hub/hub-transport.js"),
  import("./zero-jump-fixture"), import("../../frontend/scripts/perf/lib/harness"),
]);
const database = openSqliteDatabase(":memory:");
const store = new MultiremiStore(database);
const fixture = await seedZeroJumpFixture(store);
const firstTask = store.getTask(fixture.runningTaskId)!;
const secondTask = store.createTask({ agentId: firstTask.agentId, issueId: fixture.shortIssueId,
  issueSessionId: store.getOrCreateDefaultIssueSession(fixture.shortIssueId, fixture.userId).id, prompt: "Second isolated trace" });
markTaskRunning(store, secondTask.id);
store.markTaskTraceDaemon(firstTask.id, "runtime-browser-fixture");
store.markTaskTraceDaemon(secondTask.id, "runtime-browser-fixture");
// Turn + items traces (PR 2): a long running turn of 2300 events (one turn,
// 2299 items) and a short second one. The dialog reads them through the real
// `view=turn` route and follows the Hub from the head.
const TS = "2026-10-05T00:00:00.000Z";
const historyItems = 2298;
const events = new Map<string, TraceEvent[]>([
  [firstTask.id, sequence([
    { type: "turn.started", turn: traceTurn(firstTask.id, TS) },
    { type: "item.completed", item: agentMessage("msg:history", "Historic first event", "commentary", TS) },
    ...Array.from({ length: historyItems }, (_, index) => (
      { type: "item.completed" as const, item: readCommand(`history-${index}`, `src/history-${index}.ts`, TS) })),
  ], TS)],
  [secondTask.id, sequence([
    { type: "turn.started", turn: traceTurn(secondTask.id, TS) },
    { type: "item.completed", item: agentMessage("msg:second", "Second task only", "final", TS) },
  ], TS)],
]);
const firstItemCount = historyItems + 1;
const closed = new Set<string>();
const hub = createHub({ transport: createLocalHubTransport() });
for (const [taskId, frames] of events) hub.append(taskId, frames);
const reads: FakeTraceRead[] = [];
/** Appends the next events of a task to its trace and the Hub, seq after its head. */
function appendLive(taskId: string, bodies: Parameters<typeof sequence>[0]) {
  const all = events.get(taskId)!;
  const next = sequence(bodies, TS, all.at(-1)?.seq ?? 0);
  all.push(...next);
  hub.append(taskId, next);
}
const skipBuild = process.argv.includes("--skip-build");
let apiPort = 0;
if (skipBuild) {
  const manifest = await Bun.file(join(root, "frontend/apps/web/.next/routes-manifest.json")).json();
  const destination = manifest.rewrites.afterFiles.find((route: { source: string }) => route.source === "/api/:path*")?.destination;
  const url = new URL(destination);
  if (url.hostname !== "127.0.0.1" || !url.port) throw new Error("Existing build must point at an isolated loopback API");
  apiPort = Number(url.port);
}
const service = startMultiremiServer({ store, apiRole: "all", liveHub: hub, scheduler: null,
  port: apiPort, hostname: "127.0.0.1", authToken: null, backgroundJobs: false,
  daemonTraceReader: fakeDaemonTraceReader(events, closed, { reads }),
});
const token = (await store.createAccessToken({ name: "Isolated durable trace browser", type: "pat", purpose: "session",
  workspaceId: fixture.workspaceId, userId: fixture.userId, expiresInDays: 1 })).token;
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const webPort = portProbe.port;
portProbe.stop(true);
const origin = `http://127.0.0.1:${webPort}`;
// Next's development rewrite server does not provide the deployment edge's WS
// upgrade routing. Exercise the real isolated API endpoint directly instead.
const environment = { ...process.env, NODE_ENV: "production", REMOTE_API_URL: `http://127.0.0.1:${service.port}`,
  NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${service.port}/ws`, NEXT_BUILD_CPUS: "4" };
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) throw new Error(name);
}
async function eventually(condition: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(50);
}
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
let web: ReturnType<typeof Bun.spawn> | undefined;
let logs = "";
try {
  if (!skipBuild) {
  const build = Bun.spawn({ cmd: [process.execPath, "run", "build"], cwd: join(root, "frontend/apps/web"),
    env: environment, stdout: "pipe", stderr: "pipe" });
  const buildOutput = new Response(build.stdout).text();
  const buildErrors = new Response(build.stderr).text();
  const buildCode = await build.exited;
  logs += await buildOutput + await buildErrors;
  check("production build with isolated API and 4 workers", buildCode === 0);
  }
  web = Bun.spawn({ cmd: [process.execPath, join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(webPort)],
    cwd: join(root, "frontend/apps/web"), env: environment, stdout: "pipe", stderr: "pipe" });
  if (typeof web.stdout !== "number") void new Response(web.stdout).text().then(value => { logs += value; });
  if (typeof web.stderr !== "number") void new Response(web.stderr).text().then(value => { logs += value; });
  const readyDeadline = Date.now() + 60_000;
  for (;;) {
    try { if ((await fetch(`${origin}/login`)).ok) break; } catch {}
    if (Date.now() > readyDeadline) throw new Error("Local Next did not start");
    await Bun.sleep(100);
  }
  browser = await launchBrowser();
  const context = await mktContext(browser, token, [], origin);
  await context.addInitScript(() => localStorage.removeItem("multimira:chat:isOpen"));
  await context.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const observations: unknown[] = [];
    const sockets: WebSocket[] = [];
    (window as unknown as { traceSocketObservations: unknown[] }).traceSocketObservations = observations;
    (window as unknown as { traceObservedSockets: WebSocket[] }).traceObservedSockets = sockets;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        const parsed = new URL(String(url));
        observations.push({ socket: parsed.origin + parsed.pathname });
        this.addEventListener("open", () => observations.push({ open: parsed.pathname }));
        this.addEventListener("close", event => observations.push({ close: parsed.pathname, code: event.code }));
      }
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data === "string") { try { const frame = JSON.parse(data); observations.push({ sent: frame.type, id: frame.payload?.id }); } catch {} }
        super.send(data);
      }
    };
  });
  await context.addCookies([{ name: "multimira_auth", value: token, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  await page.route("**/api/cli/latest-version", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: "0.0.0" }) }));
  const browserErrors: string[] = [];
  const streamActions: { type: string; id?: string; fromSeq?: number }[] = [];
  const socketPaths: string[] = [];
  const socketDiagnostics: string[] = [];
  page.on("console", message => { if (message.text().includes("[ws")) socketDiagnostics.push(message.text().replaceAll(token, "[redacted]")); });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("websocket", socket => { socketPaths.push(new URL(socket.url()).origin + new URL(socket.url()).pathname); socket.on("socketerror", message => socketDiagnostics.push(message)); socket.on("framesent", event => {
    try {
      const frame = JSON.parse(String(event.payload));
      if (frame.type === "stream.subscribe" || frame.type === "stream.unsubscribe") streamActions.push({ type: frame.type, id: frame.payload.id, fromSeq: frame.payload.from_seq });
    } catch {}
  }); });
  await page.goto(`${origin}/${fixture.workspaceSlug}/issues/${fixture.runningIssueId}`, { waitUntil: "networkidle" });
  await page.locator("button:has(.lucide-minus)").first().click();
  const row = page.locator('[data-perf-anchor="agent-stream"] button').first();
  await row.waitFor();
  check("no trace HTTP before execution opens", reads.length === 0);
  check("no trace subscription before execution opens", !streamActions.some(action => action.id === firstTask.id));
  await row.click();
  let dialog = page.getByRole("dialog");
  await dialog.getByText("Historic first event", { exact: true }).waitFor();
  await dialog.getByText(new RegExp(`\\b${firstItemCount} events\\b`)).first().waitFor();
  // The Hub replay can fill the fold before the pages finish; wait for the last page.
  const firstReads = () => reads.filter(read => read.taskId === firstTask.id);
  await eventually(() => firstReads().length >= Math.ceil(firstItemCount / Math.max(1, firstReads()[0]?.limit ?? 1)));
  const openingReads = firstReads();
  const pageSize = openingReads[0]?.limit ?? 0;
  const expectedCursors = Array.from({ length: Math.ceil(firstItemCount / Math.max(1, pageSize)) }, (_, index) => index * pageSize);
  check("opening folds every view=turn page by item cursor", pageSize > 0
    && openingReads.every(read => read.view === "turn" && read.limit === pageSize)
    && JSON.stringify(openingReads.map(read => read.cursor)) === JSON.stringify(expectedCursors), { openingReads, expectedCursors });
  check("live suffix does not fabricate final answer", await dialog.getByText("Final answer", { exact: true }).count() === 0);
  await eventually(() => streamActions.some(action => action.type === "stream.subscribe" && action.id === firstTask.id));
  await page.screenshot({ path: join(output, "opened-trace.png") });
  check("subscribes the open task", streamActions.some(action => action.type === "stream.subscribe" && action.id === firstTask.id), { streamActions, socketPaths, socketDiagnostics, browserErrors, observations: await page.evaluate(() => (window as unknown as { traceSocketObservations: unknown[] }).traceSocketObservations), dialogText: (await dialog.innerText()).slice(0, 300) });
  const readsBeforeReplay = reads.filter(read => read.taskId === firstTask.id).length;
  await Bun.sleep(500);
  check("the Hub replay folds into the snapshot without another read",
    reads.filter(read => read.taskId === firstTask.id).length === readsBeforeReplay
      && await dialog.getByText("Historic first event", { exact: true }).count() === 1);
  const subscriptionsBeforeReconnect = streamActions.filter(action => action.type === "stream.subscribe" && action.id === firstTask.id).length;
  await page.evaluate(() => {
    const sockets = (window as unknown as { traceObservedSockets: WebSocket[] }).traceObservedSockets;
    sockets.find(socket => new URL(socket.url).pathname === "/api/trace/ws" && socket.readyState === WebSocket.OPEN)?.close();
  });
  appendLive(firstTask.id, [{ type: "item.completed", item: agentMessage("msg:recovered", "Recovered while disconnected", "commentary", TS) }]);
  await dialog.getByText("Recovered while disconnected", { exact: true }).waitFor();
  const subscriptionsAfterReconnect = streamActions.filter(action => action.type === "stream.subscribe" && action.id === firstTask.id);
  check("real trace socket reconnect resumes from the delivered sequence", subscriptionsAfterReconnect.length > subscriptionsBeforeReconnect && subscriptionsAfterReconnect.at(-1)?.fromSeq === 2301);
  appendLive(firstTask.id, [{ type: "item.completed", item: agentMessage("msg:final", "Live final marker", "final", TS) }]);
  appendLive(firstTask.id, [turnCompleted(events.get(firstTask.id)!, TS)]);
  await dialog.getByText("Live final marker", { exact: true }).first().waitFor();
  closed.add(firstTask.id); hub.close(firstTask.id);
  await dialog.getByText(/Execution finished/).waitFor();
  check("the final item is the final answer", await dialog.getByText("Final answer", { exact: true }).count() === 1);
  check("closed trace stops spinners while parent task is still running", await dialog.locator(".animate-spin").count() === 0);
  await page.screenshot({ path: join(output, "closed-trace.png") });
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  check("closing or completion unsubscribes only the trace", streamActions.some(action => action.type === "stream.unsubscribe" && action.id === firstTask.id));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("button:has(.lucide-minus)").first().click();
  const beforeRefreshOpen = reads.length;
  await page.locator('[data-perf-anchor="agent-stream"] button').first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByText(/Execution finished/).waitFor();
  check("reopening after refresh reconstructs closed history", reads.length > beforeRefreshOpen
    && reads.slice(beforeRefreshOpen).every(read => read.view === "turn")
    && await dialog.getByText("Final answer", { exact: true }).count() === 1
    && await dialog.getByText("Recovered while disconnected", { exact: true }).count() === 1);
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  await page.goto(`${origin}/${fixture.workspaceSlug}/issues/${fixture.shortIssueId}`, { waitUntil: "networkidle" });
  await page.locator("button:has(.lucide-minus)").first().click();
  await page.locator('[data-perf-anchor="agent-stream"] button').first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByText("Second task only", { exact: true }).first().waitFor();
  check("task navigation cannot retain the prior trace", await dialog.getByText("Historic first event", { exact: true }).count() === 0);
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  check("second open consumer unsubscribes on close", streamActions.some(action => action.type === "stream.unsubscribe" && action.id === secondTask.id));
  check("no browser page errors", browserErrors.length === 0, browserErrors);
  await context.close();
} catch (error) {
  console.error(error instanceof Error ? error.message.replaceAll(token, "[redacted]") : "Browser check failed");
  process.exitCode = 1;
} finally {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "results.json"), JSON.stringify({ results }, null, 2));
  writeFileSync(join(output, "services.log"), logs.replaceAll(token, "[redacted]"));
  await browser?.close(); web?.kill(); service.stop(true); hub.shutdown(); database.close();
  console.log(`Local browser evidence: ${output}`);
}
