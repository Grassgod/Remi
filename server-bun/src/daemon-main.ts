/**
 * Bun daemon entrypoint. Run on the machine that should execute agents:
 *   RUNTIME_ID=<uuid> DATABASE_URL=... bun run src/daemon-main.ts
 * Polls the task queue for its runtime and runs each claimed task through the
 * unified ACP provider (the executor writes results back). While running it
 * owns the runtime row's presence: online + heartbeat on a 30s cadence,
 * offline again on shutdown.
 */

import { hostname } from "node:os";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./db/client.js";
import { agentRuntime } from "./db/schema.js";
import { AcpProvider } from "./agent/acp/index.js";
import { runDaemonLoop } from "./agent/daemon.js";
import { createLogger } from "./logger.js";

const log = createLogger("daemon");
const dbUrl = process.env.DATABASE_URL;
const runtimeId = process.env.RUNTIME_ID;

if (!dbUrl) {
  log.error("DATABASE_URL is required");
  process.exit(1);
}
if (!runtimeId) {
  log.error("RUNTIME_ID is required");
  process.exit(1);
}

const { db, close } = createDb(dbUrl);

/**
 * Source-built daemons report a git-describe-shaped cli_version — the shared
 * frontend/server signal that exempts dev builds from the quick-create
 * version gate (packages/core/runtimes/cli-version.ts).
 */
function describeVersion(): string {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: import.meta.dir });
    const hash = r.success ? r.stdout.toString().trim() : "";
    if (/^[0-9a-f]+$/i.test(hash) && hash.length >= 7) return `v0.2.20-1-g${hash}`;
  } catch {
    /* fall through */
  }
  return "v0.2.20-1-g0000000";
}

async function markOnline(): Promise<void> {
  await db
    .update(agentRuntime)
    .set({
      status: "online",
      lastSeenAt: sql`now()`,
      deviceInfo: hostname(),
      metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ cli_version: describeVersion(), daemon: "bun" })}::jsonb`,
    })
    .where(eq(agentRuntime.id, runtimeId!));
}

async function heartbeat(): Promise<void> {
  await db
    .update(agentRuntime)
    .set({ status: "online", lastSeenAt: sql`now()` })
    .where(eq(agentRuntime.id, runtimeId!));
}

async function markOffline(): Promise<void> {
  await db
    .update(agentRuntime)
    .set({ status: "offline", lastSeenAt: sql`now()` })
    .where(eq(agentRuntime.id, runtimeId!));
}

const provider = new AcpProvider();
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

const [rt] = await db.select().from(agentRuntime).where(eq(agentRuntime.id, runtimeId));
if (!rt) {
  log.error(`runtime ${runtimeId} not found in DB`);
  await close();
  process.exit(1);
}

await markOnline();
const beat = setInterval(() => void heartbeat().catch(() => {}), 30_000);

log.info(`daemon online for runtime ${runtimeId} (${rt.name}, provider ${rt.provider})`);
try {
  await runDaemonLoop(db, provider, runtimeId, { signal: controller.signal });
} finally {
  clearInterval(beat);
  await markOffline().catch(() => {});
  await close().catch(() => {});
}
log.info("daemon stopped");
