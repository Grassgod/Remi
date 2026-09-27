#!/usr/bin/env bun
/**
 * MUL-395 S9-0 local end-to-end: run the page-speed probe against a real
 * `next start` web build over the MUL-394 in-memory fixture.
 *
 *   cd frontend/apps/web && REMOTE_API_URL=http://127.0.0.1:17580 bun run build
 *   bun run tests/manual/mul395-s9-0-probe.ts
 *
 * Why this exists: S9-0 changes what the warm numbers mean, so the check that
 * matters is "does a warm round now report `navStartMs > 0`, a positive
 * click-relative `readyMs`, a populated per-request table and a `stats.apiByPath`"
 * — none of which a unit test can prove, because they need a browser, a router
 * and real requests.
 *
 * Localhost only, no production host, no credentials from the environment: the
 * token is minted from the in-memory store and handed to the probe through
 * `MULTIREMI_QA_WEB_TOKEN`, exactly like `tests/manual/mul384-perf-harness.ts`.
 *
 * Env:
 *   MUL395_API_PORT   API port (default: first free at/above 17600)
 *   MUL395_WEB_PORT   web port (default: first free at/above 17700)
 *   MUL395_NAME       report stem (default MUL-395-s9-0-local-<date>)
 *   MUL395_ROUNDS     rounds per scenario (default 2)
 *   MUL395_ONLY       pass through to --only
 *   MUL395_COMPARE    path to a baseline JSON for --compare
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";
import { seedZeroJumpFixture } from "../integration/zero-jump-fixture";

function findFreePort(start: number): number {
  for (let port = start; port < start + 50; port++) {
    try {
      const probe = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("") });
      probe.stop(true);
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`no free port in ${start}..${start + 50}`);
}

const API_PORT = Number(process.env.MUL395_API_PORT ?? findFreePort(17600));
const WEB_PORT = Number(process.env.MUL395_WEB_PORT ?? findFreePort(17700));
const ROUNDS = Number(process.env.MUL395_ROUNDS ?? 2);
const REPO_ROOT = resolve(import.meta.dir, "../..");
const WEB_APP_DIR = join(REPO_ROOT, "frontend", "apps", "web");
const OUT_DIR = join(REPO_ROOT, "reports", "performance");
const TODAY = new Date().toISOString().slice(0, 10);
const NAME = process.env.MUL395_NAME ?? `MUL-395-s9-0-local-${TODAY}`;

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      if (res.status < 500) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(300);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const database = new Database(":memory:");
const store = new MultiremiStore(database);
const fixture = await seedZeroJumpFixture(store);

// The long fixture's markdown embeds `/api/attachments/<id>/content`, and the API
// reads those bytes off disk; point it at a temp dir this process owns.
const uploadDir = join(tmpdir(), `mul395-s90-uploads-${process.pid}`);
mkdirSync(join(uploadDir, fixture.workspaceId), { recursive: true });
for (let index = 0; index < fixture.counts.longImages; index += 1) {
  writeFileSync(join(uploadDir, fixture.workspaceId, `att_zerojump_img_${index}.png`), Buffer.from(PNG_1X1, "base64"));
}
process.env.MULTIREMI_UPLOAD_DIR = uploadDir;

const apiServer = startMultiremiServer({
  store,
  port: API_PORT,
  hostname: "127.0.0.1",
  authToken: null,
  backgroundJobs: false,
  requestMetrics: { enabled: true, slowRequestMs: 0, summaryIntervalMs: 60_000, summaryTopRoutes: 10, bufferCapacity: 1024 },
});

const web = Bun.spawn({
  cmd: ["bun", "x", "next", "start", "--port", String(WEB_PORT)],
  cwd: WEB_APP_DIR,
  env: { ...process.env, PORT: String(WEB_PORT) },
  stdout: "pipe",
  stderr: "pipe",
});
void (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of web.stdout as ReadableStream<Uint8Array>) process.stdout.write(`[web] ${decoder.decode(chunk)}`);
})().catch(() => {});
void (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of web.stderr as ReadableStream<Uint8Array>) process.stderr.write(`[web] ${decoder.decode(chunk)}`);
})().catch(() => {});

let exitCode = 0;
try {
  await waitForHttp(`http://127.0.0.1:${API_PORT}/health`, 30_000);
  const webBase = `http://localhost:${WEB_PORT}`;
  await waitForHttp(`${webBase}/login`, 90_000);
  process.stdout.write(`api=${API_PORT} web=${webBase}\n`);

  const minted = await store.createAccessToken({
    name: "MUL-395 S9-0 local probe",
    type: "pat",
    purpose: "personal",
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    expiresInDays: 1,
  });
  const token = minted.token;
  if (!token) throw new Error("store did not return a token");
  const check = await fetch(`http://127.0.0.1:${API_PORT}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!check.ok) throw new Error(`minted token rejected by /api/me: ${check.status}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const probe = Bun.spawn({
    cmd: [
      "bun", "run", join(REPO_ROOT, "frontend/scripts/perf/page-speed.ts"),
      "--base-url", webBase,
      "--rounds", String(ROUNDS),
      "--window", "offpeak",
      "--name", NAME,
      "--out", OUT_DIR,
      "--issue-short", fixture.shortIssueId,
      "--issue-long", fixture.longIssueId,
      // MUL-454 (`iss_o2skonppbq2u`) is a production fixture and does not exist
      // in this in-memory store, so the local run points `detail-xlong` at the
      // local long issue: the scenario's wiring is what this checks. The default
      // stays MUL-454 in the probe itself.
      "--issue-xlong", process.env.MUL395_XLONG ?? fixture.longIssueId,
      "--issue-running", fixture.runningIssueId,
      ...(process.env.MUL395_ONLY ? ["--only", process.env.MUL395_ONLY] : []),
      ...(process.env.MUL395_COMPARE ? ["--compare", process.env.MUL395_COMPARE] : []),
    ],
    cwd: REPO_ROOT,
    env: { ...process.env, MULTIREMI_QA_WEB_TOKEN: token },
    stdout: "pipe",
    stderr: "pipe",
  });
  const pump = async (stream: ReadableStream<Uint8Array> | undefined, sink: (text: string) => void): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink(decoder.decode(value, { stream: true }));
    }
  };
  const timer = setTimeout(() => {
    process.stderr.write("probe exceeded 1200s; killing it\n");
    probe.kill();
  }, 1_200_000);
  const [code] = await Promise.all([
    probe.exited,
    pump(probe.stdout, (text) => process.stdout.write(text)),
    pump(probe.stderr, (text) => process.stderr.write(text)),
  ]);
  clearTimeout(timer);
  if (code !== 0) exitCode = code;

  // ── the S9-0 assertions the artifacts have to satisfy ────────────────────
  const artifacts = readdirSync(OUT_DIR).filter((file) => file.startsWith(NAME));
  const jsonPath = join(OUT_DIR, `${NAME}.json`);
  const report = JSON.parse(readFileSync(jsonPath, "utf8")) as {
    meta: { schema: number; entryQuietMs: number | null; entryQuietCapMs: number };
    scenarios: Array<{
      key: string;
      mode: string;
      rounds: Array<{
        navStartMs: number;
        clickT: number | null;
        readyMs: number | null;
        firstRealMs: number | null;
        serialChain: string[];
        entrySettled: boolean | null;
        entryInflightAtClick: number | null;
        apiFirstScreen: number;
        apiFirstScreenEntries: Array<{ path: string; wave: number; after: number | null; gapMs: number | null; startMs: number }>;
      }>;
      stats: { apiByPath: Array<{ path: string; count: number; totalP95: number | null; gapP50: number | null; dbqMax: number | null }> };
    }>;
    compare?: { warnings: Array<{ key: string; mode: string; message: string }> };
  };
  const failures: string[] = [];
  if (report.meta.schema !== 3) failures.push(`meta.schema=${report.meta.schema}, expected 3`);
  if (report.meta.entryQuietMs !== 500) failures.push(`meta.entryQuietMs=${report.meta.entryQuietMs}, expected 500`);

  const warm = report.scenarios.filter((scenario) => scenario.mode === "warm" && scenario.rounds.length > 0);
  const cold = report.scenarios.filter((scenario) => scenario.mode === "cold" && scenario.rounds.length > 0);
  if (warm.length === 0) failures.push("no measured warm scenario");
  if (cold.length === 0) failures.push("no measured cold scenario");
  for (const scenario of warm) {
    for (const round of scenario.rounds) {
      if (!(round.navStartMs > 0)) failures.push(`${scenario.key} warm round ${round.clickT}: navStartMs=${round.navStartMs} must be > 0`);
      if (round.firstRealMs !== null && round.firstRealMs > round.navStartMs) {
        // Not a proof of correctness by itself, but a warm round whose first
        // content timestamp is still on the entry page's clock is the bug.
        failures.push(`${scenario.key} warm: firstRealMs=${round.firstRealMs} > navStartMs=${round.navStartMs} (not re-based)`);
      }
      if (round.apiFirstScreenEntries.length === 0) {
        failures.push(`${scenario.key} warm round ${round.clickT}: empty apiFirstScreenEntries`);
      }
      if (round.apiFirstScreen !== round.apiFirstScreenEntries.length) {
        failures.push(`${scenario.key} warm: apiFirstScreen=${round.apiFirstScreen} != entries=${round.apiFirstScreenEntries.length}`);
      }
      if (round.apiFirstScreenEntries.some((entry) => entry.startMs < round.navStartMs)) {
        failures.push(`${scenario.key} warm: an entry starts before navStartMs (lower bound broken)`);
      }
      if (round.entrySettled === null) failures.push(`${scenario.key} warm: entrySettled is null (the quiet rule is on by default)`);
      if (round.entryInflightAtClick === null) failures.push(`${scenario.key} warm: entryInflightAtClick is null`);
    }
  }
  for (const scenario of [...cold, ...warm]) {
    const byPath = scenario.stats.apiByPath;
    if (!Array.isArray(byPath) || byPath.length === 0) failures.push(`${scenario.key} ${scenario.mode}: stats.apiByPath is empty`);
    const counted = byPath.reduce((sum, row) => sum + row.count, 0);
    const expected = scenario.rounds.reduce((sum, round) => sum + round.apiFirstScreen, 0);
    if (counted !== expected) failures.push(`${scenario.key} ${scenario.mode}: apiByPath count ${counted} != sum of apiFirstScreen ${expected}`);
  }
  for (const scenario of cold) {
    for (const round of scenario.rounds) {
      if (round.navStartMs !== 0) failures.push(`${scenario.key} cold: navStartMs=${round.navStartMs}, expected 0`);
    }
  }

  process.stdout.write(`\nartifacts: ${artifacts.join(", ")}\n`);
  process.stdout.write(
    `schema=${report.meta.schema} warm scenarios=${warm.length} cold scenarios=${cold.length} `
    + `warm rounds=${warm.reduce((sum, scenario) => sum + scenario.rounds.length, 0)}\n`,
  );
  for (const scenario of report.scenarios.slice(0, 8)) {
    process.stdout.write(
      `  ${scenario.key.padEnd(18)} ${scenario.mode.padEnd(4)} `
      + `navStart=${scenario.rounds[0]?.navStartMs ?? "-"} ready=${scenario.rounds[0]?.readyMs ?? "-"} `
      + `entries=${scenario.rounds[0]?.apiFirstScreenEntries.length ?? 0} paths=${scenario.stats.apiByPath.length}\n`,
    );
  }
  if (report.compare) {
    const warmWarnings = report.compare.warnings.filter((warning) => warning.message.includes("时基"));
    process.stdout.write(`compare warnings=${report.compare.warnings.length} (time-base=${warmWarnings.length})\n`);
    for (const warning of warmWarnings) process.stdout.write(`  time-base warning: ${warning.key} (${warning.mode})\n`);
  }

  // No credential may end up in an artifact: the probe's own guarantee, checked
  // here the same way the MUL-384 harness checks it.
  const leaks: string[] = [];
  for (const file of artifacts) {
    const body = readFileSync(join(OUT_DIR, file), "utf8");
    if (body.includes(token)) leaks.push(`${file}: token`);
    if (body.includes("multimira_token")) leaks.push(`${file}: token key`);
  }
  if (leaks.length > 0) failures.push(`TOKEN LEAK: ${leaks.join("; ")}`);

  if (failures.length > 0) {
    process.stderr.write(`\nS9-0 CHECKS FAILED (${failures.length}):\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    exitCode = 1;
  } else {
    process.stdout.write("S9-0 checks passed: schema 3, warm re-based on the click, per-request table and apiByPath populated, no token leak.\n");
  }
} finally {
  web.kill();
  apiServer.stop(true);
  database.close();
}
process.exit(exitCode);
