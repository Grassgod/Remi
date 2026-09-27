/**
 * MUL-398 A2 CLI byte comparison.
 *
 * Starts the real API on a loopback port against a real PostgreSQL, then runs
 * the real `remi` CLI as a subprocess for both renderings of the summary route.
 * Run this from two checkouts (before = A's head, after = this branch) with the
 * same fixture, then `cmp` the captured stdout/stderr pairs.
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://… \
 *     bun run tests/manual/bench-repository-wikis-a2-cli.ts --label after --out /tmp/mul398a2/cli
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { seedRepositoryWikisBridgeFixture } from "../fixtures/multiremi/repository-wikis-bridge-fixture.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const label = args[args.indexOf("--label") + 1] ?? "after";
const outDir = args[args.indexOf("--out") + 1] ?? "/tmp/mul398a2/cli";
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL?.trim() ?? "";
if (!adminUrl) throw new Error("MULTIREMI_TEST_POSTGRES_URL is required");

const dbName = `multiremi_mul398_cli_${Date.now()}`;
const admin = new Bun.SQL(adminUrl, { max: 1 });
await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${dbName}`);
await admin.end();
const url = new URL(adminUrl);
url.pathname = `/${dbName}`;
const { PostgresSyncDatabase } = await import("../../packages/server/src/store/db/postgres.js");
const raw = new PostgresSyncDatabase(url.toString());
const store = new MultiremiStore(raw);
seedRepositoryWikisBridgeFixture(store, {
  run: (sql, params) => raw.run(sql, ...params),
  pages: 146, runs: 130, scheduleOnlyRuns: 48, compilationRuns: 133,
});

const authToken = "root-secret";
const app = createMultiremiApp({ store, authToken, backgroundJobs: false });
const server = Bun.serve({
  port: 0,
  fetch: (request) => app.fetch(request),
});
const baseUrl = `http://127.0.0.1:${server.port}`;
mkdirSync(outDir, { recursive: true });

const commands: Array<{ name: string; argv: string[] }> = [
  { name: "table", argv: ["wiki", "repository", "list"] },
  { name: "json", argv: ["wiki", "repository", "list", "--output", "json"] },
];
const results: Record<string, unknown> = {};
for (const command of commands) {
  const startedAt = performance.now();
  // Must be async: this process *is* the server, so blocking the event loop while
  // waiting for the child would deadlock its own HTTP requests.
  const proc = Bun.spawn(["bun", "run", "apps/remi/main.ts", ...command.argv], {
    cwd: REPO_ROOT,
    env: { ...process.env, MULTIREMI_SERVER_URL: baseUrl, MULTIREMI_TOKEN: authToken, MULTIREMI_WORKSPACE_ID: "local" },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    new Response(proc.stderr).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
  ]);
  const exitCode = await proc.exited;
  writeFileSync(`${outDir}/${label}-${command.name}.stdout`, stdout);
  writeFileSync(`${outDir}/${label}-${command.name}.stderr`, stderr);
  const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  results[command.name] = {
    argv: command.argv, status: exitCode,
    stdoutBytes: stdout.length, stderrBytes: stderr.length,
    stdoutSha256: sha(stdout), stderrSha256: sha(stderr),
    ms: Number((performance.now() - startedAt).toFixed(1)),
  };
  console.log(`${command.name}: exit=${exitCode} stdout=${stdout.length}B sha=${sha(stdout).slice(0, 16)}… stderr=${stderr.length}B`);
}
writeFileSync(`${outDir}/${label}-summary.json`, `${JSON.stringify({ label, commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim(), commands: results }, null, 2)}\n`);
server.stop(true);
raw.close();
const cleanup = new Bun.SQL(adminUrl, { max: 1 });
await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await cleanup.end();
