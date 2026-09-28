import "../setup/hermetic-env.js";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createStatusPagesHarness, STATUS_PAGE_STATUSES } from "../fixtures/multiremi/issue-status-pages-fixture.js";

const backend = process.env.MULTIREMI_TEST_POSTGRES_URL ? "postgres" : "sqlite";
const out = process.argv[2] ?? `reports/performance/MUL-395-s9-3a-${backend}-2026-09-28.json`;
const h = await createStatusPagesHarness(process.env.MULTIREMI_TEST_POSTGRES_URL);
function headerNumber(header: string | null, name: string, attribute: string) {
  const item = header?.split(",").find((part) => part.trim().startsWith(`${name};`));
  const match = item?.match(new RegExp(`${attribute}="?([\\d.]+)`));
  return match ? Number(match[1]) : undefined;
}
function metrics(result: Awaited<ReturnType<typeof h.request>>) {
  if (result.status !== 200) throw new Error(`HTTP ${result.status}`);
  return {
    dbq: backend === "postgres" ? headerNumber(result.timing, "dbq", "desc")! : result.dbq,
    dbMs: backend === "postgres" ? headerNumber(result.timing, "db", "dur")! : result.dbMs,
    dbBytes: backend === "postgres" ? headerNumber(result.timing, "dbb", "desc")! : result.dbBytes,
    responseBytes: result.responseBytes,
  };
}
type Metrics = ReturnType<typeof metrics>;
const sum = (values: Metrics[]): Metrics => Object.fromEntries(
  ["dbq", "dbMs", "dbBytes", "responseBytes"].map((key) => [key, values.reduce((total, value) => total + value[key as keyof Metrics], 0)]),
) as Metrics;
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; }
const summarize = (values: Metrics[]): Metrics => Object.fromEntries(
  ["dbq", "dbMs", "dbBytes", "responseBytes"].map((key) => [key, median(values.map((value) => value[key as keyof Metrics]))]),
) as Metrics;
try {
  const scenarios = [];
  for (const [name, filter] of [
    ["issues", "&project_id=prj_status_primary"],
    ["my-issues", `&project_id=prj_status_primary&assignee_id=${h.userId}`],
  ]) {
    const rounds: Array<Record<"singles" | "singlesWithArchive" | "grouped" | "groupedWithArchive" | "oneStatus", Metrics>> = [];
    for (let round = 0; round < 6; round++) {
      const singles = [];
      for (const status of STATUS_PAGE_STATUSES) singles.push(metrics(await h.request(`/api/issues?status=${status}&limit=50&offset=0${filter}`)));
      const archive = metrics(await h.request("/api/issues?archived_only=true&limit=0"));
      const grouped = metrics(await h.request(`/api/issues/status-pages?statuses=${STATUS_PAGE_STATUSES.join(",")}&limit=50${filter}`));
      const groupedWithArchive = metrics(await h.request(`/api/issues/status-pages?statuses=${STATUS_PAGE_STATUSES.join(",")}&limit=50&include_archived_total=true${filter}`));
      if (round > 0) rounds.push({ singles: sum(singles), singlesWithArchive: sum([...singles, archive]), grouped, groupedWithArchive, oneStatus: singles[0]! });
    }
    scenarios.push({ name, samples: rounds, median: Object.fromEntries(
      ["singles", "singlesWithArchive", "grouped", "groupedWithArchive", "oneStatus"].map((key) => [key, summarize(rounds.map((round) => round[key as keyof typeof round]))]),
    ) });
  }
  const dbqMatrix = [];
  for (const count of [1, 60, 300]) for (const width of [1, 4, 7]) {
    const result = await h.request(`/api/issues/status-pages?statuses=${STATUS_PAGE_STATUSES.slice(0, width).join(",")}&project_id=prj_status_scale${count}&limit=50&include_archived_total=true`);
    dbqMatrix.push({ statuses: width, issuesPerStatus: count, ...metrics(result) });
  }
  const report = { backend, measuredAt: new Date().toISOString(), rounds: 5, warmup: 1,
    measurement: backend === "postgres" ? "Server-Timing: includes transaction control and authentication" : "Executed statements (includes BEGIN/COMMIT), driver elapsed time and serialized result bytes",
    fixture: "Primary project: 120 issues per status, 7 statuses; list limit 50; archived total 21", scenarios, dbqMatrix };
  await mkdir(dirname(out), { recursive: true });
  await Bun.write(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ backend, scenarios: scenarios.map(({ name, median }) => ({ name, median })), dbq: dbqMatrix.map(({ dbq }) => dbq) }, null, 2));
} finally { await h.close(); }
