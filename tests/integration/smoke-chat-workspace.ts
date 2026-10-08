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
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
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
  db = openSqliteDatabase(join(root, "chat.sqlite"));
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
    const responsePromise = page!.waitForResponse(response => response.request().method() === "POST" && /\/api\/sessions\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
    await page!.getByRole("button", { name: /^(Send|Add to queue)$/ }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, `Send failed: ${await response.text()}`);
    const result = await response.json() as { message: { id: string }; turn_id?: string; wake_applied: string };
    const turn = result.turn_id ? store.getTurn(result.turn_id) : null;
    assert(turn?.current_attempt_id, "Send must wake a turn");
    return { message: result.message, turn, attemptId: turn.current_attempt_id, wake_applied: result.wake_applied };
  };
  const first = await send("CHAT_SMOKE_FIRST: discuss this workspace");
  const task = store.getTask(first.attemptId)!;
  const sessionId = task.chatSessionId!;
  assert.equal(store.getChatSession(sessionId)?.workspaceId, workspace.id);
  assert.equal(store.getChatSession(sessionId)?.creatorId, user.id);
  assert.equal(store.getChatSession(sessionId)?.agentId, agent.id);
  assert.equal(store.listChatSessions("local").length, 0);
  assert(store.listChatMessages(sessionId).some(message => message.id === first.message.id && message.body.includes("CHAT_SMOKE_FIRST")));
  await page.waitForURL(url => url.searchParams.get("session") === sessionId);
  check("first send creates session, user message and task through Next HTTP in the selected workspace");

  assert.equal(store.claimTask(runtime.id)?.id, first.attemptId);
  store.startTask(first.attemptId);
  const second = await send("CHAT_SMOKE_SECOND: queued follow-up");
  assert.equal(second.wake_applied, "next_turn");
  assert.equal(store.getTask(second.attemptId)?.status, "queued");
  assert.equal(store.claimTask(runtime.id), null, "Follow-up must not run concurrently");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await queue.getByText("CHAT_SMOKE_SECOND: queued follow-up", { exact: true }).waitFor();
  await queue.getByRole("button", { name: "Edit queued message", exact: true }).click();
  await queue.getByRole("textbox", { name: "Edit queued message" }).fill("CHAT_SMOKE_SECOND_EDITED");
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await poll(() => store.getTask(second.attemptId)?.prompt === "CHAT_SMOKE_SECOND_EDITED", 10_000, "queue edit persistence");
  check("in-flight follow-up queues serially and its editor persists changes");

  store.completeTask(first.attemptId, { output: "CHAT_SMOKE_REPLY_ONE (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_REPLY_ONE (simulated worker)", { exact: true }).last().waitFor();
  assert.equal(store.claimTask(runtime.id)?.id, second.attemptId);
  store.startTask(second.attemptId);
  store.completeTask(second.attemptId, { output: "CHAT_SMOKE_REPLY_TWO (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_REPLY_TWO (simulated worker)", { exact: true }).last().waitFor();
  check("two simulated worker completions refresh the real conversation without reload");

  const third = await send("CHAT_SMOKE_STOP_ME");
  assert.equal(store.claimTask(runtime.id)?.id, third.attemptId);
  store.startTask(third.attemptId);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await poll(() => store.getTask(third.attemptId)?.status === "cancelled", 10_000, "stop persists cancellation");
  check("Stop cancels the task through the real API");

  // Canonical queue edits operate on unread messages. Removing and resending
  // moves a draft to the tail; the retired prioritize/clear endpoints have no
  // server commands in this protocol.
  const interrupted = await send("CHAT_SMOKE_ACTIVE_FOR_QUEUE");
  assert.equal(store.claimTask(runtime.id)?.id, interrupted.attemptId);
  store.startTask(interrupted.attemptId);
  const removed = await send("CHAT_SMOKE_REMOVE_FROM_QUEUE");
  const cleared = await send("CHAT_SMOKE_CLEAR_FROM_QUEUE");
  const queuedHeaders = { Authorization: `Bearer ${pat}`, "X-Workspace-Slug": workspace.slug };
  const edited = await context.request.patch(`${frontend}/api/messages/${removed.message.id}`, {
    headers: queuedHeaders, data: { body_md: "CHAT_SMOKE_QUEUE_EDITED" },
  });
  assert.equal(edited.status(), 200);
  assert.equal(store.getMessage(removed.message.id)?.body_md, "CHAT_SMOKE_QUEUE_EDITED");
  const deleted = await context.request.delete(`${frontend}/api/messages/${removed.message.id}`, { headers: queuedHeaders });
  assert.equal(deleted.status(), 200);
  assert(store.getMessage(removed.message.id)?.deleted_at);
  const resentResponse = await context.request.post(`${frontend}/api/sessions/${sessionId}/messages`, {
    headers: queuedHeaders, data: { body_md: "CHAT_SMOKE_QUEUE_EDITED", to: { type: "agent", ref: agent.id } },
  });
  assert.equal(resentResponse.status(), 200);
  const resent = await resentResponse.json() as { message: { id: string; seq: number } };
  assert.notEqual(resent.message.id, removed.message.id);
  assert(resent.message.seq > store.getMessage(cleared.message.id)!.seq);
  for (const messageId of [cleared.message.id, resent.message.id]) {
    assert.equal((await context.request.delete(`${frontend}/api/messages/${messageId}`, { headers: queuedHeaders })).status(), 200);
  }
  assert.equal(store.getTask(interrupted.attemptId)?.status, "running", "Deleting unread drafts must preserve the running turn");
  store.completeTask(interrupted.attemptId, { output: "CHAT_SMOKE_QUEUE_COMPLETE (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_QUEUE_COMPLETE (simulated worker)", { exact: true }).last().waitFor();
  check("unread message edit, delete/resend FIFO and bulk draft deletion preserve the running turn");

  const retryContent = "CHAT_SMOKE_RETRY_DRAFT";
  const taskCountBeforeFailure = store.listTasks().length;
  const messageCountBeforeFailure = store.listChatMessages(sessionId).length;
  let injected = false;
  const failureRoute = `${frontend}/api/sessions/${sessionId}/messages`;
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
  const retriedResult = await retryResponse.json() as { turn_id: string };
  const retried = { attemptId: store.getTurn(retriedResult.turn_id)!.current_attempt_id! };
  assert.equal(store.listTasks().filter(item => item.prompt === retryContent).length, 1);
  assert.equal(store.listChatMessages(sessionId).filter(item => item.body === retryContent).length, 1);
  assert.equal(store.claimTask(runtime.id)?.id, retried.attemptId);
  store.startTask(retried.attemptId);
  store.completeTask(retried.attemptId, { output: "CHAT_SMOKE_RETRY_COMPLETE (simulated worker)", sessionId: "smoke-provider-session" });
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
  const denied = await context.request.post(`${frontend}/api/sessions/${sessionId}/messages`, { headers: { Authorization: `Bearer ${pat}`, "X-Workspace-Slug": workspace.slug }, data: { body_md: "ARCHIVED_SHOULD_NOT_SEND", to: { type: "agent", ref: agent.id } } });
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
  const sentAttachmentPromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/sessions/${sessionId}/messages`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const attachmentResponse = await sentAttachmentPromise;
  assert.equal(attachmentResponse.status(), 200);
  assert.deepEqual(attachmentResponse.request().postDataJSON().attachment_ids, [upload.id], "Cross-surface draft must retain uploaded attachment IDs");
  const attachedResult = await attachmentResponse.json() as { message: { id: string }; turn_id: string };
  const attached = { message: attachedResult.message, attemptId: store.getTurn(attachedResult.turn_id)!.current_attempt_id! };
  assert.equal(store.getAttachment(upload.id)?.chatSessionId, sessionId);
  assert.equal(store.getAttachment(upload.id)?.chatMessageId, attached.message.id);
  const download = await context.request.get(`${frontend}/api/attachments/${upload.id}/content`);
  assert.equal(download.status(), 200);
  assert.match(await download.text(), /Private attachment fixture/);
  assert.equal(store.claimTask(runtime.id)?.id, attached.attemptId);
  store.startTask(attached.attemptId);
  store.completeTask(attached.attemptId, { output: "CHAT_SMOKE_ATTACHMENT_READ (simulated worker)", sessionId: "smoke-provider-session" });
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
