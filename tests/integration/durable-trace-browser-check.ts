#!/usr/bin/env bun
/** Isolated local Chromium + production Next check. No daemon/provider/external services. */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { HERMETIC_ENV_RUN_ROOT_PATHS, scrubInheritedEnv } from "../setup/hermetic-env-policy";
import type { TraceEvent } from "@multiremi/contracts/trace";

const root = resolve(import.meta.dir, "../..");
const output = mkdtempSync(join(tmpdir(), "remi-durable-trace-browser-"));
scrubInheritedEnv();
process.env.NODE_ENV = "test";
process.env.MULTIREMI_TEST_RUN_ROOT = output;
for (const [key, path] of Object.entries(HERMETIC_ENV_RUN_ROOT_PATHS)) process.env[key] = join(output, path);
const [{ openSqliteDatabase }, { MultiremiStore }, { startMultiremiServer }, { createHub }, { createLocalHubTransport }, { seedZeroJumpFixture }, { launchBrowser, mktContext }] = await Promise.all([
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
database.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [secondTask.id]);
store.markTaskTraceDaemon(firstTask.id, "runtime-browser-fixture");
store.markTaskTraceDaemon(secondTask.id, "runtime-browser-fixture");
const events = new Map<string, TraceEvent[]>([
  [firstTask.id, Array.from({ length: 2300 }, (_, index) => ({ seq: index + 1, ts: "2026-10-05T00:00:00Z",
    ...(index === 0 ? { type: "text", content: "Historic first event", meta: { phase: "commentary" } }
      : { type: "tool_result", tool: "Read", tool_call_id: `history-${index}`, status: "completed", input: { file_path: `history-${index}.ts` } }),
  }))],
  [secondTask.id, [{ seq: 1, ts: "2026-10-05T00:00:00Z", type: "text", content: "Second task only", meta: { phase: "final_answer" } }]],
]);
const closed = new Set<string>();
const hub = createHub({ transport: createLocalHubTransport() });
for (const [taskId, frames] of events) hub.append(taskId, frames);
const reads: { taskId: string; afterSeq: number; limit: number }[] = [];
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
  daemonTraceReader: { async read({ taskId, afterSeq = 0, limit = 200 }) {
    reads.push({ taskId, afterSeq, limit });
    const all = events.get(taskId) ?? [];
    const page = all.filter(event => event.seq > afterSeq).slice(0, limit);
    const next = page.at(-1)?.seq ?? afterSeq;
    return { ok: true, events: page, next_after_seq: next, head: all.at(-1)?.seq ?? 0,
      eof: next >= (all.at(-1)?.seq ?? 0), closed: closed.has(taskId) };
  } },
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
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes("Load more events"));
  check("one bounded history page on opening", reads.filter(read => read.taskId === firstTask.id).length === 1 && reads[0]?.limit === 200);
  check("live suffix does not fabricate final answer", await dialog.getByText("Final answer", { exact: true }).count() === 0);
  await eventually(() => streamActions.some(action => action.type === "stream.subscribe" && action.id === firstTask.id));
  await page.screenshot({ path: join(output, "opened-trace.png") });
  check("subscribes the open task", streamActions.some(action => action.type === "stream.subscribe" && action.id === firstTask.id), { streamActions, socketPaths, socketDiagnostics, browserErrors, observations: await page.evaluate(() => (window as unknown as { traceSocketObservations: unknown[] }).traceSocketObservations), dialogText: (await dialog.innerText()).slice(0, 300) });
  await dialog.getByRole("button", { name: "Load more events" }).click();
  await dialog.getByRole("button", { name: "Back to beginning" }).waitFor();
  check("live replay does not jump the HTTP history cursor", reads.filter(read => read.taskId === firstTask.id)[1]?.afterSeq === 200);
  for (let count = 0; count < 10; count++) {
    const button = dialog.getByRole("button", { name: "Load more events" });
    await button.waitFor({ state: "visible" });
    await button.click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"] button:disabled')?.textContent?.includes("Load more events"));
  }
  await dialog.getByRole("button", { name: "Back to beginning" }).click();
  await dialog.getByText("Historic first event", { exact: true }).waitFor();
  check("evicted first history remains reachable", reads.at(-1)?.afterSeq === 0);
  const subscriptionsBeforeReconnect = streamActions.filter(action => action.type === "stream.subscribe" && action.id === firstTask.id).length;
  await page.evaluate(() => {
    const sockets = (window as unknown as { traceObservedSockets: WebSocket[] }).traceObservedSockets;
    sockets.find(socket => new URL(socket.url).pathname === "/api/trace/ws" && socket.readyState === WebSocket.OPEN)?.close();
  });
  const recovered: TraceEvent = { seq: 2301, ts: "2026-10-05T00:00:00Z", type: "text", content: "Recovered while disconnected", meta: { phase: "commentary" } };
  events.get(firstTask.id)!.push(recovered); hub.append(firstTask.id, [recovered]);
  await dialog.getByText("Recovered while disconnected", { exact: true }).waitFor();
  const subscriptionsAfterReconnect = streamActions.filter(action => action.type === "stream.subscribe" && action.id === firstTask.id);
  check("real trace socket reconnect resumes from the delivered sequence", subscriptionsAfterReconnect.length > subscriptionsBeforeReconnect && subscriptionsAfterReconnect.at(-1)?.fromSeq === 2301);
  const last: TraceEvent = { seq: 2302, ts: "2026-10-05T00:00:00Z", type: "text", content: "Live final marker", meta: { phase: "final_answer" } };
  events.get(firstTask.id)!.push(last);
  hub.append(firstTask.id, [last]);
  await dialog.getByText("Live final marker", { exact: true }).waitFor();
  closed.add(firstTask.id); hub.close(firstTask.id);
  await dialog.getByText(/Execution finished/).waitFor();
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
  check("reopening after refresh reconstructs closed history", reads.length > beforeRefreshOpen);
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
