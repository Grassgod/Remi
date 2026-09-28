import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPr2Harness } from "../fixtures/multiremi/first-screen-hotspots-pr2-fixture.js";

// Run this identical harness on main@7bd32800 and the PR branch, with the
// hermetic preload. Explicit PG configuration is required to work.
const warmups = Number(process.env.MUL473_WARMUPS ?? 5);
const samples = Number(process.env.MUL473_SAMPLES ?? 20);
const outIndex = process.argv.indexOf("--out");
const out = outIndex < 0 ? join(import.meta.dir, "../../reports/performance/MUL-473-pr2.json") : process.argv[outIndex + 1]!;
const harness = await createPr2Harness({ attachmentBytes: 262144 });
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
try {
  const results = [];
  for (const [label, path, extra] of [
    ["inbox summary", "/api/inbox/summary?timezone_offset=480", {}],
    ["attachment cold", `/api/attachments/${harness.attachmentId}/content`, {}],
    ["attachment conditional", `/api/attachments/${harness.attachmentId}/content`, { "If-None-Match": `"${harness.attachmentId}"` }],
    ["runtimes", "/api/runtimes", {}],
  ] as Array<[string, string, Record<string, string>]>) {
    const durations: number[] = [], dbTimes: number[] = [];
    let last: Record<string, unknown> = {};
    for (let index = 0; index < warmups + samples; index++) {
      harness.probe.reset();
      const start = performance.now();
      const response = await harness.app.request(path, { headers: { ...harness.headers, ...extra } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const elapsed = performance.now() - start;
      if (![200, 304].includes(response.status)) throw new Error(`${label}: HTTP ${response.status}`);
      if (index < warmups) continue;
      durations.push(elapsed);
      dbTimes.push(harness.probe.ms);
      last = { status: response.status, dbq: harness.probe.statements, dbBytes: harness.probe.bytes,
        responseBytes: bytes.length, responseSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
    }
    const result = { label, ...last, dbMs: percentile(dbTimes, .5), p50Ms: percentile(durations, .5), p95Ms: percentile(durations, .95) };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const report = { database: process.env.MULTIREMI_TEST_POSTGRES_URL ? "postgres" : "sqlite", bun: Bun.version,
    fixture: { sessions: 50, agents: 20, inboxRows: 306, runtimes: 20, foreignRuntimes: 30, attachmentBytes: 262144 },
    bytesMethod: "nonempty rows: UTF-8 JSON.stringify({ rows, count }); empty replies excluded",
    warmups, samples, results };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
} finally { await harness.dispose(); }
