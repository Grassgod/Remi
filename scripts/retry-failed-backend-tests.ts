import { existsSync } from "node:fs";
import { runTests } from "./run-tests.js";

const WORKFLOW = ".github/workflows/release-build-check.yml";
const RETRY_TEST = "tests/unit/scripts/retry-failed-backend-tests.test.ts";
const RETRY_ONLY_FILES = new Set([WORKFLOW, "scripts/retry-failed-backend-tests.ts", RETRY_TEST, "TESTING.md"]);

export function failedBackendFiles(raw: string): string[] {
  const log = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const pass = /(?:^|\n)\s*(\d+) pass\s*(?:\n|$)/.exec(log);
  const skip = /(?:^|\n)\s*(\d+) skip\s*(?:\n|$)/.exec(log);
  const fail = /(?:^|\n)\s*(\d+) fail\s*(?:\n|$)/.exec(log);
  const total = /Ran (\d+) tests across (\d+) files?\./.exec(log);
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
    || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error("Baseline must be a failed, completed release check on main");
  const workflow = await output("git", ["show", `${run.head_sha}:${WORKFLOW}`]);
  // A retry cannot be used as another retry's full-suite baseline.
  if (!/name: Backend test suite[\s\S]*?\n        run: bun run test\s*\n/.test(workflow)) {
    throw new Error("Baseline workflow must have run the complete backend suite");
  }
  await output("git", ["merge-base", "--is-ancestor", run.head_sha, "HEAD"]);
  const changed = (await output("git", ["diff", "--name-only", run.head_sha, "HEAD"])).trim().split("\n").filter(Boolean);
  verifyRetryChanges(changed);
  const jobs = JSON.parse(await output("gh", ["api", `${api}/jobs?per_page=100`])).jobs;
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
  const files = failedBackendFiles(log);
  if (files.some(file => !existsSync(file))) throw new Error("A baseline failed test file is missing");
  console.log(JSON.stringify({ baselineRunId: runId, baselineSha: run.head_sha,
    sourceAndExistingTestsUnchanged: true, failedFiles: files, retryInfrastructureTest: RETRY_TEST }));
  // This timeout includes fixture construction; this is not a performance threshold.
  return runTests([...files, RETRY_TEST, "--timeout", "15000"]);
}

if (import.meta.main) {
  process.exitCode = await verifiedBackendRetry(process.argv[2] ?? "");
}
