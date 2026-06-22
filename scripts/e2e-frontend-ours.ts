#!/usr/bin/env bun
/**
 * Phase 2 e2e: the polished Next.js (Multica) frontend running against OUR Bun
 * backend (src/multiremi) on Postgres.
 *
 *   frontend (Next.js :3001, REMOTE_API_URL=http://127.0.0.1:6130)
 *        → our backend (src/multiremi, :6130, Postgres)
 *
 * Auth: the web app uses token mode when localStorage["multimira_token"] is set
 * (web-providers.tsx: cookieAuth = !hasLegacyToken()). We mint a PAT from our
 * backend's local-auth flow, inject it, and the app authenticates via Bearer.
 */
import { chromium } from "playwright-core";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const BACKEND = "http://127.0.0.1:6130";
const FRONTEND = "http://127.0.0.1:3000";

function resolveChrome(): string {
  const root = join(homedir(), ".cache", "ms-playwright");
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium-") && !x.includes("headless")).sort().reverse()) {
    const p = join(root, d, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  return "";
}

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
};

async function mintToken(): Promise<string> {
  const email = "e2e@example.com";
  const sent = await (await fetch(`${BACKEND}/auth/send-code`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, name: "E2E" }),
  })).json();
  const verified = await (await fetch(`${BACKEND}/auth/verify-code`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code: sent.code }),
  })).json();
  return verified.access_token ?? verified.token;
}

async function main() {
  const token = await mintToken();
  check("minted PAT from our backend's local-auth flow", !!token, `${String(token).slice(0, 16)}…`);

  const browser = await chromium.launch({
    executablePath: resolveChrome(), headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext();
  // Token mode for the client API; the SSR proxy gates on the `multimira_logged_in`
  // cookie (it can't see localStorage), so set the session marker + workspace slug.
  await ctx.addCookies([
    { name: "multimira_logged_in", value: "1", url: FRONTEND },
    { name: "last_workspace_slug", value: "local", url: FRONTEND },
  ]);
  await ctx.addInitScript((t) => localStorage.setItem("multimira_token", t as string), token);
  const page = await ctx.newPage();

  const jsErrors: string[] = [];
  const badApi: string[] = [];
  let gotIssueData = false;
  const verbose = process.env.E2E_VERBOSE === "1";
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  page.on("response", async (r) => {
    const u = r.url();
    if (verbose && (/\/api\/|\/auth\//.test(u))) console.log(`   [resp] ${r.status()} ${u.replace(FRONTEND, "").slice(0, 70)}`);
    if (u.includes("/api/") && r.status() >= 500) badApi.push(`${u.replace(BACKEND, "")}=${r.status()}`);
    if (/\/api\/issues/.test(u) && r.status() === 200) {
      try { if (/MUL-\d|PG issue|PG via HTTP/.test(await r.text())) gotIssueData = true; } catch { /* body consumed */ }
    }
  });
  if (verbose) {
    page.on("console", (m) => { if (m.type() !== "debug") console.log(`   [console.${m.type()}] ${m.text().slice(0, 110)}`); });
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log(`   [nav] ${f.url()}`); });
  }

  try {
    await page.goto(`${FRONTEND}/local/issues`, { waitUntil: "networkidle", timeout: 40_000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    check("frontend did NOT bounce to /login (authenticated via our backend)", !/\/login/.test(url), `url=${url}`);

    const visible = (await page.evaluate(() => document.body.innerText)) || "";
    check("workspace dashboard shell rendered (nav: Issues/Projects/Inbox)", /Issues/.test(visible) && /Projects/.test(visible) && !/\/login/.test(url),
      `${visible.length} visible chars`);
    // The board fetches /api/issues* from our backend; assert it received our PG issues.
    await page.waitForTimeout(1500);
    check("frontend fetched our Postgres issues via /api/issues* (200, MUL-/PG data)", gotIssueData);

    // The agent/issue we created live in OUR Postgres DB — they must appear.
    const me = await page.evaluate(async (b) => {
      try { return await (await fetch(`${b}/api/me`, { headers: {} })).json(); } catch { return null; }
    }, BACKEND);
    check("our backend /api/me reachable from the page", !!me?.id, `user=${me?.email}`);

    check("no 5xx API responses from our backend", badApi.length === 0, badApi.slice(0, 4).join(", "));
    check("no uncaught JS exceptions", jsErrors.length === 0, jsErrors.slice(0, 2).join(" | "));

    const shot = join(tmpdir(), "ours-frontend.png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`\nScreenshot: ${shot}`);
    console.log(`Final URL: ${url}`);
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "✅ ALL PASS" : "❌ " + failed.length + " FAILED"} (${checks.length} checks)`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("e2e error:", e); process.exit(1); });
