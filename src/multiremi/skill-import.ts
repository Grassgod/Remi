import type {
  CreateSkillInput,
  ImportSkillInput,
  MultiremiSkillFile,
  MultiremiSkillImportSource,
} from "./types.js";

const MAX_IMPORT_FILE_SIZE = 1 << 20;
const MAX_IMPORT_TOTAL_SIZE = 8 << 20;
const MAX_IMPORT_FILE_COUNT = 128;

type DetectedImportSource = {
  source: MultiremiSkillImportSource;
  normalizedUrl: string;
};

type ImportedSkill = {
  name: string;
  description: string;
  content: string;
  files: MultiremiSkillFile[];
  origin: Record<string, unknown>;
};

type ImportResult = {
  source: MultiremiSkillImportSource;
  sourceUrl: string;
  skillInput: CreateSkillInput;
};

type GitHubSpec = {
  owner: string;
  repo: string;
  ref: string;
  skillDir: string;
  refSegments: string[];
  kind: "tree" | "blob" | "";
};

type GitHubContentEntry = {
  name?: string;
  path?: string;
  type?: string;
  url?: string;
  download_url?: string;
};

type GitHubTreeEntry = {
  path?: string;
  type?: string;
};

type GitHubTreeResponse = {
  tree?: GitHubTreeEntry[];
  truncated?: boolean;
};

type GitHubRepoInfo = {
  default_branch?: string;
};

type ClawHubSkillResponse = {
  skill?: {
    displayName?: string;
    summary?: string;
    tags?: Record<string, string>;
  };
  latestVersion?: {
    version?: string;
  } | null;
};

type ClawHubVersionResponse = {
  version?: {
    files?: Array<{ path?: string }>;
  };
};

export class SkillImportError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "SkillImportError";
  }
}

class ImportCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportCapError";
  }
}

export async function buildImportedSkillInput(input: ImportSkillInput): Promise<ImportResult> {
  const sourceUrl = input.url ?? input.sourceUrl ?? input.source_url ?? "";
  const detected = detectImportSource(sourceUrl);
  let imported: ImportedSkill;

  try {
    if (detected.source === "github") {
      imported = await fetchFromGitHub(detected.normalizedUrl);
    } else if (detected.source === "skills_sh") {
      imported = await fetchFromSkillsSh(detected.normalizedUrl);
    } else {
      imported = await fetchFromClawHub(detected.normalizedUrl);
    }
  } catch (error) {
    if (error instanceof SkillImportError) throw error;
    if (error instanceof ImportCapError) throw new SkillImportError(error.message, 400);
    throw new SkillImportError(errorMessage(error), 502);
  }

  const name = String(input.name ?? imported.name ?? "").trim();
  const description = input.description ?? imported.description ?? "";
  return {
    source: detected.source,
    sourceUrl: detected.normalizedUrl,
    skillInput: {
      workspaceId: input.workspaceId ?? input.workspace_id ?? "local",
      name: name || imported.name || "Imported skill",
      description,
      content: imported.content,
      files: imported.files,
      config: {
        origin: {
          ...imported.origin,
          imported_at: new Date().toISOString(),
        },
      },
      createdBy: input.createdBy ?? input.created_by ?? null,
    },
  };
}

