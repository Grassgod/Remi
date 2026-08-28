import type { CliOptions } from "../options.js";
import { multiremiApiConnection, multiremiApiRequest } from "../http.js";
import { printJson } from "../output.js";

export type WikiLintFindingType = "duplicate" | "contradiction" | "orphan" | "broken_link";

export interface LibrarianWikiDocument {
  id: string;
  scope: "project" | "repository";
  repositoryId: string | null;
  repositoryDirectory?: string | null;
  slug: string;
  path: string;
  title: string;
  body: string;
  refs: Array<{ type: string; value: string }>;
  version: number;
}

export interface WikiLintFinding {
  type: WikiLintFindingType;
  severity: "warning" | "error";
  document: Pick<LibrarianWikiDocument, "id" | "scope" | "repositoryId" | "slug" | "path" | "title">;
  related_document?: Pick<LibrarianWikiDocument, "id" | "scope" | "repositoryId" | "slug" | "path" | "title">;
  similarity?: number;
  fact?: string;
  values?: [string, string];
  target?: string;
}

export interface WikiLintReport {
  clean: boolean;
  documents_scanned: number;
  counts: Record<WikiLintFindingType, number>;
  findings: WikiLintFinding[];
  diagnostics: string[];
}

export async function wikiLint(options: CliOptions, projectId: string): Promise<WikiLintReport> {
  const scope = await fetchLibrarianDocuments(options, projectId);
  const report = lintWikiDocuments(scope.documents, scope.knownTargets);
  for (const diagnostic of report.diagnostics) console.error(`Wiki lint: ${diagnostic}`);
  printJson(report);
  return report;
}

export async function wikiMerge(
  options: CliOptions,
  projectId: string,
  targetRef: string,
  sourceRefs: readonly string[],
): Promise<Record<string, unknown>> {
  if (!sourceRefs.length) throw new Error("wiki merge requires at least one source document");
  const uniqueSources = [...new Set(sourceRefs.map((value) => value.trim()).filter(Boolean))];
  if (uniqueSources.includes(targetRef)) throw new Error("wiki merge target cannot also be a source");

  const target = await fetchProjectDoc(options, projectId, targetRef);
  const sources = await Promise.all(uniqueSources.map((ref) => fetchProjectDoc(options, projectId, ref)));
  if (sources.some((source) => source.id === target.id)) throw new Error("wiki merge target cannot also be a source");
  const { body, refs } = mergeWikiDocuments(projectId, target, sources);

  const updated = await multiremiApiRequest(
    "PUT",
    `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(target.id)}`,
    { body, refs, expected_version: target.version },
    options,
  );
  const deleted: Array<{ id: string; slug: string; version: number }> = [];
  for (const source of sources) {
    await multiremiApiRequest(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(source.id)}?expected_version=${source.version}`,
      undefined,
      options,
    );
    deleted.push({ id: source.id, slug: source.slug, version: source.version });
  }
  const result = {
    merged: true,
    project_id: projectId,
    target: unwrapDoc(updated),
    deleted_sources: deleted,
    preserved_refs: refs,
  };
  printJson(result);
  return result;
}

export function mergeWikiDocuments(
  projectId: string,
  target: LibrarianWikiDocument,
  sources: readonly LibrarianWikiDocument[],
): { body: string; refs: Array<{ type: string; value: string }> } {
  let body = target.body.trimEnd();
  const refs = mergeRefs(target.refs, sources.flatMap((source) => [
    ...source.refs,
    { type: "wiki", value: `project:${projectId}/${source.slug}` },
  ]));
  for (const source of sources) {
    const marker = `<!-- merged-from:${source.id} -->`;
    if (body.includes(marker)) continue;
    body += `${body ? "\n\n" : ""}${marker}\n## Merged from: ${source.title}\n\n${source.body.trim()}`;
  }
  if (body) body += "\n";
  return { body, refs };
}

