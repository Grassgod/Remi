#!/usr/bin/env bun
/**
 * Real browser -> isolated Next -> Bun API -> temporary SQLite password login.
 * No provider, user configuration, Docker, or external login service is used.
 * Run: bun run tests/integration/smoke-local-auth.ts [--port=3328]
 * Optional CHROME_EXECUTABLE selects an installed browser. Only sanitized UI
 * screenshots and redacted diagnostics survive; credentials stay in memory.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: bun run tests/integration/smoke-local-auth.ts [--port=3328]\nOptional: CHROME_EXECUTABLE=/path/to/chrome. No existing credentials required.");
  process.exit(0);
}
for (const arg of args) assert.match(arg, /^--port=\d+$/, "Unsupported argument");
const port = Number(args.find(arg => arg.startsWith("--port="))?.slice(7) ?? 3328);
assert(Number.isInteger(port) && port > 0 && port < 65536, "Invalid frontend port");
const repo = resolve(import.meta.dir, "../..");
const frontend = `http://127.0.0.1:${port}`;
const fixtureRoot = mkdtempSync(join(tmpdir(), "remi-local-auth-fixture-"));
const artifacts = mkdtempSync(join(tmpdir(), "remi-local-auth-smoke-"));
const secrets: string[] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const [master, passwordA, passwordB, wrongPassword] = secrets as [string, string, string, string];
const emailA = `smoke-a-${randomUUID()}@localhost`;
const emailB = `smoke-b-${randomUUID()}@localhost`;
secrets.push(emailA, emailB);
const checks: string[] = [];
const errors: string[] = [];
let next: ChildProcess | null = null;
let nextLogs = "";
let browser: Browser | null = null;
let server: ReturnType<typeof startMultiremiServer> | null = null;
let callbackServer: ReturnType<typeof Bun.serve> | null = null;
let db: Database | null = null;
let failure: unknown = null;
const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };

// This standalone process must not inherit deployment credentials or services.
for (const key of Object.keys(process.env)) if (key.startsWith("MULTIREMI_")) delete process.env[key];
process.env.MULTIREMI_UPLOAD_DIR = join(fixtureRoot, "uploads");
process.env.MULTIREMI_ALLOW_PASSWORD_LOGIN = "1";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = randomUUID();
secrets.push(process.env.JWT_SECRET);

try {
  await assertPortAvailable(port);
  db = new Database(join(fixtureRoot, "auth.sqlite"));
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const workspace = store.createWorkspace({ name: "Auth smoke workspace", slug: "auth-smoke" });
  server = startMultiremiServer({ store, authToken: master, hostname: "127.0.0.1", port: 0, backgroundJobs: false, scheduler: null, scmPolling: null, messaging: null, controlPlaneSshMesh: null });
  const backend = `http://127.0.0.1:${server.port}`;
  const configure = async (email: string, password: string, name: string) => {
    const response = await fetch(`${backend}/api/auth/password-accounts`, {
      method: "POST", headers: { Authorization: `Bearer ${master}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, workspaceId: workspace.id }),
    });
    assert.equal(response.status, 201, "Fixture account configuration failed");
    const account = await response.json() as { user: { id: string } };
    assert(account.user.id.startsWith("usr_"), "Password account must have a real user identity");
    assert.equal(store.getUserRoleInWorkspace(account.user.id, workspace.id), "owner");
    return account.user.id;
  };
  const userA = await configure(emailA, passwordA, "Browser smoke user A");
  const userB = await configure(emailB, passwordB, "Browser smoke user B");
  assert.notEqual(userA, userB);
  check("master-authenticated HTTP provisioning creates two distinct real account identities");

  const env = { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", REMOTE_API_URL: backend, NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: "", NEXT_PUBLIC_LOCAL_PROFILE: "dev", NEXT_PUBLIC_SITE_URL: frontend, FRONTEND_PORT: String(port) };
  next = spawn("node", [require.resolve("next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: join(repo, "frontend/apps/web"), env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  next.on("error", error => { nextLogs += `\n${redact(error.message)}`; });
  for (const stream of [next.stdout, next.stderr]) stream?.on("data", chunk => { nextLogs = (nextLogs + String(chunk)).slice(-24_000); });
  await poll(async () => {
    assert(next?.exitCode === null, "Next process exited during startup");
    try { return (await fetch(`${frontend}/api/health`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { return false; }
  }, 90_000, "Next startup");
  browser = await chromium.launch({ executablePath: resolveChrome(), headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addCookies([{ name: "multimira-locale", value: "en", url: frontend }]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(90_000);
  page.on("pageerror", error => errors.push(redact(error.message)));
  page.on("response", response => {
    if (response.url().startsWith(frontend) && /^\/(api|auth)\//.test(new URL(response.url()).pathname) && response.status() >= 500) {
      errors.push(`${new URL(response.url()).pathname} ${response.status()}`);
    }
  });
  const protectedPath = `/${workspace.slug}/issues`;
  const loginUrl = `${frontend}/login?next=${encodeURIComponent(protectedPath)}`;
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByLabel("Account email", { exact: true }).waitFor();
  await page.getByLabel("Local session key (24 hours)", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Password", { exact: true }).getAttribute("type"), "password");
  await safeScreenshot(page, "login-empty.png");
  check("explicit dev profile on loopback exposes password and local-key forms");

  const login = async (email: string, password: string, expectedStatus: number) => {
    await page.getByLabel("Account email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    const pending = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/auth/password");
    await page.getByRole("button", { name: "Sign in with password", exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), expectedStatus, "Password login returned unexpected HTTP status");
    if (expectedStatus !== 200) return null;
    const payload = await response.json() as { token: string; user: { id: string } };
    secrets.push(payload.token);
    return payload;
  };
  await login(emailA, wrongPassword, 401);
  await page.getByText("Could not sign in. Check your email and password, then try again.", { exact: true }).waitFor();
  await poll(async () => await page.getByLabel("Password", { exact: true }).inputValue() === "", 5000, "password cleared after rejection");
  assert.equal(new URL(page.url()).pathname, "/login");
  assert(!await page.evaluate(() => localStorage.getItem("multimira_token")), "Rejected password established client authentication");
  assert(!(await context.cookies()).some(cookie => cookie.name === "multimira_auth"), "Rejected password established a session cookie");
  check("wrong password returns 401, clears the password input, and creates no browser session");

  const sessionA = (await login(emailA, passwordA, 200))!;
  assert.equal(sessionA.user.id, userA);
  await page.waitForURL(url => url.pathname === protectedPath);
  await page.getByRole("button", { name: /Auth smoke workspace$/ }).waitFor();
  const cookie = (await context.cookies()).find(item => item.name === "multimira_auth");
  assert(cookie?.httpOnly && cookie.sameSite === "Strict", "Password cookie must be HttpOnly and SameSite=Strict");
  assert(cookie.value === sessionA.token, "Cookie and returned session differ");
  assert((await store.verifyAccessToken(sessionA.token))?.userId === userA, "Issued token has incorrect owner");
  assert.equal(await currentUserId(context), userA);
  check("password login, cookie-authenticated /api/me, and token ownership agree on the configured real user");
  const refreshedMe = page.waitForResponse(response => new URL(response.url()).pathname === "/api/me" && response.status() === 200);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal((await (await refreshedMe).json()).id, userA);
  await page.getByRole("button", { name: /Auth smoke workspace$/ }).waitFor();
  assert.equal(await currentUserId(context), userA);
  await page.getByText("No issues yet", { exact: true }).waitFor();
  await safeScreenshot(page, "authenticated-workspace.png");
  check("browser reload restores the same user and workspace through the real API");

  const logout = async (sessionToken: string) => {
    await page.getByRole("button", { name: /Auth smoke workspace$/ }).click();
    const pending = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/auth/logout");
    await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
    assert.equal((await pending).status(), 200);
    await page.waitForURL(url => url.pathname === "/login");
    await poll(async () => !(await context.cookies()).some(item => ["multimira_auth", "multimira_logged_in"].includes(item.name)), 5000, "logout clears authentication cookies");
    assert(!await page.evaluate(() => localStorage.getItem("multimira_token")), "Logout retained localStorage authentication");
    assert(!await store.verifyAccessToken(sessionToken), "Logout did not revoke the session");
    assert.equal((await context.request.get(`${frontend}/api/me`)).status(), 401);
    assert.equal((await fetch(`${backend}/api/me`, { headers: { Authorization: `Bearer ${sessionToken}` } })).status, 401);
  };
  await logout(sessionA.token);
  await page.getByLabel("Account email", { exact: true }).waitFor();
  await safeScreenshot(page, "logged-out.png");
  check("UI logout clears cookies and local storage; revoked cookie and bearer sessions both return 401");

  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  await login(emailA, passwordA, 200);
  await page.waitForURL(url => url.pathname === protectedPath);
  const state = randomUUID();
  secrets.push(state);
  let callbackToken: string | null = null;
  let callbackState: string | null = null;
  callbackServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    callbackToken = url.searchParams.get("token");
    callbackState = url.searchParams.get("state");
    if (callbackToken) secrets.push(callbackToken);
    return new Response("CLI callback received", { headers: { "Content-Type": "text/plain" } });
  } });
  const callbackUrl = `http://127.0.0.1:${callbackServer.port}/callback`;
  // A CLI handoff must also recognize an existing HttpOnly browser session
  // when localStorage has no token; initialization must not revoke that cookie.
  await page.evaluate(() => localStorage.removeItem("multimira_token"));
  await page.goto(`${frontend}/login?cli_callback=${encodeURIComponent(callbackUrl)}&cli_state=${state}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Use a different account", exact: true }).click();
  const sessionB = (await login(emailB, passwordB, 200))!;
  assert.equal(sessionB.user.id, userB);
  await poll(() => callbackToken !== null, 10_000, "CLI callback");
  assert(callbackToken === sessionB.token, "CLI callback must retain the newly authenticated session");
  assert(callbackState === state, "CLI callback state mismatch");
  const cliMe = await fetch(`${backend}/api/me`, { headers: { Authorization: `Bearer ${callbackToken}` } });
  assert.equal(cliMe.status, 200);
  assert.equal((await cliMe.json()).id, userB);
  check("CLI recognizes a cookie-only session and switching accounts returns the new account identity");
  // Never capture the callback URL, which contains a short-lived credential.
  await page.goto(`${frontend}${protectedPath}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Auth smoke workspace$/ }).waitFor();
  assert.equal(await currentUserId(context), userB);
  // A live cookie would show Authorize if the callback validator accepted this
  // hostname; checking while signed out would not exercise that distinction.
  await page.goto(`${frontend}/login?cli_callback=${encodeURIComponent("http://10.attacker.example/callback")}`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Account email", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Authorize", exact: true }).count(), 0);
  assert.equal(new URL(page.url()).origin, frontend);
  check("a public hostname with a private-IP-looking prefix does not enable CLI authorization");
  await page.goto(`${frontend}${protectedPath}`, { waitUntil: "domcontentloaded" });
  await logout(sessionB.token);
  assert.deepEqual(errors, [], "Unexpected browser/API errors");
  check("no uncaught browser exceptions or API 5xx responses");
} catch (error) {
  failure = error;
  // Failure screenshots/DOM/traces may include typed credentials, so omit them.
} finally {
  await browser?.close().catch(() => {});
  if (next?.pid) {
    try { process.kill(process.platform === "win32" ? next.pid : -next.pid, "SIGTERM"); } catch { /* Already exited. */ }
    await poll(() => next?.exitCode !== null || next?.signalCode !== null, 5000, "Next shutdown").catch(() => {
      try { process.kill(process.platform === "win32" ? next!.pid! : -next!.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    });
  }
  callbackServer?.stop(true);
  server?.stop(true);
  db?.close();
  rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
const report = { ok: failure === null, checks, artifacts, realProvider: false, errors: errors.map(redact), error: failure instanceof Error ? redact(failure.stack ?? failure.message) : failure };
writeFileSync(join(artifacts, "next.log"), redact(nextLogs));
writeFileSync(join(artifacts, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(failure === null ? 0 : 1);

async function currentUserId(context: BrowserContext): Promise<string> {
  const response = await context.request.get(`${frontend}/api/me`);
  assert.equal(response.status(), 200);
  return (await response.json()).id;
}

async function safeScreenshot(page: Page, name: string): Promise<void> {
  assert(!new URL(page.url()).searchParams.has("token"), "Refusing credential-bearing screenshot");
  const text = await page.locator("body").innerText();
  assert(!secrets.some(secret => text.includes(secret)), "Refusing screenshot with visible credentials");
  await page.screenshot({ path: join(artifacts, name), fullPage: false, mask: [page.locator("input")] });
}

async function poll(condition: () => boolean | Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
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
  for (const cache of [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")]) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache).filter(name => name.startsWith("chromium")).sort().reverse()) {
      for (const suffix of ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux64/chrome"]) {
        const candidate = join(cache, entry, suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert(existsSync(chrome), "No Chromium found; set CHROME_EXECUTABLE");
  return chrome;
}
