import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runTests } from "../../../scripts/run-tests.js";
import { expect, test } from "bun:test";
import { createPlan, discoverTests, verifyReports, BackendLogParser, type Report } from "../../../scripts/ci-backend.js";

test("LPT schedules all files deterministically and gives unknown files conservative weight", () => {
  const plan = createPlan(["a.test.ts", "b.test.ts", "new.test.ts"], 2, { "a.test.ts": 100, "b.test.ts": 10 }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "tests", [], {});
  expect(plan.defaultSeconds).toBe(100);
  expect(plan.shards.flatMap(s => s.files).sort()).toEqual(plan.files);
  expect(plan.shards.map(s => s.estimatedSeconds)).toEqual([110, 100]);
});

test("coverage fails closed for missing, duplicate, failed, foreign and incomplete reports", () => {
  const plan = createPlan(["a.test.ts", "b.test.ts"], 2, {}, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "tests", [], {});
  const reports: Report[] = plan.shards.map(s => ({ schemaVersion: 1, sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", scope: "tests", shard: s.index, startedAt: "start", finishedAt: "end", shardExitCode: 0, runner: { childExitCode: 0, homeEmpty: true, observerFailed: false, interrupted: false }, summary: { pass: s.files.length, skip: 0, fail: 0, tests: s.files.length, files: s.files.length }, files: s.files.map(path => ({ path, seconds: 1, failures: 0 })) }));
  expect(() => verifyReports(plan, reports)).not.toThrow();
  expect(() => verifyReports(plan, reports.slice(1))).toThrow();
  expect(() => verifyReports(plan, [reports[0], reports[0]])).toThrow();
  for (const change of [ { sha: "foreign" }, { finishedAt: undefined }, { files: [] }, { files: [{ path: "a.test.ts", seconds: 1, failures: 1 }] } ]) {
    expect(() => verifyReports(plan, [{ ...reports[0], ...change }, reports[1]])).toThrow();
  }
});


test("discovery includes Bun suffixes/extensions and hidden basenames but excludes hidden and dependency trees", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-discovery-"));
  try {
    mkdirSync(join(root, "tests", ".hidden"), { recursive: true });
    mkdirSync(join(root, "tests", "node_modules"));
    for (const name of ["one_test.mjs", "two.spec.cts", "three.test.tsx", ".hidden.test.ts", "manual.ts", ".hidden/four.test.ts", "node_modules/five.test.ts"]) writeFileSync(join(root, "tests", name), "");
    expect(discoverTests(root, "tests")).toEqual(["tests/.hidden.test.ts", "tests/one_test.mjs", "tests/three.test.tsx", "tests/two.spec.cts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("completed failure mode retains exact coverage without accepting HOME writes or interruption", () => {
  const sha = "a".repeat(40);
  const plan = createPlan(["tests/a.test.ts"], 1, {}, sha, "tests", [], {});
  const report: Report = { schemaVersion: 1, sha, scope: "tests", shard: 0, startedAt: "start", finishedAt: "end", shardExitCode: 1, runner: { childExitCode: 1, homeEmpty: true, observerFailed: false, interrupted: false }, summary: { pass: 1, skip: 0, fail: 1, tests: 2, files: 1 }, files: [{ path: "tests/a.test.ts", seconds: 1, failures: 1 }] };
  expect(() => verifyReports(plan, [report], "completed-test-failure")).not.toThrow();
  expect(() => verifyReports(plan, [report])).toThrow();
  for (const changes of [{ homeEmpty: false }, { interrupted: true }, { observerFailed: true }, { childExitCode: 143 }]) {
    expect(() => verifyReports(plan, [{ ...report, runner: { ...report.runner!, ...changes } }], "completed-test-failure")).toThrow();
  }
  expect(() => verifyReports(plan, [{ ...report, summary: { ...report.summary!, fail: 2, tests: 3 } }], "completed-test-failure")).toThrow();
});

test("stream parser separates chunks and nested summaries from outer failures and final duplicate list", () => {
  const report: Report = { schemaVersion: 1, sha: "a".repeat(40), shard: 0, scope: "tests", startedAt: "start", files: [] };
  const parser = new BackendLogParser(["tests/parent.test.ts", "tests/next.test.ts"], report, () => 1000);
  parser.feed("tests/par", "stderr");
  parser.feed('REMI_TEST_DB_FIXTURE_STATS {"fixture":"sample"}\n', "stdout");
  parser.feed("ent.test.ts:\nchild/fixture.test.ts:\n(fail) nested failure\n1 test failed:\n(fail) nested failure\n1 pass\n7 skip\n1 fail\nRan 9 tests across 1 file.\n(fail) parent failure\ntests/next.test.ts:\n(fail) next failure\n2 tests failed:\n(fail) parent failure\n(fail) next failure\n1 pass\n2 fail\nRan 3 tests across 2 files.\n", "stderr");
  parser.finish();
  expect(report.files.map(file => [file.path, file.failures])).toEqual([["tests/parent.test.ts", 1], ["tests/next.test.ts", 1]]);
  expect(report.summary).toEqual({ pass: 1, skip: 0, fail: 2, tests: 3, files: 2 });
  expect(report.fixtureStats).toEqual([{ fixture: "sample" }]);
});

test("stream parser accepts singular totals and fails missing or duplicate actual inventory", () => {
  const report: Report = { schemaVersion: 1, sha: "a".repeat(40), shard: 0, scope: "tests", startedAt: "start", files: [] };
  const parser = new BackendLogParser(["tests/one.test.ts"], report, () => 1000);
  parser.feed("tests/one.test.ts:\n1 pass\n0 fail\nRan 1 test across 1 file.", "stderr");
  parser.finish();
  expect(report.summary).toEqual({ pass: 1, skip: 0, fail: 0, tests: 1, files: 1 });
  const duplicate: Report = { ...report, files: [] };
  const repeated = new BackendLogParser(["tests/one.test.ts"], duplicate);
  repeated.feed("tests/one.test.ts:\ntests/one.test.ts:\n", "stderr");
  repeated.finish();
  expect(duplicate.logErrors).toEqual(["Duplicate file heading: tests/one.test.ts"]);
});


test("live GitHub Actions runner groups establish complete coverage only from stderr", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-github-live-"));
  const file = join(directory, "tiny.test.ts");
  const assigned = relative(process.cwd(), file).replaceAll("\\", "/");
  const previous = { CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  try {
    process.env.CI = "true";
    process.env.GITHUB_ACTIONS = "true";
    writeFileSync(file, String.raw`import { test, expect } from "bun:test";
console.log("stdout-decoy.test.ts:\n99 pass\n0 fail\nRan 99 tests across 1 file.");
test("live tiny", () => expect(1).toBe(1));
`);
    const sha = "a".repeat(40);
    const plan = createPlan([assigned], 1, {}, sha, "tests", [], {});
    const report: Report = { schemaVersion: 1, sha, shard: 0, scope: "tests", startedAt: "start", files: [] };
    const parser = new BackendLogParser([assigned], report);
    const streams = { stdout: "", stderr: "" };
    report.shardExitCode = await runTests([file], (chunk, source) => {
      streams[source] += chunk;
      parser.feed(chunk, source);
    }, metadata => { report.runner = metadata; });
    parser.finish();
    report.finishedAt = "end";
    expect(streams.stderr).toContain(`::group::${assigned}:`);
    expect(streams.stdout).toContain("stdout-decoy.test.ts:");
    expect(report.shardExitCode).toBe(0);
    expect(report.files.map(entry => entry.path)).toEqual([assigned]);
    expect(report.summary).toEqual({ pass: 1, skip: 0, fail: 0, tests: 1, files: 1 });
    expect(() => verifyReports(plan, [report])).not.toThrow();
  } finally {
    for (const key of ["CI", "GITHUB_ACTIONS"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