export function lintWikiDocuments(
  documents: readonly LibrarianWikiDocument[],
  knownTargets: readonly string[] = [],
): WikiLintReport {
  const findings: WikiLintFinding[] = [];
  const diagnostics: string[] = [];
  const aliases = new Map<string, LibrarianWikiDocument[]>();
  const inbound = new Set<string>();
  const brokenLinks = new Set<string>();
  const externalAliases = new Set(knownTargets.map(normalizeRef).filter(Boolean));
  for (const document of documents) {
    for (const alias of documentAliases(document)) {
      const matches = aliases.get(alias) ?? [];
      matches.push(document);
      aliases.set(alias, matches);
    }
  }

  for (const source of documents) {
    if (source.slug === "_schema") continue;
    for (const target of wikiLinks(source.body)) {
      const matches = aliases.get(normalizeRef(target)) ?? [];
      if (!matches.length) {
        if (externalAliases.has(normalizeRef(target))) continue;
        const key = `${source.id}\0${normalizeRef(target)}`;
        if (!brokenLinks.has(key)) {
          brokenLinks.add(key);
          findings.push({ type: "broken_link", severity: "error", document: summary(source), target });
        }
        continue;
      }
      for (const match of matches) if (match.id !== source.id) inbound.add(match.id);
    }
  }

  for (const document of documents) {
    if (!inbound.has(document.id) && !isNavigationPage(document)) {
      findings.push({ type: "orphan", severity: "warning", document: summary(document) });
    }
  }

  for (let leftIndex = 0; leftIndex < documents.length; leftIndex++) {
    const left = documents[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex++) {
      const right = documents[rightIndex]!;
      const similarity = contentSimilarity(left.body, right.body);
      if (similarity >= 0.8) {
        findings.push({
          type: "duplicate",
          severity: "warning",
          document: summary(left),
          related_document: summary(right),
          similarity: Math.round(similarity * 1000) / 1000,
        });
      }
    }
  }

  const facts = new Map<string, Array<{ document: LibrarianWikiDocument; label: string; value: string; normalized: string }>>();
  for (const document of documents) {
    for (const fact of explicitFacts(document.body)) {
      const scope = document.scope === "project" ? "project" : `repository:${document.repositoryId ?? document.id}`;
      const key = `${scope}\0${fact.subject}\0${fact.property}`;
      const entries = facts.get(key) ?? [];
      entries.push({ document, label: fact.label, value: fact.value, normalized: normalizeFactValue(fact.value) });
      facts.set(key, entries);
    }
  }
  const seenContradictions = new Set<string>();
  for (const [key, entries] of facts) {
    if (entries.length > MAX_CONTRADICTION_BUCKET_SIZE) {
      diagnostics.push(`skipped contradiction bucket ${JSON.stringify(key.replaceAll("\0", "/"))}: ${entries.length} facts exceed the ${MAX_CONTRADICTION_BUCKET_SIZE}-fact limit`);
      continue;
    }
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
      const left = entries[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
        const right = entries[rightIndex]!;
        if (left.document.id === right.document.id || left.normalized === right.normalized) continue;
        const pair = [left.document.id, right.document.id].sort().join("\0");
        const values = [left.normalized, right.normalized].sort().join("\0");
        const findingKey = `${key}\0${pair}\0${values}`;
        if (seenContradictions.has(findingKey)) continue;
        seenContradictions.add(findingKey);
        findings.push({
          type: "contradiction",
          severity: "error",
          document: summary(left.document),
          related_document: summary(right.document),
          fact: left.label,
          values: [left.value, right.value],
        });
      }
    }
  }

  findings.sort((left, right) =>
    left.type.localeCompare(right.type)
    || left.document.path.localeCompare(right.document.path)
    || (left.related_document?.path ?? "").localeCompare(right.related_document?.path ?? "")
  );
  const counts: WikiLintReport["counts"] = { duplicate: 0, contradiction: 0, orphan: 0, broken_link: 0 };
  for (const finding of findings) counts[finding.type] += 1;
  return { clean: findings.length === 0 && diagnostics.length === 0, documents_scanned: documents.length, counts, findings, diagnostics };
}

