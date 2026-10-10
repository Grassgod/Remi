import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateFiles, candidateIdentity, createCandidate, ociDigest, resolveCandidate, trustedReleaseRun, verifyCandidate, type CandidateManifest } from "../../../scripts/release-candidate.js";

const repository = "example/remi", sha = "a".repeat(40), runId = "123";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-candidate-")); directories.push(root);
  mkdirSync(join(root, "packages/acp/src"), { recursive: true }); mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(root, "bun.lock"), "frozen lock"); writeFileSync(join(root, "scripts/install-remi.sh"), "#!/bin/sh\n");
  writeFileSync(join(root, "packages/acp/src/runtime-versions.json"), JSON.stringify({ schema: 1, preparedFor: "1.2.3", checkedAt: "2026-10-10T00:00:00Z",
    claude: { acp: "1.0.0", sdk: "1.0.0", executable: "1.0.0" }, codex: { acp: "1.0.0", sdk: "1.0.0", executable: "1.0.0" } }));
  const directory = join(root, "candidate"); mkdirSync(directory);
  const identity = candidateIdentity(root, repository, sha);
  for (const name of candidateFiles(identity)) {
    if (!name.endsWith(".oci.tar")) writeFileSync(join(directory, name), name === "install-remi.sh" ? readFileSync(join(root, "scripts/install-remi.sh")) : "compiled fixture");
  }
  for (const kind of ["api", "web"] as const) {
    const layout = join(root, kind); mkdirSync(join(layout, "blobs/sha256"), { recursive: true });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const config = JSON.stringify({ architecture: "amd64", os: "linux", config: { Labels: identity.builds[kind].labels,
      Env: kind === "api" ? ["MULTIREMI_VERSION=v1.2.3"] : [] } });
    const configDigest = digest(config); writeFileSync(join(layout, "blobs/sha256", configDigest), config);
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${configDigest}`, size: config.length }, layers: [] });
    const manifestDigest = digest(manifest); writeFileSync(join(layout, "blobs/sha256", manifestDigest), manifest);
    writeFileSync(join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${manifestDigest}`, size: manifest.length }] }));
    writeFileSync(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
    execFileSync("tar", ["-cf", join(directory, `${kind}.oci.tar`), "-C", layout, "index.json", "oci-layout", "blobs"]);
  }
  const manifest = createCandidate(root, directory, repository, sha, runId);
  writeFileSync(join(directory, "release-candidate.json"), JSON.stringify(manifest));
  return { root, directory, manifest };
}
const run = { id: 123, head_sha: sha, head_branch: "main", path: ".github/workflows/release-build-check.yml", status: "completed", conclusion: "success", event: "workflow_dispatch",
  repository: { full_name: repository }, head_repository: { full_name: repository } };
const fullJobs = [{ name: "build", conclusion: "success" }, { name: "backend-evidence", conclusion: "success" }, { name: "candidate-package", conclusion: "success" }];

