import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_PACKAGE, RUNTIME_PIN } from "../../../packages/acp/src/runtime-versions.js";
import { checkRelease, checkReleaseSnapshot, latestRuntimeVersions, prepareRelease, SNAPSHOT_PATH, type RuntimeSnapshot } from "../../../scripts/release-runtime.js";

const baseline: RuntimeSnapshot = {
  schema: 1, preparedFor: "0.2.69", checkedAt: "2026-09-13T00:00:00.000Z",
  claude: { acp: "0.76.0", sdk: "0.3.270", executable: "2.1.270" },
  codex: { acp: "1.11.0", sdk: "0.154.0", executable: "0.154.0" },
};
const next = {
  claude: { acp: "0.77.0", sdk: "0.3.271", executable: "2.1.271" },
  codex: { acp: "1.12.0", sdk: "0.155.0", executable: "0.155.0" },
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "remi-release-test-"));
  roots.push(root);
  mkdirSync(dirname(join(root, SNAPSHOT_PATH)), { recursive: true });
  writeFileSync(join(root, SNAPSHOT_PATH), JSON.stringify(baseline));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "remi", version: "0.2.69", scripts: { test: "bun test" } }));
  return root;
}
function files(root: string) {
  return ["package.json", SNAPSHOT_PATH].map((path) => readFileSync(join(root, path), "utf8"));
}
function registry(change?: (pkg: { name: string; version: string; deprecated?: string }) => void) {
  const versions: Record<string, string> = {
    [BRIDGE_PACKAGE.claude]: next.claude.acp, [BRIDGE_PACKAGE.codex]: next.codex.acp,
    [RUNTIME_PIN.claude.package]: next.claude.sdk, "@anthropic-ai/claude-code": next.claude.executable,
    [RUNTIME_PIN.codex.package]: next.codex.sdk,
  };
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    expect(url.startsWith("https://registry.npmjs.org/")).toBe(true);
    const name = url.replace("https://registry.npmjs.org/", "").replace(/\/latest$/, "");
    const pkg = { name, version: versions[name]! };
    change?.(pkg);
    return Response.json(pkg);
  };
  return { calls, fetcher };
}

test("release preparation resolves all five public packages including the actual CC version", async () => {
  const { calls, fetcher } = registry();
  expect(await latestRuntimeVersions(fetcher, baseline)).toEqual(next);
  expect(calls).toHaveLength(5); // Codex runtime and executable share the same query.
});

test("registry failure, prerelease, downgrade, wrong package and deprecated latest fail closed", async () => {
  await expect(latestRuntimeVersions(async () => new Response("", { status: 503 }), baseline)).rejects.toThrow("503");
  for (const change of [
    (pkg: any) => { pkg.version = "9.0.0-beta.1"; },
    (pkg: any) => { pkg.version = "0.0.1"; },
    (pkg: any) => { pkg.name = "wrong-package"; },
    (pkg: any) => { pkg.deprecated = "retired"; },
  ]) {
    await expect(latestRuntimeVersions(registry(change).fetcher, baseline)).rejects.toThrow();
  }
});

test("candidate install or ACP initialization failure leaves BOTH release files untouched", async () => {
  const root = repository(), before = files(root);
  await expect(prepareRelease(root, "0.2.70", {
    latest: async () => next, verify: async () => { throw new Error("ACP initialization failed"); },
  })).rejects.toThrow("ACP initialization failed");
  expect(files(root)).toEqual(before);
});

test("dry run really validates candidate versions but never edits release files", async () => {
  const root = repository(), before = files(root);
  let verified = false;
  await prepareRelease(root, "0.2.70", {
    dryRun: true, latest: async () => next,
    verify: async (snapshot) => { expect(snapshot.claude).toEqual(next.claude); verified = true; },
  });
  expect(verified).toBe(true);
  expect(files(root)).toEqual(before);
});

test("a successful prepare records matching versions and supports retry before tagging", async () => {
  const root = repository();
  const now = () => new Date("2026-09-14T01:00:00Z");
  const options = { latest: async () => next, verify: async () => {}, now };
  const snapshot = await prepareRelease(root, "0.2.70", options);
  expect(JSON.parse(files(root)[0]!)).toEqual({ name: "remi", version: "0.2.70", scripts: { test: "bun test" } });
  expect(JSON.parse(files(root)[1]!)).toEqual(snapshot);
  expect(snapshot.checkedAt).toBe("2026-09-14T01:00:00.000Z");
  expect(() => checkRelease(root, { tag: "v0.2.70" })).not.toThrow();
  await expect(prepareRelease(root, "0.2.70", options)).resolves.toEqual(snapshot);
  await expect(prepareRelease(root, "0.2.69", options)).rejects.toThrow("at least");
});

test("preparation cannot overwrite concurrent changes while candidate checks run", async () => {
  const root = repository();
  await expect(prepareRelease(root, "0.2.70", {
    latest: async () => next,
    verify: async () => { writeFileSync(join(root, "package.json"), '{"version":"0.2.71"}'); },
  })).rejects.toThrow("changed during preparation");
  expect(JSON.parse(files(root)[0]!).version).toBe("0.2.71");
  expect(JSON.parse(files(root)[1]!)).toEqual(baseline);
});

test("a simple package version bump cannot bypass the CI release snapshot gate", async () => {
  const root = repository();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "baseline");
  const baseRef = git("rev-parse", "HEAD");
  expect(() => checkRelease(root, { baseRef })).not.toThrow();
  writeFileSync(join(root, "package.json"), '{"version":"0.2.70"}');
  expect(() => checkRelease(root, { baseRef })).toThrow("not prepared");
  expect(() => checkRelease(root, { tag: "v0.2.70" })).toThrow("not prepared");
  expect(() => checkRelease(root, { tag: "v0.2.71" })).toThrow("Tag");
  await prepareRelease(root, "0.2.70", { latest: async () => next, verify: async () => {} });
  expect(() => checkRelease(root, { baseRef })).not.toThrow();
  expect(() => checkRelease(root, { baseRef: "--bad-ref" })).toThrow("base commit");
});

test("tag publication rejects malformed snapshots and prerelease dependency pins", () => {
  for (const invalid of [
    { ...baseline, checkedAt: null },
    { ...baseline, checkedAt: "invalid" },
    { ...baseline, schema: 2 },
    { ...baseline, codex: { ...baseline.codex, sdk: "0.154.0-beta" } },
  ]) expect(() => checkReleaseSnapshot("0.2.69", invalid)).toThrow("not prepared");
});