async function fetchLibrarianDocuments(
  options: CliOptions,
  projectId: string,
): Promise<{ documents: LibrarianWikiDocument[]; knownTargets: string[] }> {
  const workspaceId = multiremiApiConnection(options).workspaceId;
  if (!workspaceId) throw new Error("--workspace <workspace-id> is required for wiki lint");
  const [projectResponse, memoryResponse, context] = await Promise.all([
    multiremiApiRequest("GET", `/api/projects/${encodeURIComponent(projectId)}/docs?kind=wiki`, undefined, options),
    multiremiApiRequest("GET", `/api/projects/${encodeURIComponent(projectId)}/docs?kind=memory`, undefined, options),
    fetchLibrarianContext(options, projectId),
  ]);
  const projectDocs = arrayField(projectResponse, "docs").map((value) => parseDocument(value, "project", null));
  const repositoryIds = stringArrayField(context.project, "repository_ids");
  const repositoryResponses = await Promise.all(repositoryIds.map(async (repositoryId) => ({
    repositoryId,
    directory: repositoryDirectory(context.repositories.get(repositoryId), repositoryId),
    response: await multiremiApiRequest(
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}/wiki`,
      undefined,
      options,
    ),
  })));
  const repositoryDocs = repositoryResponses.flatMap(({ repositoryId, directory, response }) =>
    arrayField(response, "docs").map((value) => parseDocument(value, "repository", repositoryId, directory))
  );
  const knownTargets = arrayField(memoryResponse, "docs").flatMap((value) => {
    if (!isRecord(value)) return [];
    return [recordField(value, "id"), recordField(value, "slug")].filter(Boolean);
  });
  return { documents: [...projectDocs, ...repositoryDocs], knownTargets };
}

async function fetchLibrarianContext(
  options: CliOptions,
  projectId: string,
): Promise<{ project: Record<string, unknown>; repositories: Map<string, Record<string, unknown>> }> {
  let cursor: string | null = null;
  let project: Record<string, unknown> | null = null;
  const repositories = new Map<string, Record<string, unknown>>();
  do {
    const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const response: unknown = await multiremiApiRequest("GET", `/api/cli/context?limit=200${suffix}`, undefined, options);
    project ??= findContextProject(response, projectId);
    for (const candidate of arrayField(recordValue(response, "catalog"), "repositories")) {
      if (!isRecord(candidate)) continue;
      const id = recordField(candidate, "id");
      if (id) repositories.set(id, candidate);
    }
    cursor = recordField(recordValue(response, "catalog"), "next_cursor") || null;
  } while (cursor && (!project || stringArrayField(project, "repository_ids").some((id) => !repositories.has(id))));
  if (!project) throw new Error(`Project ${projectId} is missing from the CLI context`);
  return { project, repositories };
}

async function fetchProjectDoc(options: CliOptions, projectId: string, ref: string): Promise<LibrarianWikiDocument> {
  const response = await multiremiApiRequest(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`,
    undefined,
    options,
  );
  return parseDocument(unwrapDoc(response), "project", null);
}

function parseDocument(
  value: unknown,
  scope: LibrarianWikiDocument["scope"],
  repositoryId: string | null,
  repositoryDirectory: string | null = null,
): LibrarianWikiDocument {
  if (!isRecord(value)) throw new Error("Wiki API returned an invalid document");
  const id = recordField(value, "id");
  const slug = recordField(value, "slug");
  const path = recordField(value, "path") || `${slug}.md`;
  const title = recordField(value, "title");
  if (!id || !slug || !title) throw new Error("Wiki API document is missing id, slug, or title");
  return {
    id,
    scope,
    repositoryId,
    repositoryDirectory,
    slug,
    path,
    title,
    body: recordField(value, "body"),
    refs: Array.isArray(value.refs)
      ? value.refs.filter(isRecord).map((ref) => ({ type: recordField(ref, "type"), value: recordField(ref, "value") })).filter((ref) => ref.value)
      : [],
    version: Number(value.version ?? 0),
  };
}

function unwrapDoc(value: unknown): unknown {
  return isRecord(value) && isRecord(value.doc) ? value.doc : value;
}

function arrayField(value: unknown, name: string): unknown[] {
  return isRecord(value) && Array.isArray(value[name]) ? value[name] : [];
}

function stringArrayField(value: unknown, name: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[name])) return [];
  return [...new Set(value[name].filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

function recordValue(value: unknown, name: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[name]) ? value[name] : null;
}

function findContextProject(value: unknown, projectId: string): Record<string, unknown> | null {
  const current = recordValue(recordValue(value, "current"), "project");
  if (current && recordField(current, "id") === projectId) return current;
  return arrayField(recordValue(value, "catalog"), "projects")
    .find((candidate): candidate is Record<string, unknown> => isRecord(candidate) && recordField(candidate, "id") === projectId) ?? null;
}

function repositoryDirectory(repository: Record<string, unknown> | undefined, repositoryId: string): string | null {
  const name = repository ? recordField(repository, "name") : "";
  if (!name) return null;
  return `${safeSlug(name)}-${safeSlug(repositoryId).slice(-8)}`;
}

function safeSlug(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/^\.+$/, "").slice(0, 160);
}

function recordField(value: unknown, name: string): string {
  return isRecord(value) && typeof value[name] === "string" ? value[name].trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summary(document: LibrarianWikiDocument): WikiLintFinding["document"] {
  const { id, scope, repositoryId, slug, path, title } = document;
  return { id, scope, repositoryId, slug, path, title };
}

function documentAliases(document: LibrarianWikiDocument): string[] {
  const path = document.path.replace(/\.md$/i, "");
  const basename = path.split("/").at(-1) ?? path;
  const materialized = document.scope === "repository" && document.repositoryDirectory
    ? [`repositories/${document.repositoryDirectory}/${document.path}`, `repositories/${document.repositoryDirectory}/${path}`]
    : [];
  return [...new Set([document.id, document.slug, document.path, path, basename, ...materialized].map(normalizeRef).filter(Boolean))];
}

function wikiLinks(body: string): string[] {
  return [...body.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map((match) => String(match[1] ?? "").split("|")[0]!.split("#")[0]!.trim())
    .filter(Boolean);
}

function normalizeRef(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\.md$/i, "").toLowerCase();
}

function isNavigationPage(document: LibrarianWikiDocument): boolean {
  const basename = document.path.split("/").at(-1)?.toLowerCase();
  return document.slug === "_schema" || basename === "overview.md" || basename === "index.md";
}

function contentSimilarity(left: string, right: string): number {
  const leftShingles = shingles(left);
  const rightShingles = shingles(right);
  if (leftShingles.size < 8 || rightShingles.size < 8) return 0;
  let shared = 0;
  for (const shingle of leftShingles) if (rightShingles.has(shingle)) shared += 1;
  return shared / (leftShingles.size + rightShingles.size - shared);
}

function shingles(value: string): Set<string> {
  const normalized = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const result = new Set<string>();
  for (let index = 0; index <= normalized.length - 5; index++) result.add(normalized.slice(index, index + 5));
  return result;
}

const MAX_CONTRADICTION_BUCKET_SIZE = 64;
const CONTRADICTION_PROPERTIES = new Set([
  "branch", "endpoint", "interval", "limit", "mode", "model", "owner", "port", "provider", "region",
  "state", "status", "timeout", "timezone", "version",
  "分支", "区域", "所有者", "提供方", "时区", "模型", "模式", "状态", "版本", "端点", "端口", "超时", "间隔", "上限",
]);

function explicitFacts(body: string): Array<{ subject: string; property: string; label: string; value: string }> {
  const facts: Array<{ subject: string; property: string; label: string; value: string }> = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, "").replace(/^\*\*(.+)\*\*$/, "$1");
    if (!line || line.startsWith("#") || line.startsWith("|") || line.length > 260) continue;
    const match = line.match(/^(.{2,80}?)(?::|\s=\s|\sis\s)(.{1,160})$/i);
    if (!match) continue;
    const label = match[1]!.replace(/\*\*/g, "").trim();
    const value = match[2]!.trim();
    const parts = label.toLowerCase().split(/[\s./>]+/u).map((part) => part.replace(/[^\p{L}\p{N}_-]+/gu, "")).filter(Boolean);
    if (parts.length < 2 || !value) continue;
    const property = parts.at(-1)!;
    const subject = parts.slice(0, -1).join(" ");
    if (!subject || !CONTRADICTION_PROPERTIES.has(property)) continue;
    facts.push({ subject, property, label, value });
  }
  return facts;
}

function normalizeFactValue(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function mergeRefs(
  existing: readonly { type: string; value: string }[],
  additions: readonly { type: string; value: string }[],
): Array<{ type: string; value: string }> {
  const refs = new Map<string, { type: string; value: string }>();
  for (const ref of [...existing, ...additions]) {
    const type = ref.type.trim();
    const value = ref.value.trim();
    if (!value) continue;
    refs.set(`${type}\0${value}`, { type, value });
  }
  return [...refs.values()];
}
