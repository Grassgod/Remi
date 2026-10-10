import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReports, validatePlan, discoverTests, verifyConfig, type Plan, type Report } from "./ci-backend.js";
import { runTests } from "./run-tests.js";

const WORKFLOW = ".github/workflows/release-build-check.yml";
const RETRY_TEST = "tests/unit/scripts/retry-failed-backend-tests.test.ts";
const RETRY_ONLY_FILES = new Set([WORKFLOW, "scripts/retry-failed-backend-tests.ts", RETRY_TEST, "TESTING.md"]);

export function failedBackendFiles(raw: string): string[] {
  const log = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const pass = /(?:^|\n)\s*(\d+) pass\s*(?:\n|$)/.exec(log);
  const skip = /(?:^|\n)\s*(\d+) skip\s*(?:\n|$)/.exec(log);
  const fail = /(?:^|\n)\s*(\d+) fail\s*(?:\n|$)/.exec(log);
  const total = /Ran (\d+) tests? across (\d+) files?\./.exec(log);
  if (!pass || !fail || !total || Number(pass[1]) < 1 || Number(fail[1]) < 1
    || Number(pass[1]) + Number(skip?.[1] ?? 0) + Number(fail[1]) !== Number(total[1])) {
    throw new Error("Baseline backend suite did not finish with a complete test summary");
  }
  const files = new Set<string>();
  let file = "", failures = 0;
  // The final failure summary repeats names without their source file.
  for (const line of log.split(/\r?\n/)) {
    if (/^\d+ tests? failed:$/.test(line.trim())) break;
    const heading = /^(?:##\[group\])?(tests\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?):$/.exec(line.trim());
    if (heading) file = heading[1];
    if (line.startsWith("(fail) ")) {
      if (!file || file.includes("..")) throw new Error("Cannot associate a failed test with a safe test file");
      files.add(file); failures++;
    }
  }
  if (failures !== Number(fail[1]) || !files.size) throw new Error("Failed test inventory does not match the complete summary");
  if (!log.includes("[test-home] residual paths: []")) throw new Error("Baseline test HOME cleanup was not verified");
  return [...files].sort();
}

export function verifyRetryChanges(changed: string[]): void {
  const unsupported = changed.filter(path => !RETRY_ONLY_FILES.has(path));
  if (unsupported.length) throw new Error(`Passed backend source or tests changed: ${unsupported.join(", ")}`);
}

async function output(command: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new Error(`${command} failed (${code}): ${stderr}`);
  return stdout;
}

interface BaselineJob { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }
export function verifyShardedJobs(plan: Plan, reports: Report[], jobs: BaselineJob[]): string[] {
  verifyReports(plan, reports, "completed-test-failure");
  const required = ["guards", "frontend-types", "frontend-tests", "cli-build", "api-build", "web-build", "session-archive-platform (ubuntu-latest)", "session-archive-platform (macos-latest)", "frontend-zero-jump", "frontend-replica", "backend-plan", "backend-evidence", "backend-retry", "build", ...plan.shards.map(s => `backend (${s.index})`)];
  if (new Set(jobs.map(job => job.name)).size !== jobs.length || required.some(name => !jobs.some(job => job.name === name))) throw new Error("Missing or duplicate baseline jobs");
  const get = (name: string) => jobs.find(job => job.name === name)!;
  for (const job of jobs) {
    let expected = "success";
    if (["backend-evidence", "backend-retry", "candidate-package"].includes(job.name)) expected = "skipped";
    if (job.name === "build") expected = "failure";
    const shard = /^backend \((\d+)\)$/.exec(job.name);
    if (shard) {
      const report = reports.find(r => r.shard === Number(shard[1]));
      if (!report) throw new Error("Unexpected baseline shard job");
      expected = report.shardExitCode === 0 ? "success" : "failure";
      const step = job.steps?.find(step => step.name === "Backend test shard");
      if (step?.conclusion !== expected || job.steps?.some(step => step.name !== "Backend test shard" && step.conclusion !== "success"
        && !(step.conclusion === "skipped" && ["Post Run oven-sh/setup-bun@v2", "Post Run actions/checkout@v4"].includes(step.name)))) throw new Error("Backend job failed outside completed tests");
    }
    if (job.conclusion !== expected) throw new Error(`Unsafe baseline job: ${job.name} (${job.conclusion})`);
  }
  const failedSteps = get("build").steps?.filter(step => step.conclusion === "failure");
  if (failedSteps?.length !== 1 || failedSteps[0].name !== "Require every applicable check") throw new Error("Unexpected baseline summary failure");
  const files = reports.flatMap(report => report.files.filter(file => file.failures > 0).map(file => file.path)).sort();
  if (!files.length) throw new Error("Baseline does not contain test failures");
  return files;
}
async function paginated(endpoint: string, field: string): Promise<any[]> {
  const pages = JSON.parse(await output("gh", ["api", "--paginate", "--slurp", endpoint]));
  return pages.flatMap((page: any) => page[field]);
}
async function shardedFailedFiles(api: string, runId: string, repo: string, sha: string, jobs: BaselineJob[]): Promise<{ files: string[]; evidence: unknown }> {
  const artifacts = await paginated(`${api}/artifacts?per_page=100`, "artifacts");
  const directory = mkdtempSync(join(tmpdir(), "remi-retry-baseline-"));
  try {
    const download = async (name: string) => {
      const matches = artifacts.filter(artifact => artifact.name === name);
      if (matches.length !== 1 || matches[0].expired) throw new Error(`Missing or expired trusted artifact: ${name}`);
      await output("gh", ["run", "download", runId, "--repo", repo, "--name", name, "--dir", directory]);
    };
    await download("backend-plan");
    if (!lstatSync(join(directory, "plan.json")).isFile()) throw new Error("Invalid plan artifact");
    const plan: Plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
    validatePlan(plan); verifyConfig(plan);
    if (plan.sha !== sha || JSON.stringify(discoverTests(process.cwd(), plan.scope)) !== JSON.stringify(plan.files)) throw new Error("Baseline plan differs from unchanged test inventory");
    for (const shard of plan.shards) await download(`backend-shard-${shard.index}`);
    const reports: Report[] = plan.shards.map(shard => {
      const path = join(directory, `shard-${shard.index}.json`);
      if (!lstatSync(path).isFile()) throw new Error("Invalid shard artifact");
      return JSON.parse(readFileSync(path, "utf8"));
    });
    if (readdirSync(directory).length !== plan.shards.length + 1) throw new Error("Unexpected baseline artifact files");
    const files = verifyShardedJobs(plan, reports, jobs);
    return { files, evidence: { mode: "completed-sharded-test-failure", plan, reports, artifacts: artifacts.filter(a => a.name === "backend-plan" || /^backend-shard-\d+$/.test(a.name)).map(a => ({ id: a.id, name: a.name, digest: a.digest })) } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function verifiedBackendRetry(runId: string): Promise<number> {
  if (!/^\d+$/.test(runId)) throw new Error("A completed full CI run ID is required");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is required");
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Selective retry is only allowed in a manual workflow on main");
  }
  const api = `repos/${repo}/actions/runs/${runId}`;
  const run = JSON.parse(await output("gh", ["api", api]));
  if (run.status !== "completed" || run.conclusion !== "failure" || run.head_branch !== "main"
    || !["push", "workflow_dispatch"].includes(run.event) || run.path !== WORKFLOW
    || !/^[a-f0-9]{40}$/.test(run.head_sha) || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) throw new Error("Baseline must be a failed, completed release check on main");
  const workflow = await output("git", ["show", `${run.head_sha}:${WORKFLOW}`]);
  const sharded = workflow.includes("scripts/ci-backend.ts run --plan") && workflow.includes("scripts/ci-backend.ts verify --plan");
  // A retry cannot be used as another retry's full-suite baseline.
  if (!sharded && !/name: Backend test suite[\s\S]*?\n        run: bun run test\s*\n/.test(workflow)) throw new Error("Baseline workflow must support a complete backend suite");
  await output("git", ["merge-base", "--is-ancestor", run.head_sha, "HEAD"]);
  const changed = (await output("git", ["diff", "--name-only", run.head_sha, "HEAD"])).trim().split("\n").filter(Boolean);
  verifyRetryChanges(changed);
  const jobs = await paginated(`${api}/jobs?filter=latest&per_page=100`, "jobs");
  let files: string[], evidence: unknown;
  if (sharded) {
    const verified = await shardedFailedFiles(api, runId, repo, run.head_sha, jobs);
    files = verified.files; evidence = verified.evidence;
  } else {
  const build = jobs.find((job: any) => job.name === "build");
  const failedSteps = build?.steps.filter((step: any) => step.conclusion === "failure");
  if (build?.conclusion !== "failure" || failedSteps?.length !== 1 || failedSteps[0].name !== "Backend test suite"
    || jobs.some((job: any) => job.name !== "build" && job.conclusion !== "success")) {
    throw new Error("Baseline must fail only its completed backend suite, with other jobs successful");
  }
  const raw = await output("gh", ["run", "view", runId, "--repo", repo, "--job", String(build.id), "--log-failed"]);
  // Keep only the backend step: architecture tests have their own summaries.
  const log = raw.split(/\r?\n/).flatMap(line => {
    const parts = line.split("\t");
    return parts[1] === "Backend test suite" ? [parts.slice(2).join("\t").replace(/^\S+Z /, "")] : [];
  }).join("\n");
  files = failedBackendFiles(log);
  evidence = { mode: "completed-legacy-test-failure", baselineJobId: build.id };
  }
  if (files.some(file => !existsSync(file))) throw new Error("A baseline failed test file is missing");
  const receipt = { schemaVersion: 1, mode: "verified-retry", repository: repo, baselineRunId: runId, baselineSha: run.head_sha, targetSha: process.env.GITHUB_SHA,
    sourceAndExistingTestsUnchanged: true, evidence, failedFiles: files, retryInfrastructureTest: RETRY_TEST };
  mkdirSync("ci-backend", { recursive: true });
  writeFileSync("ci-backend/retry-evidence.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ mode: receipt.mode, baselineRunId: runId, baselineSha: run.head_sha, failedFiles: files, evidencePath: "ci-backend/retry-evidence.json" }));
  // This timeout includes fixture construction; this is not a performance threshold.
  return runTests([...files, RETRY_TEST, "--timeout", "15000"]);
}

if (import.meta.main) {
  process.exitCode = await verifiedBackendRetry(process.argv[2] ?? "");
}
