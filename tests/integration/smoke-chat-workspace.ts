#!/usr/bin/env bun
/**
 * Isolated browser smoke: real Next -> Bun HTTP API -> temporary SQLite.
 * The test drives task claiming/completion itself; it never starts a provider.
 * Product path knobs (state, uploads, config, REMI_HOME, ...) point into a
 * temporary root, so it neither reads nor writes the real HOME's Remi state.
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
import { chromium, type Browser, type Page, type Response } from "playwright-core";
import type { startMultiremiServer as StartMultiremiServer } from "@multiremi/api.js";
import { HERMETIC_ENV_RUN_ROOT_PATHS, scrubInheritedEnv } from "../setup/hermetic-env-policy.js";

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
// `next dev` rewrites next-env.d.ts to its dev route types; finally puts it back.
const nextEnvPath = join(webRoot, "next-env.d.ts");
const nextEnvBefore = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, "utf8") : null;
const checks: string[] = [];
const apiFailures: string[] = [];
const jsErrors: string[] = [];
let next: ChildProcess | null = null;
let nextLogs = "";
let browser: Browser | null = null;
let page: Page | null = null;
let server: ReturnType<typeof StartMultiremiServer> | null = null;
let db: Database | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let failure: unknown = null;
let pat = "";
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const redact = (value: string) => pat ? value.split(pat).join("[redacted]") : value;

// This is a standalone process. Ignore host deployment knobs so its API cannot
// load host data or background integrations; fixtures below provide all state.
// The path knobs then point inside the temporary root, the layout `bun test`
// uses, so NODE_ENV=test's home-default guard holds.
scrubInheritedEnv();
// Also MULTIREMI_TEST_*, which the scrub keeps: this SQLite-only smoke reads none.
for (const key of Object.keys(process.env)) if (key.startsWith("MULTIREMI_")) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.MULTIREMI_TEST_RUN_ROOT = root;
for (const [key, path] of Object.entries(HERMETIC_ENV_RUN_ROOT_PATHS)) process.env[key] = join(root, path);
// Imported after the env is fixed: some modules resolve paths at load time.
const [{ openSqliteDatabase }, { startMultiremiServer }, { MultiremiStore }] = await Promise.all([
  import("@multiremi/store/db/sqlite.js"), import("@multiremi/api.js"), import("@multiremi/store.js"),
]);

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
  const apiRequests: string[] = [];
  page.on("request", request => {
    if (request.url().startsWith(`${frontend}/api/`)) apiRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on("response", response => {
    if (response.url().startsWith(`${frontend}/api/`) && response.status() >= 500 && response.headers()["x-chat-smoke-injected-fault"] !== "1") apiFailures.push(`${new URL(response.url()).pathname} ${response.status()}`);
  });
  await page.goto(`${frontend}/${workspace.slug}/chat?agent=${agent.id}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  // The page has no banner; its conversation header names the unsaved draft "New chat".
  await page.locator("[data-chat-page-header]").getByRole("heading", { name: "New chat", exact: true }).waitFor();
  const composer = page.locator("[data-chat-composer]");
  const editor = composer.locator('.tiptap[contenteditable="true"]');
  await editor.waitFor();
  assert.equal(await composer.count(), 1, "Standalone Chat must have exactly one composer");
  assert.equal(await page.getByRole("button", { name: "Ask Multiremi", exact: true }).count(), 0, "Standalone page duplicated floating Chat");
  // The footer shows the selected agent and its read-only model chip: the agent
  // has no model, so the runtime's default runs. Then the "/" menu (ADR 0025).
  await composer.locator("[data-chat-composer-footer]").getByText("Smoke Agent", { exact: true }).waitFor();
  await composer.locator("[data-chat-model]").getByText("Default model", { exact: true }).waitFor();
  await editor.press("/");
  const slashMenu = page.getByRole("listbox", { name: "Commands and skills" });
  await slashMenu.getByText("The agent's own commands show up after its first reply.", { exact: true }).waitFor();
  await editor.press("Escape");
  await slashMenu.waitFor({ state: "hidden" });
  check("non-local workspace Chat page loads the selected agent, its model and the / menu without duplicate floating Chat");

  // One primary button (ADR 0020): Send while idle; while a run is active,
  // Stop on an empty composer, otherwise the follow-up mode (Queue by default).
  const action = (name: "send" | "queue" | "steer" | "stop") => composer.locator(`[data-composer-action="${name}"]`);
  const isPost = (path: RegExp) => (response: Response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname);
  const messagePost = isPost(/^\/api\/sessions\/[^/]+\/messages$/);
  const queuePost = isPost(/^\/api\/sessions\/[^/]+\/queue$/);
  /** Sends now: idle starts a turn. */
  const send = async (content: string) => {
    await editor.fill(content);
    const responsePromise = page!.waitForResponse(messagePost);
    await action("send").click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, `Send failed: ${await response.text()}`);
    const result = await response.json() as { message: { id: string }; turn_id?: string };
    const turn = result.turn_id ? store.getTurn(result.turn_id) : null;
    assert(turn?.current_attempt_id, "Send must wake a turn");
    return { message: result.message, turn, attemptId: turn.current_attempt_id };
  };
  /** Queues behind the running turn; the row stays outside the log. */
  const enqueue = async (content: string, submit: () => Promise<void>) => {
    await editor.fill(content);
    const responsePromise = page!.waitForResponse(queuePost);
    await submit();
    const response = await responsePromise;
    assert.equal(response.status(), 200, `Queue failed: ${await response.text()}`);
    const result = await response.json() as { item: { id: string; status: string }; released: unknown };
    assert.equal(result.item.status, "queued");
    assert.equal(result.released, null, "A busy lane must not release a queued row");
    return result.item;
  };
  const queued = () => store.listQueuedMessages(sessionId).items;
  const queueRegion = page.getByRole("region", { name: "Queued messages" });
  const queueRow = (position: number) => queueRegion.locator(`li[aria-label^="Preview queued message ${position}:"]`);
  /**
   * Stop cancels the turn the composer has read. A turn the worker has just
   * claimed may not be the one it shows yet, so Stop is pressed again, as a
   * user would, until the composer cancels this turn.
   */
  const stopFromComposer = async (turnId: string) => {
    const cancel = `POST /api/turns/${turnId}/cancel`;
    await poll(async () => {
      if (!apiRequests.includes(cancel)) {
        await action("stop").click({ timeout: 5_000 }).catch(() => {});
        await poll(() => apiRequests.includes(cancel), 1_000, "cancel request").catch(() => {});
      }
      return apiRequests.includes(cancel);
    }, 15_000, `composer Stop for ${turnId}`);
  };
  const runReply = async (attemptId: string, output: string) => {
    store.startTask(attemptId);
    store.completeTask(attemptId, { output, sessionId: "smoke-provider-session" });
    await page!.getByText(output, { exact: true }).last().waitFor();
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
  await action("stop").waitFor();
  // Queue is the default follow-up mode: the button names it and Mod-Enter uses it.
  const second = await enqueue("CHAT_SMOKE_SECOND: queued follow-up", () => action("queue").click());
  const third = await enqueue("CHAT_SMOKE_THIRD: queued follow-up", () => editor.press("ControlOrMeta+Enter"));
  assert.deepEqual(queued().map(item => item.id), [second.id, third.id]);
  assert.equal(store.claimTask(runtime.id), null, "Queued follow-ups must not start a turn while one runs");
  assert(!store.listChatMessages(sessionId).some(message => message.body.includes("queued follow-up")), "Queued rows stay outside the log");
  await queueRow(1).getByText("CHAT_SMOKE_SECOND: queued follow-up", { exact: true }).waitFor();
  await queueRow(2).getByText("CHAT_SMOKE_THIRD: queued follow-up", { exact: true }).waitFor();
  // Editing loads the row into the composer; Save writes it back.
  await queueRegion.getByRole("button", { name: "Actions for queued message 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit message", exact: true }).click();
  await composer.locator("[data-chat-queue-edit]").getByText("Editing queued message", { exact: true }).waitFor();
  await poll(async () => await editor.innerText() === "CHAT_SMOKE_SECOND: queued follow-up", 10_000, "queued row loaded into the composer");
  await editor.fill("CHAT_SMOKE_SECOND_EDITED");
  await composer.getByRole("button", { name: "Save", exact: true }).click();
  await poll(() => queued()[0]?.body_md === "CHAT_SMOKE_SECOND_EDITED", 10_000, "queue edit persistence");
  await composer.locator("[data-chat-queue-edit]").waitFor({ state: "hidden" });
  await queueRow(1).getByText("CHAT_SMOKE_SECOND_EDITED", { exact: true }).waitFor();
  check("in-flight follow-ups queue on the server outside the log, and a row edits through the composer");

  // Each completed turn releases exactly one queued row, oldest first (#458).
  store.completeTask(first.attemptId, { output: "CHAT_SMOKE_REPLY_ONE (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_REPLY_ONE (simulated worker)", { exact: true }).last().waitFor();
  const releasedSecond = store.claimTask(runtime.id);
  assert(releasedSecond, "Completing the turn must release the first queued row");
  assert.match(releasedSecond.prompt, /CHAT_SMOKE_SECOND_EDITED/);
  assert.doesNotMatch(releasedSecond.prompt, /CHAT_SMOKE_THIRD/);
  assert.deepEqual(queued().map(item => item.id), [third.id]);
  // Once its row leaves the queue, the released text can only be the conversation's.
  await poll(async () => await queueRegion.locator("li").count() === 1, 10_000, "one queued row left");
  await page.getByText("CHAT_SMOKE_SECOND_EDITED", { exact: true }).waitFor();
  await runReply(releasedSecond.id, "CHAT_SMOKE_REPLY_TWO (simulated worker)");
  const releasedThird = store.claimTask(runtime.id);
  assert(releasedThird, "The next completed turn must release the next queued row");
  assert.match(releasedThird.prompt, /CHAT_SMOKE_THIRD/);
  assert.deepEqual(queued(), []);
  await queueRegion.waitFor({ state: "hidden" });
  check("completed simulated turns release one queued row each, in order, and refresh the conversation without reload");

  store.startTask(releasedThird.id);
  await stopFromComposer(releasedThird.turn_id!);
  await poll(() => store.getTask(releasedThird.id)?.status === "cancelled", 10_000, "stop persists cancellation");
  check("Stop cancels the running turn through the real API");

  // Steering (the other mode, Mod-Shift-Enter) sends now into the running
  // turn. Unread messages can still be edited and deleted; a queued row can
  // be steered on its own; deleting a row commits after its undo window.
  const active = await send("CHAT_SMOKE_ACTIVE_FOR_STEER");
  assert.equal(store.claimTask(runtime.id)?.id, active.attemptId);
  store.startTask(active.attemptId);
  await action("stop").waitFor();
  await editor.fill("CHAT_SMOKE_STEER_UNREAD");
  const steerPromise = page.waitForResponse(messagePost);
  await editor.press("ControlOrMeta+Shift+Enter");
  const steerResponse = await steerPromise;
  assert.equal(steerResponse.status(), 200, `Steer failed: ${await steerResponse.text()}`);
  const steered = await steerResponse.json() as { message: { id: string } };
  assert.equal(store.claimTask(runtime.id), null, "A steer joins the running turn");
  const queuedHeaders = { Authorization: `Bearer ${pat}`, "X-Workspace-Slug": workspace.slug };
  const edited = await context.request.patch(`${frontend}/api/messages/${steered.message.id}`, {
    headers: queuedHeaders, data: { body_md: "CHAT_SMOKE_STEER_EDITED" },
  });
  assert.equal(edited.status(), 200);
  assert.equal(store.getMessage(steered.message.id)?.body_md, "CHAT_SMOKE_STEER_EDITED");
  const deleted = await context.request.delete(`${frontend}/api/messages/${steered.message.id}`, { headers: queuedHeaders });
  assert.equal(deleted.status(), 200);
  assert(store.getMessage(steered.message.id)?.deleted_at);
  const rowSteered = await enqueue("CHAT_SMOKE_QUEUE_STEER", () => action("queue").click());
  const rowSteerPromise = page.waitForResponse(isPost(new RegExp(`^/api/sessions/[^/]+/queue/${rowSteered.id}/steer$`)));
  await queueRegion.getByRole("button", { name: "Steer queued message 1", exact: true }).click();
  assert.equal((await rowSteerPromise).status(), 200);
  assert.deepEqual(queued(), []);
  assert.equal(store.claimTask(runtime.id), null, "A steered row joins the running turn");
  await queueRegion.waitFor({ state: "hidden" });
  await page.getByText("CHAT_SMOKE_QUEUE_STEER", { exact: true }).waitFor();
  const rowDeleted = await enqueue("CHAT_SMOKE_QUEUE_DELETE", () => action("queue").click());
  await queueRegion.getByRole("button", { name: "Actions for queued message 1", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete queued message", exact: true }).click();
  await queueRegion.waitFor({ state: "hidden" });
  await poll(() => !queued().some(item => item.id === rowDeleted.id), 15_000, "queued row delete after its undo window");
  assert.equal(store.getTask(active.attemptId)?.status, "running", "Steering and queue edits must preserve the running turn");
  store.completeTask(active.attemptId, { output: "CHAT_SMOKE_STEER_COMPLETE (simulated worker)", sessionId: "smoke-provider-session" });
  await page.getByText("CHAT_SMOKE_STEER_COMPLETE (simulated worker)", { exact: true }).last().waitFor();
  // The simulated worker never read the steered row: it opens the next turn
  // by itself, without the deleted message or the deleted row.
  const unreadTurn = store.claimTask(runtime.id);
  assert(unreadTurn, "An unread steer must wake the next turn");
  assert.match(unreadTurn.prompt, /CHAT_SMOKE_QUEUE_STEER/);
  assert.doesNotMatch(unreadTurn.prompt, /CHAT_SMOKE_STEER_(UNREAD|EDITED)|CHAT_SMOKE_QUEUE_DELETE/);
  await runReply(unreadTurn.id, "CHAT_SMOKE_STEER_READ (simulated worker)");
  check("steer (Mod-Shift-Enter and per row), unread message edit/delete, and queued row delete preserve the running turn");

  // A gateway answer (503) means the send may have landed: the message stays
  // in its bubble as unconfirmed, not back in the composer, and Retry resends
  // it with the same dedupe key.
  const retryContent = "CHAT_SMOKE_RETRY_DRAFT";
  const taskCountBeforeFailure = store.listTasks().length;
  const messageCountBeforeFailure = store.listChatMessages(sessionId).length;
  let injected = false;
  const failureRoute = `${frontend}/api/sessions/${sessionId}/messages`;
  await page.route(failureRoute, async route => {
    if (!injected && route.request().method() === "POST") {
      injected = true;
      await route.fulfill({ status: 503, headers: { "content-type": "application/json", "x-chat-smoke-injected-fault": "1" }, body: JSON.stringify({ error: "Isolated smoke: injected gateway failure" }) });
    } else await route.continue();
  });
  await editor.fill(retryContent);
  const rejectedSend = page.waitForResponse(response => response.url() === failureRoute && response.request().method() === "POST");
  await action("send").click();
  const rejected = await rejectedSend;
  assert.equal(rejected.status(), 503);
  const retryButton = page.getByRole("button", { name: "Retry sending this message", exact: true });
  await retryButton.waitFor();
  await page.getByText("Delivery unconfirmed ·", { exact: true }).waitFor();
  assert.equal((await editor.innerText()).trim(), "", "An unconfirmed send must not return to the draft");
  assert.equal(store.listTasks().length, taskCountBeforeFailure);
  assert.equal(store.listChatMessages(sessionId).length, messageCountBeforeFailure);
  const retriedSend = page.waitForResponse(response => response.url() === failureRoute && response.request().method() === "POST");
  await retryButton.click();
  const retryResponse = await retriedSend;
  assert.equal(retryResponse.status(), 200);
  await page.unroute(failureRoute);
  const dedupeKey = rejected.request().postDataJSON().dedupe_key;
  assert(dedupeKey, "Chat sends carry a dedupe key");
  assert.equal(retryResponse.request().postDataJSON().dedupe_key, dedupeKey, "Retry must reuse the dedupe key");
  const retriedResult = await retryResponse.json() as { turn_id: string };
  const retried = { attemptId: store.getTurn(retriedResult.turn_id)!.current_attempt_id! };
  assert.equal(store.listTasks().filter(item => item.prompt.includes(retryContent)).length, 1);
  assert.equal(store.listChatMessages(sessionId).filter(item => item.body === retryContent).length, 1);
  await retryButton.waitFor({ state: "hidden" });
  assert.equal(store.claimTask(runtime.id)?.id, retried.attemptId);
  await runReply(retried.attemptId, "CHAT_SMOKE_RETRY_COMPLETE (simulated worker)");
  check("an injected gateway 503 leaves the send unconfirmed; Retry reuses its dedupe key and creates exactly one message and task");

  // Sidebar row: Pin is the hover quick action; Rename and Archive live in its ⋯ menu.
  const row = page.locator(`[data-chat-session-row="${sessionId}"]`);
  const rowMenu = async (item: string) => {
    await row.hover();
    await row.getByRole("button", { name: "More actions", exact: true }).click();
    await page!.getByRole("menuitem", { name: item, exact: true }).click();
  };
  await rowMenu("Rename…");
  const renameDialog = page.getByRole("dialog", { name: "Rename chat" });
  await renameDialog.getByRole("textbox", { name: "Rename chat" }).fill("Persistent Chat Smoke");
  await renameDialog.getByRole("button", { name: "Save", exact: true }).click();
  await poll(() => store.getChatSession(sessionId)?.title === "Persistent Chat Smoke", 10_000, "rename persistence");
  await row.hover();
  await row.getByRole("button", { name: "Pin", exact: true }).click();
  await poll(() => store.getChatSession(sessionId)?.pinned === true, 10_000, "pin persistence");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-chat-page-header]").getByRole("heading", { name: "Persistent Chat Smoke", exact: true }).waitFor();
  await page.getByRole("region", { name: "Pinned", exact: true }).locator(`[data-chat-session-row="${sessionId}"]`).getByText("Persistent Chat Smoke", { exact: true }).waitFor();
  await row.hover();
  await row.getByRole("button", { name: "Unpin", exact: true }).waitFor();
  check("rename and pin survive browser reload");

  await rowMenu("Archive");
  await poll(() => store.getChatSession(sessionId)?.status === "archived", 10_000, "archive persistence");
  const restore = page.getByRole("button", { name: "Restore chat", exact: true });
  await restore.waitFor();
  await poll(() => action("send").isDisabled(), 10_000, "archived composer disabled");
  await page.getByText("This session is archived", { exact: true }).waitFor();
  // An archived Chat refuses new queued rows (a member's direct message would reopen it).
  const denied = await context.request.post(`${frontend}/api/sessions/${sessionId}/queue`, { headers: queuedHeaders, data: { body_md: "ARCHIVED_SHOULD_NOT_QUEUE", client_id: randomUUID() } });
  assert.equal(denied.status(), 409);
  assert.equal((await denied.json() as { code?: string }).code, "chat_archived");
  assert.deepEqual(queued(), []);
  await restore.click();
  await poll(() => store.getChatSession(sessionId)?.status === "active", 10_000, "restore persistence");
  await restore.waitFor({ state: "hidden" });
  check("archive makes the session read-only in the UI and refuses queued rows in the API; restore re-enables it");

  // Remount the active session in floating Chat, upload without sending, then
  // remount it again as the standalone page to exercise draft attachment state.
  await page.getByRole("link", { name: "Issues", exact: true }).click();
  await page.waitForURL(url => url.pathname === `/${workspace.slug}/issues`);
  await page.getByRole("button", { name: "Open Chat page", exact: true }).waitFor();
  await editor.waitFor();
  const attachmentFile = join(root, "chat-smoke-attachment.txt");
  writeFileSync(attachmentFile, "Private attachment fixture for isolated Chat smoke.\n");
  const uploadedPromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/upload-file");
  await composer.locator('input[type="file"]').setInputFiles(attachmentFile);
  const uploaded = await uploadedPromise;
  assert.equal(uploaded.status(), 200);
  const upload = await uploaded.json() as { id: string };
  await editor.getByText("chat-smoke-attachment.txt", { exact: true }).waitFor();
  assert.equal(store.getAttachment(upload.id)?.chatMessageId, null, "Upload must remain an unsent draft");
  await page.getByRole("button", { name: "Open Chat page", exact: true }).click();
  await page.waitForURL(url => url.pathname === `/${workspace.slug}/chat` && url.searchParams.get("session") === sessionId);
  await editor.getByText("chat-smoke-attachment.txt", { exact: true }).waitFor();
  assert.equal(await composer.count(), 1, "Cross-surface navigation duplicated the composer");
  const sentAttachmentPromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/sessions/${sessionId}/messages`);
  await action("send").click();
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
  await runReply(attached.attemptId, "CHAT_SMOKE_ATTACHMENT_READ (simulated worker)");
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
  assert.equal(await composer.count(), 1);
  await page.screenshot({ path: join(artifacts, "chat-mobile.png"), fullPage: false });
  await page.getByRole("button", { name: "Chat history", exact: true }).click();
  await row.getByText("Persistent Chat Smoke", { exact: true }).waitFor();
  await editor.waitFor({ state: "hidden" });
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
  if (nextEnvBefore !== null && (!existsSync(nextEnvPath) || readFileSync(nextEnvPath, "utf8") !== nextEnvBefore)) writeFileSync(nextEnvPath, nextEnvBefore);
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
