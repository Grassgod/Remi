import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkReleaseSnapshot, type RuntimeSnapshot } from "./release-runtime.js";
import { MULTIREMI_RELEASE_TARGETS, multiremiArchiveName } from "./build-multiremi.js";

export const CANDIDATE_WORKFLOW = ".github/workflows/release-build-check.yml";
export const RELEASE_BUN = "1.3.14";
const ROOT = resolve(import.meta.dir, "..");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function fileSha256(path: string): string {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024), descriptor = openSync(path, "r");
  try {
    let length: number;
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally { closeSync(descriptor); }
}
export interface CandidateIdentity {
  repository: string; sha: string; version: string; bun: string;
  lockSha256: string; runtimeSha256: string;
  builds: { cli: { version: string; targets: string[] }; api: ImageBuild; web: ImageBuild };
}
interface ImageBuild { dockerfile: string; platforms: string[]; args: Record<string, string>; labels: Record<string, string>; provenance: false }
export interface CandidateManifest {
  schema: 1; identity: CandidateIdentity; runId: string;
  files: Record<string, string>; images: { api: string; web: string };
}
export function candidateIdentity(root: string, repository: string, sha: string): CandidateIdentity {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid candidate source identity");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const runtime = readFileSync(join(root, "packages/acp/src/runtime-versions.json"));
  checkReleaseSnapshot(version, JSON.parse(runtime.toString()) as RuntimeSnapshot);
  const labels = { "org.opencontainers.image.revision": sha, "org.opencontainers.image.version": version,
    "org.opencontainers.image.source": `https://github.com/${repository}` };
  return { repository, sha, version, bun: RELEASE_BUN, lockSha256: sha256(readFileSync(join(root, "bun.lock"))), runtimeSha256: sha256(runtime),
    builds: {
      cli: { version: `v${version}`, targets: MULTIREMI_RELEASE_TARGETS.map(target => target.bunTarget) },
      api: { dockerfile: "deploy/docker/Dockerfile.api", platforms: ["linux/amd64"], args: { MULTIREMI_VERSION: `v${version}` }, labels, provenance: false },
      web: { dockerfile: "deploy/docker/Dockerfile.web", platforms: ["linux/amd64"], args: { REMI_APP_VERSION: version, NEXT_PUBLIC_APP_VERSION: version }, labels, provenance: false },
    } };
}
export function candidateFiles(identity: CandidateIdentity): string[] {
  return [...MULTIREMI_RELEASE_TARGETS.map(target => multiremiArchiveName(identity.version, target)), "install-remi.sh", "api.oci.tar", "web.oci.tar"].sort();
}
function regularFile(directory: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === "." || name === "..") throw new Error("Unsafe candidate file path");
  const path = join(directory, name);
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()
    || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Candidate files must be regular files in a real directory");
  return path;
}
// Read only named OCI members; never extract a candidate tar into the workspace.
export function ociDigest(archive: string, build?: ImageBuild): string {
  const members = execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).trim().split("\n");
  if (members.some(member => !/^(?:index\.json|oci-layout|blobs\/?|blobs\/sha256\/?|blobs\/sha256\/[a-f0-9]{64})$/.test(member))) throw new Error("Unsafe OCI archive member path");
  const listing = execFileSync("tar", ["-tvf", archive], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (listing.trim().split("\n").some(line => !["-", "d"].includes(line[0]!))) throw new Error("OCI archive cannot contain links or special files");
  const read = (member: string) => execFileSync("tar", ["-xOf", archive, "--", member], { maxBuffer: 16 * 1024 * 1024 });
  const index = JSON.parse(read("index.json").toString());
  if (index.schemaVersion !== 2 || index.manifests?.length !== 1) throw new Error("Expected one release image in OCI archive");
  const descriptor = index.manifests[0];
  if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) || descriptor.mediaType !== "application/vnd.oci.image.manifest.v1+json") throw new Error("Unsupported OCI image descriptor");
  const manifest = read(`blobs/sha256/${descriptor.digest.slice(7)}`);
  if (`sha256:${sha256(manifest)}` !== descriptor.digest) throw new Error("OCI manifest digest mismatch");
  if (build) {
    const image = JSON.parse(manifest.toString());
    if (!/^sha256:[a-f0-9]{64}$/.test(image.config?.digest)) throw new Error("Invalid OCI config descriptor");
    const configBytes = read(`blobs/sha256/${image.config.digest.slice(7)}`);
    if (`sha256:${sha256(configBytes)}` !== image.config.digest) throw new Error("OCI config digest mismatch");
    const config = JSON.parse(configBytes.toString());
    if (config.os !== "linux" || config.architecture !== "amd64") throw new Error("Candidate OCI platform mismatch");
    for (const [key, value] of Object.entries(build.labels)) {
      if (config.config?.Labels?.[key] !== value) throw new Error(`Candidate OCI label mismatch: ${key}`);
    }
    if (build.args.MULTIREMI_VERSION && !config.config?.Env?.includes(`MULTIREMI_VERSION=${build.args.MULTIREMI_VERSION}`)) throw new Error("Candidate API runtime version mismatch");
  }
  return descriptor.digest;
}
export function createCandidate(root: string, directory: string, repository: string, sha: string, runId: string): CandidateManifest {
  if (!/^\d+$/.test(runId)) throw new Error("Invalid candidate run ID");
  const identity = candidateIdentity(root, repository, sha);
  if (canonical(readdirSync(directory).sort()) !== canonical(candidateFiles(identity))) throw new Error("Unexpected files or directories in candidate staging directory");
  const files = Object.fromEntries(candidateFiles(identity).map(name => [name, fileSha256(regularFile(directory, name))]));
  if (files["install-remi.sh"] !== sha256(readFileSync(join(root, "scripts/install-remi.sh")))) throw new Error("Candidate installer does not match release source");
  return { schema: 1, identity, runId, files, images: { api: ociDigest(regularFile(directory, "api.oci.tar"), identity.builds.api), web: ociDigest(regularFile(directory, "web.oci.tar"), identity.builds.web) } };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export type CandidateKind = "cli" | "images" | "all";
const candidateParts = (kind: CandidateKind) => kind === "cli" ? ["candidate-cli"] : kind === "images" ? ["candidate-api", "candidate-web"] : ["candidate-cli", "candidate-api", "candidate-web"];
function consumedFiles(identity: CandidateIdentity, kind: CandidateKind): string[] {
  return candidateFiles(identity).filter(name => kind === "all" || (kind === "images" ? name.endsWith(".oci.tar") : !name.endsWith(".oci.tar")));
}
function verifyManifest(root: string, manifest: CandidateManifest, repository: string, sha: string, trustedRunId: string): CandidateIdentity {
  const expected = candidateIdentity(root, repository, sha);
  if (manifest.schema !== 1 || manifest.runId !== trustedRunId || canonical(manifest.identity) !== canonical(expected)) throw new Error("Candidate identity does not match trusted release inputs");
  if (canonical(Object.keys(manifest.files).sort()) !== canonical(candidateFiles(expected))) throw new Error("Candidate file inventory mismatch");
  if (Object.values(manifest.files).some(digest => !/^[a-f0-9]{64}$/.test(digest))
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.images?.api) || !/^sha256:[a-f0-9]{64}$/.test(manifest.images?.web)) throw new Error("Invalid candidate checksum or image digest");
  return expected;
}
export function verifyCandidate(root: string, directory: string, manifest: CandidateManifest, repository: string, sha: string, trustedRunId: string, kind: CandidateKind = "all"): void {
  const expected = verifyManifest(root, manifest, repository, sha, trustedRunId);
  const consumed = consumedFiles(expected, kind);
  if (canonical(readdirSync(directory).sort()) !== canonical([...consumed, "release-candidate.json"].sort())) throw new Error("Unexpected files or directories in candidate artifact");
  for (const name of consumed) {
    if (fileSha256(regularFile(directory, name)) !== manifest.files[name]) throw new Error(`Candidate checksum mismatch: ${name}`);
  }
  if (kind !== "images" && manifest.files["install-remi.sh"] !== sha256(readFileSync(join(root, "scripts/install-remi.sh")))) throw new Error("Candidate installer mismatch");
  if (kind !== "cli") {
    for (const image of ["api", "web"] as const) {
      if (manifest.images[image] !== ociDigest(regularFile(directory, `${image}.oci.tar`), expected.builds[image])) throw new Error(`Candidate OCI digest mismatch: ${image}`);
    }
  }
}