function detectImportSource(rawUrl: string): DetectedImportSource {
  const raw = String(rawUrl ?? "").trim();
  if (!raw) throw new SkillImportError("empty URL", 400);
  if (!raw.includes("/") && !raw.includes(".")) {
    return { source: "clawhub", normalizedUrl: raw };
  }

  const normalizedUrl = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch (error) {
    throw new SkillImportError(`invalid URL: ${errorMessage(error)}`, 400);
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") return { source: "github", normalizedUrl };
  if (host === "skills.sh" || host === "www.skills.sh") return { source: "skills_sh", normalizedUrl };
  if (host === "clawhub.ai" || host === "www.clawhub.ai") return { source: "clawhub", normalizedUrl };
  throw new SkillImportError(`unsupported source: ${host} (supported: github.com, skills.sh, clawhub.ai)`, 400);
}

async function fetchFromGitHub(rawUrl: string): Promise<ImportedSkill> {
  const spec = parseGitHubUrl(rawUrl);
  if (spec.refSegments.length > 0) await resolveGitHubRefAndPath(spec);
  if (!spec.ref) spec.ref = await fetchGitHubDefaultBranch(spec.owner, spec.repo);

  const rawPrefix = `https://raw.githubusercontent.com/${encodePathSegment(spec.owner)}/${encodePathSegment(spec.repo)}/${escapeRefPath(spec.ref)}`;
  const skillMdPath = spec.skillDir ? `${spec.skillDir}/SKILL.md` : "SKILL.md";
  let skillMd: string;
  try {
    skillMd = await fetchRawText(buildRawGitHubUrl(rawPrefix, skillMdPath));
  } catch (error) {
    if (!spec.skillDir) {
      throw new Error(`SKILL.md not found at the root of ${spec.owner}/${spec.repo}@${spec.ref}. For multi-skill repositories, point to github.com/${spec.owner}/${spec.repo}/tree/${spec.ref}/<skill-dir>`);
    }
    throw new Error(`SKILL.md not found at ${skillMdPath} in ${spec.owner}/${spec.repo}@${spec.ref}: ${errorMessage(error)}`);
  }

  const metadata = parseSkillFrontmatter(skillMd);
  const imported = createImportedSkill({
    name: metadata.name || (spec.skillDir ? lastPathSegment(spec.skillDir) : spec.repo),
    description: metadata.description,
    content: skillMd,
    origin: {
      type: "github",
      source_url: rawUrl,
      owner: spec.owner,
      repo: spec.repo,
      ref: spec.ref,
      path: spec.skillDir,
    },
  });

  await collectGitHubSupportingFiles({
    owner: spec.owner,
    repo: spec.repo,
    ref: spec.ref,
    skillDir: spec.skillDir,
    imported,
  });
  return imported;
}

async function fetchFromSkillsSh(rawUrl: string): Promise<ImportedSkill> {
  const { owner, repo, skillName } = parseSkillsShParts(rawUrl);
  const defaultBranch = await fetchGitHubDefaultBranch(owner, repo);
  const rawPrefix = `https://raw.githubusercontent.com/${encodePathSegment(owner)}/${encodePathSegment(repo)}/${escapeRefPath(defaultBranch)}`;
  const candidateDirs = [
    `skills/${skillName}`,
    `.claude/skills/${skillName}`,
    `plugin/skills/${skillName}`,
    skillName,
  ];

  let skillMd = "";
  let skillDir = "";
  for (const dir of candidateDirs) {
    try {
      skillMd = await fetchRawText(buildRawGitHubUrl(rawPrefix, `${dir}/SKILL.md`));
      skillDir = dir;
      break;
    } catch {
      // Try the next conventional location.
    }
  }

  if (!skillMd) {
    try {
      const rootSkillMd = await fetchRawText(buildRawGitHubUrl(rawPrefix, "SKILL.md"));
      if (parseSkillFrontmatter(rootSkillMd).name === skillName) {
        skillMd = rootSkillMd;
        skillDir = "";
      }
    } catch {
      // Fall through to the repository tree scan.
    }
  }

  if (!skillMd) {
    const resolved = await resolveGitHubSkillDirByName(owner, repo, defaultBranch, rawPrefix, skillName);
    skillDir = resolved.skillDir;
    skillMd = resolved.skillMd;
  }

  const metadata = parseSkillFrontmatter(skillMd);
  const imported = createImportedSkill({
    name: metadata.name || skillName,
    description: metadata.description,
    content: skillMd,
    origin: {
      type: "skills_sh",
      source_url: rawUrl,
      owner,
      repo,
      skill: skillName,
      ref: defaultBranch,
      path: skillDir,
    },
  });

  await collectGitHubSupportingFiles({ owner, repo, ref: defaultBranch, skillDir, imported });
  return imported;
}

async function fetchFromClawHub(rawUrl: string): Promise<ImportedSkill> {
  const slug = parseClawHubSlug(rawUrl);
  const apiBase = "https://clawhub.ai/api/v1";
  const skillResponse = await fetchJson<ClawHubSkillResponse>(`${apiBase}/skills/${encodeURIComponent(slug)}`);
  const clawSkill = skillResponse.skill ?? {};
  const latestVersion = clawSkill.tags?.latest ?? skillResponse.latestVersion?.version ?? "";
  const filePaths: string[] = [];

  if (latestVersion) {
    const versionResponse = await fetchJson<ClawHubVersionResponse>(
      `${apiBase}/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(latestVersion)}`,
      { allowNotFound: true },
    );
    for (const file of versionResponse.version?.files ?? []) {
      if (file.path) filePaths.push(file.path);
    }
  }

  const imported = createImportedSkill({
    name: clawSkill.displayName || slug,
    description: clawSkill.summary || "",
    content: "",
    origin: {
      type: "clawhub",
      source_url: rawUrl,
      slug,
      version: latestVersion,
    },
  });

  for (const filePath of filePaths) {
    const url = new URL(`${apiBase}/skills/${encodeURIComponent(slug)}/file`);
    url.searchParams.set("path", filePath);
    if (latestVersion) url.searchParams.set("version", latestVersion);
    let content: string;
    try {
      content = await fetchRawText(url.toString());
    } catch (error) {
      if (isCapError(error) || filePath === "SKILL.md") throw new Error(`clawhub import: ${filePath}: ${errorMessage(error)}`);
      continue;
    }
    if (filePath === "SKILL.md") imported.content = content;
    else addImportedFile(imported, filePath, content);
  }

  if (!imported.content) throw new Error(`clawhub import: SKILL.md is empty or missing for ${slug}`);
  const metadata = parseSkillFrontmatter(imported.content);
  if (metadata.name) imported.name = metadata.name;
  if (metadata.description) imported.description = metadata.description;
  return imported;
}

function createImportedSkill(input: Omit<ImportedSkill, "files">): ImportedSkill {
  return { ...input, files: [] };
}

function addImportedFile(imported: ImportedSkill, path: string, content: string): void {
  if (isLikelyBinaryFilePath(path)) return;
  if (imported.files.length >= MAX_IMPORT_FILE_COUNT) {
    throw new ImportCapError(`import bundle exceeds ${MAX_IMPORT_FILE_COUNT} file limit`);
  }
  const totalSize = imported.files.reduce((sum, file) => sum + file.content.length, 0) + content.length;
  if (totalSize > MAX_IMPORT_TOTAL_SIZE) {
    throw new ImportCapError(`import bundle exceeds ${MAX_IMPORT_TOTAL_SIZE} byte limit`);
  }
  imported.files.push({ path, content });
}

async function collectGitHubSupportingFiles(input: {
  owner: string;
  repo: string;
  ref: string;
  skillDir: string;
  imported: ImportedSkill;
}): Promise<void> {
  const apiUrl = buildGitHubContentsUrl(input.owner, input.repo, input.skillDir, input.ref);
  const response = await fetchGitHubApi(apiUrl);
  if (response.status !== 200) return;

  let entries: GitHubContentEntry[];
  try {
    const decoded = await response.json();
    entries = Array.isArray(decoded) ? decoded as GitHubContentEntry[] : [];
  } catch {
    return;
  }

  const files: GitHubContentEntry[] = [];
  await collectGitHubFiles(entries, files, apiUrl);
  const basePath = input.skillDir ? `${input.skillDir}/` : "";
  for (const entry of files) {
    const downloadUrl = entry.download_url ?? "";
    if (!downloadUrl || !entry.path) continue;
    try {
      const body = await fetchRawText(downloadUrl);
      addImportedFile(input.imported, entry.path.startsWith(basePath) ? entry.path.slice(basePath.length) : entry.path, body);
    } catch (error) {
      if (isCapError(error)) throw error;
    }
  }
}

async function collectGitHubFiles(entries: GitHubContentEntry[], out: GitHubContentEntry[], parentUrl: string): Promise<void> {
  for (const entry of entries) {
    const name = entry.name ?? "";
    const lower = name.toLowerCase();
    if (lower === "skill.md" || lower === "license" || lower === "license.txt" || lower === "license.md") continue;
    if (entry.type === "file") {
      if (entry.path && !isLikelyBinaryFilePath(entry.path)) {
        if (out.length >= MAX_IMPORT_FILE_COUNT) {
          throw new ImportCapError(`import bundle exceeds ${MAX_IMPORT_FILE_COUNT} file limit`);
        }
        out.push(entry);
      }
      continue;
    }
    if (entry.type !== "dir") continue;

    const subUrl = entry.url || deriveGitHubSubdirectoryUrl(parentUrl, name);
    if (!subUrl) continue;
    const response = await fetchGitHubApi(subUrl);
    if (response.status !== 200) continue;
    const decoded = await response.json().catch(() => []);
    if (Array.isArray(decoded)) await collectGitHubFiles(decoded as GitHubContentEntry[], out, subUrl);
  }
}

async function resolveGitHubSkillDirByName(owner: string, repo: string, defaultBranch: string, rawPrefix: string, skillName: string): Promise<{ skillDir: string; skillMd: string }> {
  const treeUrl = `https://api.github.com/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/git/trees/${escapeRefPath(defaultBranch)}?recursive=1`;
  const response = await fetchGitHubApi(treeUrl);
  if (response.status !== 200) {
    throw new Error(`failed to inspect repository ${owner}/${repo} for skill ${skillName}: HTTP ${response.status}`);
  }
  const tree = await response.json() as GitHubTreeResponse;
  const skillPaths = extractSkillMdPaths(tree.tree ?? []);
  const { preferred, remaining } = partitionSkillMdPaths(skillName, skillPaths);
  const preferredMatch = await findMatchingSkillDirByFrontmatter(rawPrefix, skillName, preferred);
  if (preferredMatch) return preferredMatch;
  if (!tree.truncated) {
    const remainingMatch = await findMatchingSkillDirByFrontmatter(rawPrefix, skillName, remaining);
    if (remainingMatch) return remainingMatch;
    throw new Error(`SKILL.md not found in repository ${owner}/${repo} for skill ${skillName}`);
  }
  const conventionalMatch = await findSkillDirFromConventionalPrefixes(owner, repo, defaultBranch, rawPrefix, skillName);
  if (conventionalMatch) return conventionalMatch;
  throw new Error(`repository ${owner}/${repo} tree is too large to scan exhaustively for skill ${skillName}`);
}

async function findSkillDirFromConventionalPrefixes(owner: string, repo: string, defaultBranch: string, rawPrefix: string, skillName: string): Promise<{ skillDir: string; skillMd: string } | null> {
  const paths: string[] = [];
  for (const prefix of ["skills", ".claude/skills", "plugin/skills"]) {
    paths.push(...await listGitHubSkillMdPaths(owner, repo, prefix, defaultBranch));
  }
  const { preferred, remaining } = partitionSkillMdPaths(skillName, paths);
  return await findMatchingSkillDirByFrontmatter(rawPrefix, skillName, preferred)
    ?? await findMatchingSkillDirByFrontmatter(rawPrefix, skillName, remaining);
}

async function listGitHubSkillMdPaths(owner: string, repo: string, repoPath: string, ref: string): Promise<string[]> {
  const response = await fetchGitHubApi(buildGitHubContentsUrl(owner, repo, repoPath, ref));
  if (response.status === 404) return [];
  if (response.status !== 200) return [];
  const decoded = await response.json().catch(() => []);
  const paths: string[] = [];
  if (Array.isArray(decoded)) await collectGitHubSkillMdPaths(decoded as GitHubContentEntry[], paths, buildGitHubContentsUrl(owner, repo, repoPath, ref));
  return paths;
}

async function collectGitHubSkillMdPaths(entries: GitHubContentEntry[], out: string[], parentUrl: string): Promise<void> {
  for (const entry of entries) {
    const lower = (entry.name ?? "").toLowerCase();
    if (entry.type === "file") {
      if (lower === "skill.md" && entry.path) out.push(entry.path);
      continue;
    }
    if (entry.type !== "dir") continue;
    const subUrl = entry.url || deriveGitHubSubdirectoryUrl(parentUrl, entry.name ?? "");
    if (!subUrl) continue;
    const response = await fetchGitHubApi(subUrl);
    if (response.status !== 200) continue;
    const decoded = await response.json().catch(() => []);
    if (Array.isArray(decoded)) await collectGitHubSkillMdPaths(decoded as GitHubContentEntry[], out, subUrl);
  }
}

async function findMatchingSkillDirByFrontmatter(rawPrefix: string, skillName: string, skillPaths: string[]): Promise<{ skillDir: string; skillMd: string } | null> {
  for (const skillPath of skillPaths) {
    try {
      const skillMd = await fetchRawText(buildRawGitHubUrl(rawPrefix, skillPath));
      if (parseSkillFrontmatter(skillMd).name === skillName) {
        return { skillDir: skillDirFromSkillFilePath(skillPath), skillMd };
      }
    } catch {
      // Keep scanning other candidate SKILL.md files.
    }
  }
  return null;
}

async function resolveGitHubRefAndPath(spec: GitHubSpec): Promise<void> {
  const tried: string[] = [];
  let blocked = false;
  for (let length = spec.refSegments.length; length >= 1; length -= 1) {
    const candidate = spec.refSegments.slice(0, length).join("/");
    tried.push(candidate);
    const result = await githubRefExists(spec.owner, spec.repo, candidate);
    if (result === "blocked") {
      blocked = true;
      continue;
    }
    if (result) {
      spec.ref = candidate;
      spec.skillDir = length === spec.refSegments.length ? "" : spec.refSegments.slice(length).join("/");
      return;
    }
  }
  if (blocked) return;
  throw new Error(`could not resolve ref in github.com/${spec.owner}/${spec.repo} URL; tried: ${tried.join(", ")}`);
}

async function githubRefExists(owner: string, repo: string, ref: string): Promise<boolean | "blocked"> {
  const url = `https://api.github.com/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/commits/${escapeRefPath(ref)}`;
  const response = await fetchGitHubApi(url, { accept: "application/vnd.github.v3.sha" });
  if (response.status === 200) return true;
  if (response.status === 404 || response.status === 422) return false;
  if (response.status === 401 || response.status === 403 || response.status === 429) return "blocked";
  throw new Error(`github API returned status ${response.status} for ref ${ref}`);
}

async function fetchGitHubDefaultBranch(owner: string, repo: string): Promise<string> {
  const response = await fetchGitHubApi(`https://api.github.com/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}`);
  if (response.status !== 200) return "main";
  const info = await response.json().catch(() => ({})) as GitHubRepoInfo;
  return info.default_branch || "main";
}

function parseGitHubUrl(raw: string): GitHubSpec {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new SkillImportError(`invalid URL: ${errorMessage(error)}`, 400);
  }
  const parts = decodedPathParts(parsed.pathname);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new SkillImportError(`expected URL format: github.com/{owner}/{repo}[/tree/{ref}/{path}], got: ${parsed.pathname}`, 400);
  }
  const spec: GitHubSpec = {
    owner: parts[0],
    repo: parts[1].replace(/\.git$/i, ""),
    ref: "",
    skillDir: "",
    refSegments: [],
    kind: "",
  };
  if (parts.length === 2) return spec;

  const kind = parts[2];
  if (kind !== "tree" && kind !== "blob") {
    throw new SkillImportError(`unsupported URL form: github.com/${spec.owner}/${spec.repo}/${kind}/... (use /tree/{ref}/... or /blob/{ref}/.../SKILL.md)`, 400);
  }
  const rest = parts.slice(3);
  if (!rest.length || !rest[0]) throw new SkillImportError(`missing ref after /${kind}/`, 400);
  if (kind === "blob") {
    if (!rest[rest.length - 1] || rest[rest.length - 1].toLowerCase() !== "skill.md") {
      throw new SkillImportError("blob URL must point to a SKILL.md file", 400);
    }
    rest.pop();
    if (!rest.length) throw new SkillImportError("missing ref after /blob/", 400);
  }
  spec.kind = kind;
  spec.refSegments = rest;
  spec.ref = rest[0];
  spec.skillDir = rest.slice(1).join("/");
  return spec;
}