describe("candidate release inputs and provenance", () => {
  test("matches exact inputs and archive inventory; rejects tampering, extra paths and symlinks", () => {
    const f = fixture();
    verifyCandidate(f.root, f.directory, f.manifest, repository, sha, runId);
    expect(() => verifyCandidate(f.root, f.directory, f.manifest, repository, "b".repeat(40), runId)).toThrow("identity");
    expect(() => verifyCandidate(f.root, f.directory, f.manifest, repository, sha, "124")).toThrow("identity");
    const extra = join(f.directory, "remi-injected.tar.gz"); writeFileSync(extra, "unexpected");
    expect(() => verifyCandidate(f.root, f.directory, f.manifest, repository, sha, runId)).toThrow("Unexpected"); rmSync(extra);
    const installer = join(f.directory, "install-remi.sh"); writeFileSync(installer, "tampered");
    expect(() => verifyCandidate(f.root, f.directory, f.manifest, repository, sha, runId)).toThrow("checksum");
    rmSync(installer); symlinkSync(join(f.root, "scripts/install-remi.sh"), installer);
    expect(() => verifyCandidate(f.root, f.directory, f.manifest, repository, sha, runId)).toThrow("regular files");
  });

  test("rejects stale lock/snapshot and forged build arguments", () => {
    const f = fixture();
    const forged: CandidateManifest = structuredClone(f.manifest); forged.identity.builds.api.args.MULTIREMI_VERSION = "v0.0.0-ci";
    expect(() => verifyCandidate(f.root, f.directory, forged, repository, sha, runId)).toThrow("identity");
    writeFileSync(join(f.root, "bun.lock"), "different dependencies");
    expect(() => verifyCandidate(f.root, f.directory, f.manifest, repository, sha, runId)).toThrow("identity");
    writeFileSync(join(f.root, "packages/acp/src/runtime-versions.json"), "{}");
    expect(() => candidateIdentity(f.root, repository, sha)).toThrow("not prepared");
  });

  test("checks OCI platform, release labels, runtime version and refuses unsafe tar paths", () => {
    const f = fixture(), identity = candidateIdentity(f.root, repository, sha);
    expect(ociDigest(join(f.directory, "api.oci.tar"), identity.builds.api)).toBe(f.manifest.images.api);
    const wrong = structuredClone(identity.builds.api); wrong.labels["org.opencontainers.image.revision"] = "b".repeat(40);
    expect(() => ociDigest(join(f.directory, "api.oci.tar"), wrong)).toThrow("label mismatch");
    wrong.labels = identity.builds.api.labels; wrong.args.MULTIREMI_VERSION = "v9.9.9";
    expect(() => ociDigest(join(f.directory, "api.oci.tar"), wrong)).toThrow("runtime version");
    writeFileSync(join(f.root, "evil"), "unsafe");
    execFileSync("tar", ["-cf", join(f.root, "unsafe.tar"), "--transform=s|evil|../evil|", "-C", f.root, "evil"]);
    expect(() => ociDigest(join(f.root, "unsafe.tar"))).toThrow("Unsafe OCI");
  });

  test("only exact repository main full success produces candidates; strict retry remains fallback-only", () => {
    expect(trustedReleaseRun(run, fullJobs, repository, sha, true)).toBe(true);
    for (const changed of [{ head_sha: "b".repeat(40) }, { head_branch: "feature" }, { event: "pull_request" }, { conclusion: "failure" }, { head_repository: { full_name: "fork/remi" } }]) {
      expect(trustedReleaseRun({ ...run, ...changed }, fullJobs, repository, sha, true)).toBe(false);
    }
    const retryJobs = [{ name: "build", conclusion: "success" }, { name: "backend-evidence", conclusion: "skipped" }, { name: "backend-retry", conclusion: "success",
      steps: [{ name: "Verify baseline and retry failed backend files", conclusion: "success" }] }];
    expect(trustedReleaseRun(run, retryJobs, repository, sha)).toBe(true);
    expect(trustedReleaseRun(run, retryJobs, repository, sha, true)).toBe(false);
    expect(trustedReleaseRun(run, [{ name: "build", conclusion: "success" }], repository, sha)).toBe(false);
  });

  test("missing/expired candidate falls back only with verified CI; API errors and discovered damage fail", async () => {
    const f = fixture(); const download = join(f.root, "download");
    const api = (expired: boolean) => (endpoint: string) => {
      if (endpoint.includes("/jobs?")) return [{ jobs: fullJobs }];
      if (endpoint.includes("/artifacts?")) return [{ artifacts: expired ? [{ name: `release-candidate-${sha}`, expired: true }] : [] }];
      return [{ workflow_runs: [run] }];
    };
    expect(await resolveCandidate(f.root, download, repository, sha, { api: api(false) })).toEqual({ reused: false });
    expect(await resolveCandidate(f.root, download, repository, sha, { api: api(true) })).toEqual({ reused: false });
    await expect(resolveCandidate(f.root, download, repository, sha, { api: () => { throw new Error("HTTP 403"); } })).rejects.toThrow("HTTP 403");
    await expect(resolveCandidate(f.root, download, repository, sha, { api: () => [{ workflow_runs: [] }] })).rejects.toThrow("requires successful");
    const artifactNames = [`release-candidate-${sha}`, "candidate-cli", "candidate-api", "candidate-web"];
    const presentApi = (endpoint: string) => endpoint.includes("/artifacts?") ? [{ artifacts: artifactNames.map(name => ({ name, expired: false })) }] : api(false)(endpoint);
    const downloads: string[] = [];
    const fetchCandidate = (_runId: string, name: string, directory: string) => {
      downloads.push(name);
      const files = name.startsWith("release-candidate-") ? ["release-candidate.json"] : name === "candidate-cli"
        ? candidateFiles(f.manifest.identity).filter(file => !file.endsWith(".oci.tar")) : [`${name.slice("candidate-".length)}.oci.tar`];
      for (const file of files) cpSync(join(f.directory, file), join(directory, file));
    };
    expect(await resolveCandidate(f.root, download, repository, sha, { api: presentApi, download: fetchCandidate })).toEqual({ reused: true, runId });
    rmSync(download, { recursive: true }); downloads.length = 0;
    expect(await resolveCandidate(f.root, download, repository, sha, { api: presentApi, download: fetchCandidate }, "cli")).toEqual({ reused: true, runId });
    expect(downloads).toEqual([`release-candidate-${sha}`, "candidate-cli"]);
    rmSync(download, { recursive: true }); downloads.length = 0;
    expect(await resolveCandidate(f.root, download, repository, sha, { api: presentApi, download: fetchCandidate }, "images")).toEqual({ reused: true, runId });
    expect(downloads).toEqual([`release-candidate-${sha}`, "candidate-api", "candidate-web"]);
    rmSync(download, { recursive: true });
    const missingPart = (endpoint: string) => endpoint.includes("/artifacts?") ? [{ artifacts: [{ name: `release-candidate-${sha}`, expired: false }] }] : api(false)(endpoint);
    expect(await resolveCandidate(f.root, download, repository, sha, { api: missingPart, download: fetchCandidate }, "cli")).toEqual({ reused: false });
    rmSync(download, { recursive: true });
    const expiredPart = (endpoint: string) => endpoint.includes("/artifacts?") ? [{ artifacts: [{ name: `release-candidate-${sha}`, expired: false }, { name: "candidate-cli", expired: true }] }] : api(false)(endpoint);
    expect(await resolveCandidate(f.root, download, repository, sha, { api: expiredPart, download: fetchCandidate }, "cli")).toEqual({ reused: false });
    rmSync(download, { recursive: true }); writeFileSync(join(f.directory, "install-remi.sh"), "damaged");
    await expect(resolveCandidate(f.root, download, repository, sha, { api: presentApi, download: fetchCandidate })).rejects.toThrow("checksum");
  });
});
