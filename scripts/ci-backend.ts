import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { resolve, relative, join } from "node:path";
import { runTests, type TestRunMetadata } from "./run-tests.js";

export interface Plan {
  schemaVersion: 1; sha: string; scope: string; preload: string[]; configDigest?: string; weightSource: unknown;
  defaultSeconds: number; files: string[];
  shards: { index: number; estimatedSeconds: number; files: string[] }[];
}
export interface Report {
  schemaVersion: 1; sha: string; shard: number; scope: string; startedAt: string; finishedAt?: string;
  files: { path: string; seconds: number; failures: number }[];
  runner?: TestRunMetadata;
  summary?: { pass: number; skip: number; fail: number; tests: number; files: number };
  shardExitCode?: number; logErrors?: string[];
  fixtureStats?: unknown[]; fixtureStatsCoverage?: string;
}
export function discoverTests(root: string, scope: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === "node_modules" || (item.isDirectory() && item.name.startsWith("."))) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && /[._](test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(item.name)) files.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  visit(resolve(root, scope));
  return files.sort();
}
export function createPlan(files: string[], count: number, seconds: Record<string, number>, sha: string, scope: string, preload: string[], weightSource: unknown): Plan {
  if (!Number.isInteger(count) || count < 1 || !files.length || new Set(files).size !== files.length) throw new Error("Invalid shard count or inventory");
  const known = Object.values(seconds).filter(v => Number.isFinite(v) && v > 0).sort((a,b) => a-b);
  // A new file gets at least one minute or the observed p90, whichever is larger.
  const defaultSeconds = Math.max(60, known[Math.floor(known.length * .9)] ?? 60);
  const weight = (file: string) => Number.isFinite(seconds[file]) && seconds[file] > 0 ? seconds[file] : defaultSeconds;
  const shards = Array.from({ length: count }, (_, index) => ({ index, estimatedSeconds: 0, files: [] as string[] }));
  for (const file of [...files].sort((a,b) => weight(b)-weight(a) || a.localeCompare(b))) {
    const shard = [...shards].sort((a,b) => a.estimatedSeconds-b.estimatedSeconds || a.index-b.index)[0];
    shard.files.push(file); shard.estimatedSeconds += weight(file);
  }
  return { schemaVersion: 1, sha, scope, preload, weightSource, defaultSeconds, files, shards };
}
export function validatePlan(plan: Plan): void {
  if (plan.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(plan.sha) || !plan.files.length || !plan.shards.length) throw new Error("Invalid plan identity");
  const assigned = plan.shards.flatMap((shard, index) => {
    if (shard.index !== index || !shard.files.length) throw new Error("Invalid or empty shard");
    return shard.files;
  });
  if (new Set(assigned).size !== assigned.length || JSON.stringify(assigned.sort()) !== JSON.stringify([...plan.files].sort())) throw new Error("Plan coverage mismatch");
}
function currentConfig() {
  const raw = readFileSync("bunfig.toml", "utf8");
  const config = Bun.TOML.parse(raw) as { test?: { root?: string; preload?: string[] } };
  return { scope: config.test?.root ?? ".", preload: config.test?.preload ?? [], digest: createHash("sha256").update(raw).digest("hex") };
}
export function verifyConfig(plan: Plan): void {
  validatePlan(plan);
  const config = currentConfig();
  if (plan.configDigest !== config.digest || plan.scope !== config.scope || JSON.stringify(plan.preload) !== JSON.stringify(config.preload)) throw new Error("Test discovery/preload configuration changed");
}
export function verifyReports(plan: Plan, reports: Report[], mode: "full-success" | "completed-test-failure" = "full-success"): void {
  validatePlan(plan);
  if (reports.length !== plan.shards.length || new Set(reports.map(r => r.shard)).size !== reports.length) throw new Error("Missing or duplicate shard reports");
  const seen: string[] = [];
  for (const report of reports) {
    const shard = plan.shards.find(s => s.index === report.shard);
    if (report.schemaVersion !== 1 || !shard || report.sha !== plan.sha || report.scope !== plan.scope || !report.finishedAt || report.logErrors?.length) throw new Error("Report identity or completion mismatch");
    const summary = report.summary, runner = report.runner;
    if (!summary || !runner || !runner.homeEmpty || runner.observerFailed || runner.interrupted
      || ![0, 1].includes(runner.childExitCode) || report.shardExitCode !== runner.childExitCode
      || !Object.values(summary).every(value => Number.isSafeInteger(value) && value >= 0)
      || summary.pass + summary.skip + summary.fail !== summary.tests || summary.files !== shard.files.length
      || report.files.reduce((sum, file) => sum + file.failures, 0) !== summary.fail
      || (summary.fail > 0 ? runner.childExitCode !== 1 : runner.childExitCode !== 0)
      || (mode === "full-success" && (summary.fail !== 0 || runner.childExitCode !== 0))) throw new Error("Incomplete or unsafe test completion evidence");
    if (JSON.stringify(report.files.map(f => f.path).sort()) !== JSON.stringify([...shard.files].sort())) throw new Error("Shard inventory mismatch");
    for (const file of report.files) {
      if (!Number.isSafeInteger(file.failures) || file.failures < 0 || (mode === "full-success" && file.failures !== 0) || !Number.isFinite(file.seconds) || file.seconds < 0) throw new Error(`Failed or invalid file: ${file.path}`);
      seen.push(file.path);
    }
  }
  if (new Set(seen).size !== seen.length || JSON.stringify(seen.sort()) !== JSON.stringify([...plan.files].sort())) throw new Error("Full suite coverage mismatch");
}
/** Tracks outer-run headings; nested runner transcripts never establish coverage. */
export class BackendLogParser {
  private buffers = { stdout: "", stderr: "" };
  private current = "";
  private start = 0;
  private failures = 0;
  private nested = false;
  private repeated = false;
  private observed = new Set<string>();
  private group: Partial<NonNullable<Report["summary"]>> = { skip: 0 };
  constructor(private assigned: string[], private report: Report, private now = () => performance.now()) {
    report.logErrors = []; report.fixtureStats = [];
  }
  private closeFile() {
    if (this.current) this.report.files.push({ path: this.current, seconds: (this.now()-this.start)/1000, failures: this.failures });
  }
  private line(raw: string, source: "stdout" | "stderr") {
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const stats = /^REMI_TEST_DB_FIXTURE_STATS\s+(.+)$/.exec(clean);
    if (stats) { try { this.report.fixtureStats!.push(JSON.parse(stats[1])); } catch { this.report.logErrors!.push("Invalid fixture stats JSON"); } }
    if (source !== "stderr") return;
    const heading = /^(?:##\[group\])?((?:\.\/)?.+[._](?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)):$/.exec(clean);
    if (heading) {
      const path = heading[1].replace(/^\.\//, "");
      if (!this.assigned.includes(path)) { this.nested = true; return; }
      this.closeFile(); this.current = path; this.start = this.now(); this.failures = 0; this.repeated = false; this.nested = false;
      if (this.observed.has(path)) this.report.logErrors!.push(`Duplicate file heading: ${path}`);
      this.observed.add(path); return;
    }
    if (/^\d+ tests? failed:$/.test(clean) && !this.nested) this.repeated = true;
    const count = /^(\d+) (pass|skip|fail)$/.exec(clean);
    if (count) {
      if (count[2] === "pass") this.group = { pass: Number(count[1]), skip: 0 };
      else this.group[count[2] as "skip" | "fail"] = Number(count[1]);
    }
    const total = /^Ran (\d+) tests? across (\d+) files?\./.exec(clean);
    if (total) {
      if (!this.nested && this.group.pass !== undefined && this.group.fail !== undefined) this.report.summary = { ...this.group, tests: Number(total[1]), files: Number(total[2]) } as NonNullable<Report["summary"]>;
      // The parent emits its own failure after rendering a nested transcript.
      this.nested = false; this.group = { skip: 0 }; return;
    }
    if (!this.nested && !this.repeated && clean.startsWith("(fail) ") && this.current) this.failures++;
  }
  feed(text: string, source: "stdout" | "stderr") {
    this.buffers[source] += text;
    const lines = this.buffers[source].split(/\r?\n/); this.buffers[source] = lines.pop()!;
    for (const line of lines) this.line(line, source);
  }
  finish() {
    for (const source of ["stdout", "stderr"] as const) if (this.buffers[source]) this.line(this.buffers[source], source);
    this.closeFile();
  }
}
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const save = (path: string, value: unknown) => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name: string, fallback?: string): string => { const i = args.indexOf(`--${name}`); const value = i < 0 ? fallback : args[i+1]; if (!value) throw new Error(`Missing --${name}`); return value; };
  if (command === "plan") {
    const config = currentConfig();
    const scope = config.scope;
    const weights = json(option("weights", "scripts/ci-backend-weights.json"));
    const plan = createPlan(discoverTests(process.cwd(), scope), Number(option("shards", "4")), weights.seconds, option("sha"), scope, config.preload, weights.source);
    plan.configDigest = config.digest; validatePlan(plan);
    save(option("out"), plan);
    console.log(JSON.stringify({ files: plan.files.length, estimates: plan.shards.map(s => s.estimatedSeconds), defaultSeconds: plan.defaultSeconds }));
  } else if (command === "run") {
    if (!process.env.MULTIREMI_TEST_POSTGRES_URL) throw new Error("Explicit MULTIREMI_TEST_POSTGRES_URL required");
    if (process.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL !== "1") throw new Error("Lock-order sentinel required");
    const plan: Plan = json(option("plan"));
    verifyConfig(plan);
    if (plan.sha !== process.env.GITHUB_SHA) throw new Error("Plan SHA mismatch");
    if (JSON.stringify(discoverTests(process.cwd(), plan.scope)) !== JSON.stringify(plan.files)) throw new Error("Discovery changed since planning");
    const connection = new SQL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
    try { await connection`SELECT 1`; }
    catch (error) { throw new Error("Explicit test PostgreSQL connection failed", { cause: error }); }
    finally { await connection.close(); }
    const shard = plan.shards.find(s => s.index === Number(option("shard")));
    if (!shard || !shard.files.length) throw new Error("Unknown or empty shard");
    const report: Report = { schemaVersion: 1, sha: plan.sha, scope: plan.scope, shard: shard.index, startedAt: new Date().toISOString(), files: [] };
    report.fixtureStats = []; report.fixtureStatsCoverage = "Only helpers emitting REMI_TEST_DB_FIXTURE_STATS; not a repository-wide database count";
    const out = option("out"); save(out, report);
    const parser = new BackendLogParser(shard.files, report);
    const exitCode = await runTests(shard.files.map(path => `./${path}`), (text, source) => parser.feed(text, source), metadata => { report.runner = metadata; });
    parser.finish();
    report.shardExitCode = exitCode;
    if (exitCode < 128 && !report.logErrors.length && report.files.length === shard.files.length) report.finishedAt = new Date().toISOString();
    save(out, report); process.exitCode = exitCode || (report.finishedAt ? 0 : 1);
  } else if (command === "verify") {
    const plan: Plan = json(option("plan"));
    verifyConfig(plan);
    const directory = option("reports");
    const reports = readdirSync(directory).filter(f => /^shard-\d+\.json$/.test(f)).map(f => json(join(directory, f)) as Report);
    if (plan.sha !== process.env.GITHUB_SHA) throw new Error("Coverage SHA mismatch");
    if (JSON.stringify(discoverTests(process.cwd(), plan.scope)) !== JSON.stringify(plan.files)) throw new Error("Coverage discovery mismatch");
    verifyReports(plan, reports);
    save(option("out"), { schemaVersion: 1, sha: plan.sha, scope: plan.scope, fullSuite: true, files: plan.files.length, plan, reports, totalFileSeconds: reports.flatMap(r => r.files).reduce((sum,f) => sum+f.seconds,0), topFiles: reports.flatMap(r => r.files.map(f => ({ ...f, shard: r.shard }))).sort((a,b) => b.seconds-a.seconds).slice(0,30), shardSeconds: reports.map(r => ({ shard: r.shard, seconds: r.files.reduce((sum,f) => sum+f.seconds,0) })) });
  } else if (command === "weights") {
    const coverage = json(option("coverage"));
    if (!coverage.fullSuite || coverage.sha !== coverage.plan.sha) throw new Error("Complete coverage artifact required");
    verifyReports(coverage.plan, coverage.reports);
    const previous = json(option("previous", "scripts/ci-backend-weights.json"));
    const seconds = { ...previous.seconds };
    for (const report of coverage.reports) for (const file of report.files) seconds[file.path] = file.seconds;
    save(option("out"), { schemaVersion: 1, source: { sha: coverage.sha, runId: option("run-id"), method: "Verified full-suite coverage; file headings to next heading or process exit", previousSource: previous.source }, seconds });
  } else throw new Error("Expected plan, run, verify, or weights");
}