function parseSkillsShParts(raw: string): { owner: string; repo: string; skillName: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new SkillImportError(`invalid URL: ${errorMessage(error)}`, 400);
  }
  const parts = decodedPathParts(parsed.pathname);
  if (parts.length !== 3) {
    throw new SkillImportError(`expected URL format: skills.sh/{owner}/{repo}/{skill-name}, got: ${parsed.pathname}`, 400);
  }
  return { owner: parts[0], repo: parts[1], skillName: parts[2] };
}

function parseClawHubSlug(raw: string): string {
  if (!raw.includes("/") && !raw.includes(".")) return raw;
  let parsed: URL;
  try {
    parsed = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`);
  } catch (error) {
    throw new SkillImportError(`invalid URL: ${errorMessage(error)}`, 400);
  }
  const parts = decodedPathParts(parsed.pathname);
  if (parts.length === 2) return parts[1];
  if (parts.length === 1 && parts[0]) return parts[0];
  throw new SkillImportError(`could not extract skill slug from URL: ${raw}`, 400);
}

function parseSkillFrontmatter(content: string): { name: string; description: string } {
  if (!content.startsWith("---")) return { name: "", description: "" };
  const end = content.indexOf("---", 3);
  if (end < 0) return { name: "", description: "" };
  const frontmatter = content.slice(3, end);
  let name = "";
  let description = "";
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("name:")) name = cleanFrontmatterValue(trimmed.slice("name:".length));
    else if (trimmed.startsWith("description:")) description = cleanFrontmatterValue(trimmed.slice("description:".length));
  }
  return { name, description };
}

function cleanFrontmatterValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function extractSkillMdPaths(entries: GitHubTreeEntry[]): string[] {
  return entries
    .filter((entry) => entry.type === "blob" && Boolean(entry.path) && (entry.path === "SKILL.md" || entry.path!.endsWith("/SKILL.md")))
    .map((entry) => entry.path!);
}

function partitionSkillMdPaths(skillName: string, skillPaths: string[]): { preferred: string[]; remaining: string[] } {
  const preferred: string[] = [];
  const remaining: string[] = [];
  for (const skillPath of skillPaths) {
    if (isLikelySkillPathMatch(skillName, skillPath)) preferred.push(skillPath);
    else remaining.push(skillPath);
  }
  return { preferred, remaining };
}

function isLikelySkillPathMatch(skillName: string, skillPath: string): boolean {
  const dir = skillDirFromSkillFilePath(skillPath).toLowerCase();
  const base = lastPathSegment(dir);
  return skillNameHints(skillName).some((hint) => dir.includes(hint) || base.includes(hint) || hint.includes(base));
}

function skillNameHints(skillName: string): string[] {
  const parts = skillName.toLowerCase().split("-");
  const hints = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length >= 3) hints.add(trimmed);
  };
  add(skillName.toLowerCase());
  for (let index = 1; index < parts.length; index += 1) add(parts.slice(index).join("-"));
  for (const part of parts) add(part);
  return [...hints];
}

async function fetchJson<T>(url: string, options: { allowNotFound?: boolean } = {}): Promise<T> {
  const response = await fetch(url);
  if (response.status === 404 && options.allowNotFound) return {} as T;
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

async function fetchRawText(url: string): Promise<string> {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_IMPORT_FILE_SIZE) {
    throw new ImportCapError(`file exceeds ${MAX_IMPORT_FILE_SIZE} byte limit`);
  }
  const bytes = await readLimitedBytes(response, MAX_IMPORT_FILE_SIZE);
  return new TextDecoder().decode(bytes);
}

async function readLimitedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new ImportCapError(`file exceeds ${limit} byte limit`);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) throw new ImportCapError(`file exceeds ${limit} byte limit`);
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchGitHubApi(url: string, options: { accept?: string } = {}): Promise<Response> {
  const headers = new Headers();
  headers.set("Accept", options.accept ?? "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return await fetch(url, { headers });
}

function buildRawGitHubUrl(rawPrefix: string, repoPath: string): string {
  const parts = repoPath.split("/").filter(Boolean).map(encodePathSegment);
  return parts.length ? `${rawPrefix}/${parts.join("/")}` : rawPrefix;
}

function buildGitHubContentsUrl(owner: string, repo: string, repoPath: string, ref: string): string {
  const base = `https://api.github.com/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/contents`;
  const path = repoPath ? `/${repoPath.split("/").filter(Boolean).map(encodePathSegment).join("/")}` : "";
  return `${base}${path}?ref=${encodeURIComponent(ref)}`;
}

function deriveGitHubSubdirectoryUrl(parentUrl: string, name: string): string {
  if (!name) return "";
  const url = new URL(parentUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodePathSegment(name)}`;
  return url.toString();
}

function skillDirFromSkillFilePath(path: string): string {
  return path === "SKILL.md" ? "" : path.replace(/\/SKILL\.md$/i, "");
}

function escapeRefPath(ref: string): string {
  return ref.split("/").map(encodePathSegment).join("/");
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodedPathParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function lastPathSegment(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function isLikelyBinaryFilePath(path: string): boolean {
  const ext = path.toLowerCase().match(/\.[^.\\/]+$/)?.[0] ?? "";
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico", ".heic",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
    ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm", ".m4a", ".flac",
    ".exe", ".dll", ".so", ".dylib", ".class", ".jar", ".wasm",
    ".db", ".sqlite", ".sqlite3", ".pyc",
  ].includes(ext);
}

function isCapError(error: unknown): boolean {
  return error instanceof ImportCapError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
