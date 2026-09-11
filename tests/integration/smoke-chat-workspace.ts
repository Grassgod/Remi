#!/usr/bin/env bun
/**
 * Isolated browser smoke: real Next -> Bun HTTP API -> temporary SQLite.
 * The test drives task claiming/completion itself; it never starts a provider.
 *
 * bun run tests/integration/smoke-chat-workspace.ts [--port=3318]
 * CHROME_EXECUTABLE may select an installed Playwright Chromium or Chrome.
 * Screenshots survive under the printed /tmp artifact directory. The browser,
 * Next process group, API, database and upload fixtures are cleaned in finally.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { chromium, type Browser, type Page } from "playwright-core";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: bun run tests/integration/smoke-chat-workspace.ts [--port=3318]\nOptional: CHROME_EXECUTABLE=/path/to/chrome. No provider credentials required.");
  process.exit(0);
}
for (const arg of args) assert.match(arg, /^--port=\d+$/, `Unknown argument: ${arg}`);
const port = Number(args.find(arg => arg.startsWith("--port="))?.slice(7) ?? 3318);
assert(Number.isInteger(port) && port > 0 && port < 65536, "Invalid frontend port");
const repo = resolve(import.meta.dir, "../..");
const webRoot = join(repo, "frontend/apps/web");
const frontend = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "remi-chat-workspace-fixture-"));
const artifacts = mkdtempSync(join(tmpdir(), "remi-chat-workspace-smoke-"));
const checks: string[] = [];
const apiFailures: string[] = [];
const jsErrors: string[] = [];
let next: ChildProcess | null = null;
let nextLogs = "";
let browser: Browser | null = null;
let page: Page | null = null;
let server: ReturnType<typeof startMultiremiServer> | null = null;
let db: Database | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let failure: unknown = null;
let pat = "";
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const redact = (value: string) => pat ? value.split(pat).join("[redacted]") : value;

// This is a standalone process. Ignore host deployment knobs so its API cannot
// load host data or background integrations; fixtures below provide all state.
for (const key of Object.keys(process.env)) if (key.startsWith("MULTIREMI_")) delete process.env[key];
process.env.MULTIREMI_UPLOAD_DIR = join(root, "uploads");
process.env.NODE_ENV = "test";

try {
  await assertPortAvailable(port);
  db = new Database(join(root, "chat.sqlite"));
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ name: "Chat smoke user", email: "chat-smoke@example.test" });
  const workspace = store.createWorkspace({ name: "Chat smoke", slug: "chat-smoke" }, user.id);
  assert.notEqual(workspace.id, "local");
  const runtime = store.registerRuntime({ name: "Simulated worker (no provider)", provider: "codex", workspaceId: workspace.id, ownerId: user.id, status: "online", maxConcurrency: 1 });
  const agent = store.createAgent({ name: "Smoke Agent", provider: "codex", workspaceId: workspace.id, ownerId: user.id, runtimeId: runtime.id });
  pat = (await store.createAccessToken({ name: "Isolated browser smoke", type: "pat", workspaceId: workspace.id, userId: user.id })).token;
  server = startMultiremiServer({ store, authToken: randomUUID(), hostname: "127.0.0.1", port: 0, backgroundJobs: false, scheduler: null, scmPolling: null, messaging: null, controlPlaneSshMesh: null });
  heartbeat = setInterval(() => store.heartbeatRuntime(runtime.id, { claimPending: false }), 10_000);
  const backend = `http://127.0.0.1:${server.port}`;
  const env = { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", REMOTE_API_URL: backend, NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: "", FRONTEND_PORT: String(port) };
  next = spawn("node", [require.resolve("next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: webRoot, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  next.on("error", error => { nextLogs += `\n${error.message}`; });
  for (const stream of [next.stdout, next.stderr]) stream?.on("data", chunk => { nextLogs = (nextLogs + String(chunk)).slice(-24_000); });
  await poll(async () => {
    assert(next?.exitCode === null, `Next exited: ${redact(nextLogs)}`);
    try { return (await fetch(`${frontend}/api/health`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { return false; }
  }, 90_000, "Next startup");
  browser = await chromium.launch({ executablePath: resolveChrome(), headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await context.addCookies([
    { name: "multimira_logged_in", value: "1", url: frontend },
    { name: "multimira_auth", value: pat, url: frontend, httpOnly: true },
    { name: "last_workspace_slug", value: workspace.slug, url: frontend },
    { name: "multimira-locale", value: "en", url: frontend },
  ]);
  await context.addInitScript(token => localStorage.setItem("multimira_token", token), pat);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => jsErrors.push(redact(error.message)));
  page.on("response", response => {
    if (response.url().startsWith(`${frontend}/api/`) && response.status() >= 500 && response.headers()["x-chat-smoke-injected-fault"] !== "1") apiFailures.push(`${new URL(response.url()).pathname} ${response.status()}`);
  });
  await page.goto(`${frontend}/${workspace.slug}/chat?agent=${agent.id}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByRole("heading", { name: "Chat", exact: true }).waitFor();
  const editor = page.locator('.tiptap[contenteditable="true"]');
  await editor.waitFor();
  assert.equal(await editor.count(), 1, "Standalone Chat must have exactly one composer");
  assert.equal(await page.getByRole("button", { name: "Ask Multiremi", exact: true }).count(), 0, "Standalone page duplicated floating Chat");
  check("non-local workspace Chat page and selected agent load without duplicate floating Chat");

  const send = async (content: string) => {
    await editor.fill(content);
    const responsePromise = page!.waitForResponse(response => response.request().method() === "POST" && /\/api\/chat\/sessions\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
    await page!.getByRole("button", { name: /^(Send|Add to queue)$/ }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 201, `Send failed: ${await response.text()}`);
    return await response.json() as { message_id: string; task_id: string; queued: boolean };
  };
  const first = await send("CHAT_SMOKE_FIRST: discuss this workspace");
  const task = store.getTask(first.task_id)!;
  const sessionId = task.chatSessionId!;
  assert.equal(store.getChatSession(sessionId)?.workspaceId, workspace.id);
  assert.equal(store.getChatSession(sessionId)?.creatorId, user.id);
  assert.equal(store.getChatSession(sessionId)?.agentId, agent.id);
  assert.equal(store.listChatSessions("local").length, 0);
  assert(store.listChatMessages(sessionId).some(message => message.id === first.message_id && message.body.includes("CHAT_SMOKE_FIRST")));
  await page.waitForURL(url => url.searchParams.get("session") === sessionId);
  check("first send creates session, user message and task through Next HTTP in the selected workspace");

  assert.equal(store.claimTask(runtime.id)?.id, first.task_id);
  store.startTask(first.task_id);
  const second = await send("CHAT_SMOKE_SECOND: queued follow-up");
  assert.equal(second.queued, true);
  assert.equal(store.getTask(second.task_id)?.status, "queued");
  assert.equal(store.claimTask(runtime.id), null, "Follow-up must not run concurrently");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await queue.getByText("CHAT_SMOKE_SECOND: queued follow-up", { exact: true }).waitFor();
  await queue.getByRole("button", { name: "Edit queued message", exact: true }).click();
  await queue.getByRole("textbox", { name: "Edit queued message" }).fill("CHAT_SMOKE_SECOND_EDITED");
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await poll(() => store.getTask(second.task_id)?.prompt === "CHAT_SMOKE_SECOND_EDITED", 10_000, "queue edit persistence");
  check("in-flight follow-up queues serially and its editor persists changes");

  store.completeTask(first.task_id, { output: "CHAT_SMOKE_REPLY_ONE (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_REPLY_ONE (simulated worker)", { exact: true }).last().waitFor();
  assert.equal(store.claimTask(runtime.id)?.id, second.task_id);
  store.startTask(second.task_id);
  store.completeTask(second.task_id, { output: "CHAT_SMOKE_REPLY_TWO (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_REPLY_TWO (simulated worker)", { exact: true }).last().waitFor();
  check("two simulated worker completions refresh the real conversation without reload");

  const third = await send("CHAT_SMOKE_STOP_ME");
  assert.equal(store.claimTask(runtime.id)?.id, third.task_id);
  store.startTask(third.task_id);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await poll(() => store.getTask(third.task_id)?.status === "cancelled", 10_000, "stop persists cancellation");
  check("Stop cancels the task through the real API");

  const interrupted = await send("CHAT_SMOKE_ACTIVE_FOR_PRIORITY");
  assert.equal(store.claimTask(runtime.id)?.id, interrupted.task_id);
  store.startTask(interrupted.task_id);
  const removed = await send("CHAT_SMOKE_REMOVE_FROM_QUEUE");
  const cleared = await send("CHAT_SMOKE_CLEAR_FROM_QUEUE");
  const clearedAgain = await send("CHAT_SMOKE_CLEAR_ANOTHER");
  const prioritized = await send("CHAT_SMOKE_PRIORITY_TARGET");
  const queueRow = (content: string) => queue.locator(":scope > div").filter({ has: page!.getByText(content, { exact: true }) });
  await queueRow("CHAT_SMOKE_REMOVE_FROM_QUEUE").getByRole("button", { name: "Remove queued message" }).click();
  await poll(() => store.getTask(removed.task_id)?.status === "cancelled", 10_000, "remove queued task");
  assert(!store.listChatMessages(sessionId).some(message => message.id === removed.message_id));
  let cancellations = 0;
  const unsubscribeCancellation = store.onTaskEvent(event => {
    if (event.type === "task:cancelled" && event.task.id === interrupted.task_id) cancellations++;
  });
  const prioritizedResponse = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/chat/sessions/${sessionId}/queue/${prioritized.task_id}/prioritize`);
  await queueRow("CHAT_SMOKE_PRIORITY_TARGET").getByRole("button", { name: "Run now (stops the current run)", exact: true }).click();
  const priorityResponse = await prioritizedResponse;
  assert.equal(priorityResponse.status(), 200);
  assert.equal((await priorityResponse.json()).active_task_id, interrupted.task_id);
  assert.equal(store.getTask(interrupted.task_id)?.status, "cancelled");
  assert.equal(cancellations, 1, "Prioritize must cancel the current task exactly once on the server");
  unsubscribeCancellation();
  assert.equal(store.claimTask(runtime.id)?.id, prioritized.task_id, "Run now must claim before older queued work");
  store.startTask(prioritized.task_id);
  await queue.getByRole("button", { name: "Clear queue", exact: true }).click();
  await poll(() => [cleared, clearedAgain].every(item => store.getTask(item.task_id)?.status === "cancelled"), 10_000, "clear queued tasks");
  assert.equal(store.getTask(prioritized.task_id)?.status, "running", "Clear queue must preserve the running task");
  assert(!store.listChatMessages(sessionId).some(message => [cleared.message_id, clearedAgain.message_id].includes(message.id)));
  store.completeTask(prioritized.task_id, { output: "CHAT_SMOKE_PRIORITY_COMPLETE (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_PRIORITY_COMPLETE (simulated worker)", { exact: true }).last().waitFor();
  check("queue remove deletes the pending message; run now cancels once and takes priority; clear preserves the running task");

  const retryContent = "CHAT_SMOKE_RETRY_DRAFT";
  const taskCountBeforeFailure = store.listTasks().length;
  const messageCountBeforeFailure = store.listChatMessages(sessionId).length;
  let injected = false;
  const failureRoute = `${frontend}/api/chat/sessions/${sessionId}/messages`;
  await page.route(failureRoute, async route => {
    if (!injected && route.request().method() === "POST") {
      injected = true;
      await route.fulfill({ status: 503, headers: { "content-type": "application/json", "x-chat-smoke-injected-fault": "1" }, body: JSON.stringify({ error: "Isolated smoke: injected temporary send failure" }) });
    } else await route.continue();
  });
  await editor.fill(retryContent);
  const rejectedSend = page.waitForResponse(response => response.url() === failureRoute && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  assert.equal((await rejectedSend).status(), 503);
  await page.getByRole("alert").filter({ hasText: "Message was not sent" }).waitFor();
  await page.unroute(failureRoute);
  assert.equal(await editor.innerText(), retryContent);
  assert.equal(store.listTasks().length, taskCountBeforeFailure);
  assert.equal(store.listChatMessages(sessionId).length, messageCountBeforeFailure);
  const retriedSend = page.waitForResponse(response => response.url() === failureRoute && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const retryResponse = await retriedSend;
  assert.equal(retryResponse.status(), 201);
  const retried = await retryResponse.json() as { task_id: string };
  assert.equal(store.listTasks().filter(item => item.prompt === retryContent).length, 1);
  assert.equal(store.listChatMessages(sessionId).filter(item => item.body === retryContent).length, 1);
  assert.equal(store.claimTask(runtime.id)?.id, retried.task_id);
  store.startTask(retried.task_id);
  store.completeTask(retried.task_id, { output: "CHAT_SMOKE_RETRY_COMPLETE (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_RETRY_COMPLETE (simulated worker)", { exact: true }).last().waitFor();
  check("one injected HTTP 503 retains the draft; retry creates exactly one message and task");

  const row = page.getByRole("group", { name: "Chat history", exact: true }).locator('[aria-current="true"]');
  await row.hover();
  await row.getByRole("button", { name: "Rename chat session" }).click();
  await row.getByRole("textbox", { name: "Rename chat session" }).fill("Persistent Chat Smoke");
  await row.getByRole("textbox", { name: "Rename chat session" }).press("Enter");
  await poll(() => store.getChatSession(sessionId)?.title === "Persistent Chat Smoke", 10_000, "rename persistence");
  await row.hover();
  await row.getByRole("button", { name: "Pin chat", exact: true }).click();
  await poll(() => store.getChatSession(sessionId)?.pinned === true, 10_000, "pin persistence");
  await page.reload({ waitUntil: "domcontentloaded" });
  await row.getByText("Persistent Chat Smoke", { exact: true }).waitFor();
  await row.hover();
  await row.getByRole("button", { name: "Unpin chat", exact: true }).waitFor();
  check("rename and pin survive browser reload");

  await row.getByRole("button", { name: "Archive chat", exact: true }).click();
  await poll(() => store.getChatSession(sessionId)?.status === "archived", 10_000, "archive persistence");
  const restore = page.getByRole("button", { name: "Restore chat", exact: true });
  await restore.waitFor();
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  const denied = await context.request.post(`${frontend}/api/chat/sessions/${sessionId}/messages`, { headers: { Authorization: `Bearer ${pat}`, "X-Workspace-Slug": workspace.slug }, data: { content: "ARCHIVED_SHOULD_NOT_SEND" } });
  assert.equal(denied.status(), 409);
  assert(!store.listChatMessages(sessionId).some(message => message.body === "ARCHIVED_SHOULD_NOT_SEND"));
  await restore.click();
  await poll(() => store.getChatSession(sessionId)?.status === "active", 10_000, "restore persistence");
  check("archive makes the session read-only in UI and API; restore re-enables it");

  // Remount the active session in floating Chat, upload without sending, then
  // remount it again as the standalone page to exercise draft attachment state.
  await page.getByRole("link", { name: "Issues", exact: true }).click();
  await page.waitForURL(url => url.pathname === `/${workspace.slug}/issues`);
  await page.getByRole("button", { name: "Open Chat page", exact: true }).waitFor();
  await editor.waitFor();
  const attachmentFile = join(root, "chat-smoke-attachment.txt");
  writeFileSync(attachmentFile, "Private attachment fixture for isolated Chat smoke.\n");
  const uploadedPromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/upload-file");
  await page.locator('input[type="file"]').setInputFiles(attachmentFile);
  const uploaded = await uploadedPromise;
  assert.equal(uploaded.status(), 200);
  const upload = await uploaded.json() as { id: string };
  await editor.getByText("chat-smoke-attachment.txt", { exact: true }).waitFor();
  assert.equal(store.getAttachment(upload.id)?.chatMessageId, null, "Upload must remain an unsent draft");
  await page.getByRole("button", { name: "Open Chat page", exact: true }).click();
  await page.waitForURL(url => url.pathname === `/${workspace.slug}/chat` && url.searchParams.get("session") === sessionId);
  await editor.getByText("chat-smoke-attachment.txt", { exact: true }).waitFor();
  assert.equal(await editor.count(), 1, "Cross-surface navigation duplicated the composer");
  const sentAttachmentPromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/chat/sessions/${sessionId}/messages`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const attachmentResponse = await sentAttachmentPromise;
  assert.equal(attachmentResponse.status(), 201);
  assert.deepEqual(attachmentResponse.request().postDataJSON().attachment_ids, [upload.id], "Cross-surface draft must retain uploaded attachment IDs");
  const attached = await attachmentResponse.json() as { message_id: string; task_id: string };
  assert.equal(store.getAttachment(upload.id)?.chatSessionId, sessionId);
  assert.equal(store.getAttachment(upload.id)?.chatMessageId, attached.message_id);
  const download = await context.request.get(`${frontend}/api/attachments/${upload.id}/content`);
  assert.equal(download.status(), 200);
  assert.match(await download.text(), /Private attachment fixture/);
  assert.equal(store.claimTask(runtime.id)?.id, attached.task_id);
  store.startTask(attached.task_id);
  store.completeTask(attached.task_id, { output: "CHAT_SMOKE_ATTACHMENT_READ (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_ATTACHMENT_READ (simulated worker)", { exact: true }).last().waitFor();
  const downloadFromCard = page.getByRole("button", { name: "Download", exact: true });
  await downloadFromCard.waitFor();
  assert(!await page.getByText("!filechat-smoke-attachment.txt", { exact: true }).count(), "File-card syntax leaked into the message");
  const downloaded = page.waitForEvent("download");
  await downloadFromCard.click();
  const browserDownload = await downloaded;
  assert.equal(browserDownload.suggestedFilename(), "chat-smoke-attachment.txt");
  const downloadedPath = join(root, "downloaded-chat-smoke.txt");
  await browserDownload.saveAs(downloadedPath);
  assert.match(readFileSync(downloadedPath, "utf8"), /Private attachment fixture/);
  check("unsent attachment survives floating-to-page navigation, binds once, and its visible file-card downloads correctly");
  await page.screenshot({ path: join(artifacts, "chat-desktop.png"), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await editor.waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(await editor.count(), 1);
  await page.screenshot({ path: join(artifacts, "chat-mobile.png"), fullPage: false });
  await page.getByRole("button", { name: "Chat history", exact: true }).click();
  await page.getByRole("textbox", { name: "Search chats…" }).waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: join(artifacts, "chat-mobile-history.png"), fullPage: false });
  await page.getByRole("button", { name: "Back to conversation" }).click();
  await editor.waitFor();
  check("390px conversation and history remain within viewport and can switch both ways");
  assert.deepEqual(apiFailures, [], "Unexpected API 5xx responses");
  assert.deepEqual(jsErrors, [], "Uncaught browser errors");
  check("no browser exceptions or unexpected API 5xx responses");
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: join(artifacts, "chat-failure.png"), fullPage: false }).catch(() => {});
  if (page) writeFileSync(join(artifacts, "failure-dom.txt"), redact(await page.locator("body").innerText().catch(() => "")));
  writeFileSync(join(artifacts, "next-failure.log"), redact(nextLogs));
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await browser?.close().catch(() => {});
  if (next?.pid) {
    try { process.kill(process.platform === "win32" ? next.pid : -next.pid, "SIGTERM"); } catch { /* Already exited. */ }
    await poll(() => next?.exitCode !== null || next?.signalCode !== null, 5000, "Next shutdown").catch(() => {
      try { process.kill(process.platform === "win32" ? next!.pid! : -next!.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    });
  }
  server?.stop(true);
  db?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
console.log(JSON.stringify({ ok: failure === null, checks, artifacts, realProvider: false, apiFailures, jsErrors, error: failure instanceof Error ? redact(failure.stack ?? failure.message) : failure }, null, 2));
process.exit(failure === null ? 0 : 1);

async function poll(condition: () => boolean | Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    assert(Date.now() < deadline, `Timed out waiting for ${label} after ${timeout}ms`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function assertPortAvailable(value: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(value, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
}

function resolveChrome(): string {
  const configured = process.env.CHROME_EXECUTABLE;
  if (configured) { assert(existsSync(configured), "CHROME_EXECUTABLE does not exist"); return configured; }
  const caches = [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")];
  const suffixes = ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache).filter(name => name.startsWith("chromium")).sort().reverse()) {
      for (const suffix of suffixes) { const candidate = join(cache, entry, suffix); if (existsSync(candidate)) return candidate; }
    }
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert(existsSync(chrome), "No Chromium found; set CHROME_EXECUTABLE");
  return chrome;
}