interface WorkflowRun { id: number; head_sha: string; head_branch: string; path: string; status: string; conclusion: string; event: string; repository: { full_name: string }; head_repository: { full_name: string } }
interface WorkflowJob { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }
export function trustedReleaseRun(run: WorkflowRun, jobs: WorkflowJob[], repository: string, sha: string, candidate = false): boolean {
  if (run.head_sha !== sha || run.head_branch !== "main" || run.path !== CANDIDATE_WORKFLOW
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.status !== "completed" || run.conclusion !== "success" || !["push", "workflow_dispatch"].includes(run.event)) return false;
  const build = jobs.find(job => job.name === "build");
  if (build?.conclusion !== "success") return false;
  const evidence = jobs.find(job => job.name === "backend-evidence");
  if (evidence?.conclusion === "success") return true;
  if (candidate) return false;
  // A strictly verified selective retry retains its existing release eligibility,
  // but never qualifies as the full candidate producer or as new full evidence.
  const retry = jobs.find(job => job.name === "backend-retry");
  return (retry?.conclusion === "success" && retry.steps?.some(step => step.name === "Verify baseline and retry failed backend files" && step.conclusion === "success") === true)
    || build.steps?.some(step => step.name === "Backend test suite" && step.conclusion === "success") === true;
}
function gh(args: string[]): string { return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); }
function pages(endpoint: string): any[] { return JSON.parse(gh(["api", "--paginate", "--slurp", endpoint])); }
export async function resolveCandidate(root: string, directory: string, repository: string, sha: string, dependencies: {
  api?: (endpoint: string) => any[];
  download?: (runId: string, name: string, directory: string) => void;
} = {}, kind: CandidateKind = "all"): Promise<{ reused: boolean; runId?: string }> {
  const api = dependencies.api ?? pages;
  candidateIdentity(root, repository, sha); // Validate snapshot even on fallback.
  const runs = api(`repos/${repository}/actions/workflows/release-build-check.yml/runs?head_sha=${sha}&branch=main&status=success&per_page=100`).flatMap(page => page.workflow_runs);
  let eligible = false;
  for (const run of runs as WorkflowRun[]) {
    const jobs = api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).flatMap(page => page.jobs);
    if (!trustedReleaseRun(run, jobs, repository, sha)) continue;
    eligible = true;
    const artifacts = api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`).flatMap(page => page.artifacts);
    const candidates = artifacts.filter(artifact => artifact.name === `release-candidate-${sha}` && !artifact.expired);
    if (!candidates.length) continue;
    if (candidates.length !== 1 || !trustedReleaseRun(run, jobs, repository, sha, true)
      || jobs.find((job: WorkflowJob) => job.name === "candidate-package")?.conclusion !== "success") throw new Error("Candidate does not have trusted full CI provenance");
    if (existsSync(directory) && readdirSync(directory).length) throw new Error("Candidate download directory must be empty");
    mkdirSync(directory, { recursive: true });
    // gh downloads this exact run's immutable artifact, never arbitrary manifest URLs.
    const download = (name: string) => {
      if (dependencies.download) dependencies.download(String(run.id), name, directory);
      else gh(["run", "download", String(run.id), "--repo", repository, "--name", name, "--dir", directory]);
    };
    download(`release-candidate-${sha}`);
    const manifest = JSON.parse(readFileSync(regularFile(directory, "release-candidate.json"), "utf8"));
    verifyManifest(root, manifest, repository, sha, String(run.id));
    if (canonical(readdirSync(directory)) !== canonical(["release-candidate.json"])) throw new Error("Manifest artifact must contain only release-candidate.json");
    const required = candidateParts(kind).map(name => ({ name, matches: artifacts.filter(artifact => artifact.name === name) }));
    if (required.some(part => part.matches.length > 1)) throw new Error("Ambiguous candidate part inventory");
    if (required.some(part => !part.matches.length || part.matches[0].expired)) {
      console.log("Required candidate part is missing or expired; using the original release build after a verified release check");
      return { reused: false };
    }
    for (const part of required) download(part.name);
    verifyCandidate(root, directory, manifest, repository, sha, String(run.id), kind);
    return { reused: true, runId: String(run.id) };
  }
  if (!eligible) throw new Error("Release requires successful full CI or a strictly verified retry on this exact main SHA (PR checks do not count)");
  console.log("No unexpired release candidate for this SHA; using the original release build after a verified release check");
  return { reused: false };
}
if (import.meta.main) {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { dir: { type: "string" }, sha: { type: "string" }, kind: { type: "string" } } });
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const sha = values.sha ?? process.env.GITHUB_SHA ?? "";
  const directory = resolve(values.dir ?? "candidate");
  if (execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() !== sha) throw new Error("Candidate source SHA must equal the checked-out commit");
  if (Bun.version !== RELEASE_BUN) throw new Error(`Release candidates require Bun ${RELEASE_BUN}`);
  if (positionals.length !== 1) throw new Error("Expected create or resolve");
  if (positionals[0] === "create") {
    if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Candidates can only be created by an explicit manual run on main");
    const manifest = createCandidate(ROOT, directory, repository, sha, process.env.GITHUB_RUN_ID ?? "");
    writeFileSync(join(directory, "release-candidate.json"), JSON.stringify(manifest, null, 2) + "\n");
  } else if (positionals[0] === "resolve") {
    if (values.kind !== "cli" && values.kind !== "images") throw new Error("resolve requires --kind cli or --kind images");
    const result = await resolveCandidate(ROOT, directory, repository, sha, {}, values.kind);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reused=${result.reused}\nrun-id=${result.runId ?? ""}\n`);
    console.log(JSON.stringify(result));
  } else throw new Error("Expected create or resolve");
}
