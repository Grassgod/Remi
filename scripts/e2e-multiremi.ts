#!/usr/bin/env bun
/**
 * Full-stack e2e for the native Multiremi server + its built-in dashboard.
 *
 * Boots a real `startMultiremiServer` (open local mode) on an isolated temp DB,
 * seeds an agent, runs a REAL agent task to completion through the daemon, then
 * drives the dashboard in a real Chromium browser (Playwright) and asserts:
 *   - the dashboard HTML is served at `/`
 *   - every endpoint the dashboard loads on boot returns 200
 *   - a real agent task completes end-to-end (provider transcript + marker)
 *   - the page renders, seeded data appears, a UI write round-trips, and there
 *     are zero uncaught JS errors / failed API requests
 *
 * Usage: bun run scripts/e2e-multiremi.ts [--provider=claude|codex] [--port=6191]
 */
import "../src/shared/db/sqlite-custom.js"; // must be first: swaps sqlite before any Database
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { setDbPath } from "../src/shared/db/index.js";
import { startMultiremiServer } from "../src/multiremi/api.js";
import { MultiremiStore } from "../src/multiremi/store.js";
import { MultiremiDaemon } from "../src/multiremi/daemon.js";
import { chromium } from "playwright-core";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}
const PROVIDER = (args.get("provider") || "claude") as "claude" | "codex";
const PORT = Number(args.get("port") || 6191);
const MARKER = "__E2E_OK__";

