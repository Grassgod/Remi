import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { percentile } from "../../packages/server/src/observability/request-metrics.js";

const baseline = process.env.MUL398_C1_BASELINE_ROOT;
const outIndex = process.argv.indexOf("--out");
const out = process.argv[outIndex + 1];
if (!baseline || outIndex < 0 || !out || !process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("Baseline, local PG and --out required");
const root = resolve(import.meta.dir, "../..");
const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Only loopback PG is allowed");
const samples = 31;
const warmups = 3;

async function spawnWorker(directory: string, stage: string) {
  const env: Record<string, string | undefined> = { ...process.env, MUL398_C1_STAGE: stage };
  delete env.MULTIREMI_TOKEN;
  delete env.MULTIREMI_PG_REPLY_MAX_BYTES;
  const child = Bun.spawn(["bun", "run", "tests/manual/bench-pg-reply-c1-preflight.ts", "--worker"], {
    cwd: directory, env, stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const chunks = async function* () {
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        yield chunk.value;
      }
    } finally { reader.releaseLock(); }
  };
  const lines = createInterface({ input: (await import("node:stream")).Readable.from(chunks()) });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !JSON.parse(first.value).ready) throw new Error(`${stage} worker did not start`);
  return {
    async command(command: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      await child.stdin.flush();
      const line = await iterator.next();
      if (line.done) throw new Error(`${stage} worker exited early`);
      return JSON.parse(line.value);
    },
    async close() {
      if (child.exitCode === null) {
        child.stdin.write('{"kind":"stop"}\n');
        await child.stdin.flush(); child.stdin.end();
      }
      const code = await child.exited;
      if (code !== 0) throw new Error(`${stage} worker exit ${code}`);
    },
  };
}

const before = await spawnWorker(baseline, "before");
const after = await spawnWorker(root, "after");
const result: Record<string, unknown> = { baselineSha: "b95dd2fa", samples, warmups,
  fixture: { batchSizes: [1, 10, 50], contentBytes: 1024, longMessageCount: 96, longMessageBytes: 256 * 1024,
    queuedRuns: 20, queuedPromptBytes: 512 * 1024 } };
try {
  const measurements: unknown[] = [];
  for (const kind of ["daemon", "peer", "peer-http"]) {
    for (const count of [1, 10, 50]) {
      const pairs: Array<{ before: any; after: any }> = [];
      for (let index = 0; index < warmups + samples; index++) {
        const pair: Record<string, any> = {};
        for (const stage of (index % 2 ? ["after", "before"] : ["before", "after"])) {
          pair[stage] = await (stage === "before" ? before : after).command({ kind, count, index });
        }
        if (index >= warmups) pairs.push(pair as { before: any; after: any });
      }
      const stats = (stage: "before" | "after") => ({
        queries: [...new Set(pairs.map(pair => pair[stage].queries))],
        pageRows: [...new Set(pairs.map(pair => pair[stage].rows).filter(Boolean))],
        origin: pairs[0]![stage].origin,
        p50Ms: percentile(pairs.map(pair => pair[stage].ms), .5),
        p95Ms: percentile(pairs.map(pair => pair[stage].ms), .95),
      });
      const summary = { kind, count, before: stats("before"), after: stats("after"),
        pairedExtraP95Ms: percentile(pairs.map(pair => pair.after.ms - pair.before.ms), .95) };
      measurements.push({ ...summary, pairs });
      console.log(JSON.stringify(summary));
    }
  }
  result.measurements = measurements;
  result.long = { before: await before.command({ kind: "long" }), after: await after.command({ kind: "long" }) };
  result.reject = { before: await before.command({ kind: "reject" }), after: await after.command({ kind: "reject" }) };
  result.queued = { before: await before.command({ kind: "queued" }), after: await after.command({ kind: "queued" }) };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ long: result.long, reject: result.reject, queued: result.queued }));
} finally {
  const closed = await Promise.allSettled([before.close(), after.close()]);
  for (const status of closed) if (status.status === "rejected") console.error(String(status.reason));
}