/** Resolve a usable Chromium from the Playwright browser cache (version-agnostic). */
function resolveChrome(): string {
  if (process.env.E2E_CHROME && existsSync(process.env.E2E_CHROME)) return process.env.E2E_CHROME;
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return "";
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const sub of ["chrome-linux64", "chrome-linux"]) {
      const p = join(root, d, sub, "chrome");
      if (existsSync(p)) return p;
    }
  }
  return "";
}
const CHROME = resolveChrome();

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "multiremi-e2e-db-"));
  const workDir = mkdtempSync(join(tmpdir(), "multiremi-e2e-work-"));
  setDbPath(join(dbDir, "e2e.db"));
  const store = new MultiremiStore();

  const agent = store.createAgent({
    name: "E2E Smoke Agent",
    provider: PROVIDER,
    cwd: workDir,
    model: null,
    allowedTools: [],
  });
  // Seed an issue so the board page has content to render.
  const issue = store.createIssue({
    workspaceId: "local",
    title: "E2E seeded issue",
    description: "Created by the e2e harness",
  });

  const server = startMultiremiServer({ store, scheduler: null, hostname: "127.0.0.1", port: PORT });
  const base = `http://127.0.0.1:${PORT}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    // ───────────────────────── API e2e ─────────────────────────
    const rootRes = await fetch(base + "/");
    const html = await rootRes.text();
    check("GET / serves dashboard HTML", rootRes.ok && /<html/i.test(html) && /multiremi/i.test(html),
      `status=${rootRes.status} len=${html.length}`);

    const loadEndpoints = [
      "/api/multiremi/agents", "/api/multiremi/issues", "/api/multiremi/tasks",
      "/api/multiremi/runtimes", "/api/multiremi/members", "/api/multiremi/projects",
      "/api/multiremi/squads", "/api/multiremi/autopilots", "/api/multiremi/skills",
      "/api/multiremi/tokens", "/api/multiremi/notification-preferences",
      "/api/multiremi/github/settings", "/api/multiremi/chats", "/api/multiremi/inbox",
      "/api/multiremi/labels", "/api/multiremi/pins", "/api/dashboard/usage/daily",
      "/api/dashboard/usage/by-agent", "/api/dashboard/runtime/daily",
    ];
    let allOk = true;
    const bad: string[] = [];
    for (const ep of loadEndpoints) {
      const r = await fetch(base + ep);
      if (!r.ok) { allOk = false; bad.push(`${ep}=${r.status}`); }
    }
    check(`all ${loadEndpoints.length} dashboard-load endpoints return 200`, allOk, bad.join(" "));

    const agentsJson = await (await fetch(base + "/api/multiremi/agents")).json();
    check("seeded agent present via API", (agentsJson.agents || []).some((a: any) => a.id === agent.id));
    const issuesJson = await (await fetch(base + "/api/multiremi/issues")).json();
    check("seeded issue present via API", (issuesJson.issues || []).some((i: any) => i.id === issue.id));

    // Real agent run: create a task, run the daemon once against the live provider.
    const task = store.createTask({
      agentId: agent.id,
      prompt: `Reply with exactly the token ${MARKER} and nothing else. Do not use any tools.`,
      workspaceId: "local",
      workDir,
    });
    const daemonToken = await store.createAccessToken({ name: "e2e daemon", type: "daemon", workspaceId: "local" });
    const daemon = new MultiremiDaemon({
      serverUrl: base,
      token: daemonToken.token,
      provider: PROVIDER,
      runtimeName: "e2e-runtime",
      workspaceId: "local",
      once: true,
      taskTimeoutMs: 120_000,
    });
    await daemon.start();
    const done = store.getTask(task.id);
    check("real agent task completed", done?.status === "completed",
      `status=${done?.status} reason=${done?.failureReason || ""}`);
    check(`agent output contains marker ${MARKER}`, String(done?.result || "").includes(MARKER),
      `output=${JSON.stringify(done?.result || "").slice(0, 80)}`);
    const messages = store.listTaskMessages(task.id);
    check("agent transcript has assistant + usage messages",
      messages.some((m) => m.type === "assistant") && messages.some((m) => m.type === "usage"),
      `types=${[...new Set(messages.map((m) => m.type))].join(",")}`);

    // ───────────────────────── Page e2e (Playwright) ─────────────────────────
    if (!CHROME) throw new Error("No Chromium found in ~/.cache/ms-playwright (set E2E_CHROME or run: bunx playwright install chromium)");
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    const jsErrors: string[] = [];      // real uncaught JS exceptions
    const failedApi: string[] = [];     // /api/ requests that 5xx or fail
    const badResponses: string[] = [];  // any 4xx/5xx HTTP response
    page.on("pageerror", (e) => jsErrors.push(String(e)));
    page.on("requestfailed", (r) => { if (r.url().includes("/api/")) failedApi.push(r.url()); });
    page.on("response", (r) => {
      const s = r.status();
      if (s >= 400) badResponses.push(`${r.url().replace(base, "")} = ${s}`);
      if (r.url().includes("/api/") && s >= 500) failedApi.push(`${r.url()}=${s}`);
    });

    await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("[data-page]", { timeout: 15_000 });
    // Wait for the boot data-load to populate the agent into client state.
    await page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      "E2E Smoke Agent",
      { timeout: 15_000 },
    ).catch(() => {});
    check("dashboard shell renders (nav present)", (await page.$$("[data-page]")).length > 0);

    // Navigate to Agents page → seeded agent visible
    await page.click('[data-page="agents"]');
    await page.waitForTimeout(600);
    const agentsBody = (await page.textContent("body")) || "";
    check("UI Agents page shows seeded agent", agentsBody.includes("E2E Smoke Agent"));

    // Navigate to Runtimes page → the runtime created by the real daemon run is visible
    await page.click('[data-page="runtimes"]');
    await page.waitForTimeout(600);
    const runtimesBody = (await page.textContent("body")) || "";
    check("UI Runtimes page shows the e2e runtime", runtimesBody.includes("e2e-runtime"));

    // Navigate to Issues board → seeded issue visible
    await page.click('[data-page="issues"]');
    await page.waitForTimeout(600);
    const issuesBody = (await page.textContent("body")) || "";
    check("UI Issues board shows seeded issue", issuesBody.includes("E2E seeded issue"));

    // UI-driven write round-trip: create an issue via the API while the page is open,
    // then click the in-page Refresh button and assert it renders (UI fetch → backend → render).
    const newTitle = "E2E live-refresh issue " + task.id.slice(-6);
    const createRes = await fetch(base + "/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "local", title: newTitle }),
    });
    check("POST /api/multiremi/issues creates issue", createRes.ok, `status=${createRes.status}`);
    const refreshBtn = await page.$("#refresh");
    if (refreshBtn) await refreshBtn.click();
    await page.waitForFunction(
      (t) => document.body.innerText.includes(t),
      newTitle,
      { timeout: 10_000 },
    ).catch(() => {});
    const afterRefresh = (await page.textContent("body")) || "";
    check("UI renders newly created issue after refresh", afterRefresh.includes(newTitle));

    check("no uncaught JS exceptions on dashboard", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
    check("no failed/5xx API requests from page", failedApi.length === 0, failedApi.slice(0, 3).join(" | "));
    check("no 4xx/5xx HTTP responses anywhere in the page session", badResponses.length === 0, badResponses.slice(0, 5).join(", "));

    const shot = join(tmpdir(), `multiremi-e2e-dashboard-${PROVIDER}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`\nScreenshot: ${shot}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.stop(true);
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "✅ ALL PASS" : "❌ " + failed.length + " FAILED"} (${checks.length} checks, provider=${PROVIDER})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E harness error:", e); process.exit(1); });
