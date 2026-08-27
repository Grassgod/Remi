import type { CliOptions } from "../options.js";
import { multiremiApiConnection, multiremiApiRequest } from "../http.js";
import { printJson } from "../output.js";

export type WikiLintFindingType = "duplicate" | "contradiction" | "orphan" | "broken_link";

export interface LibrarianWikiDocument {
  id: string;
  scope: "project" | "repository";
  repositoryId: string | null;
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
}

export async function wikiLint(options: CliOptions, projectId: string): Promise<WikiLintReport> {
  const report = lintWikiDocuments(await fetchLibrarianDocuments(options, projectId));
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

export function lintWikiDocuments(documents: readonly LibrarianWikiDocument[]): WikiLintReport {
  const findings: WikiLintFinding[] = [];
  const aliases = new Map<string, LibrarianWikiDocument[]>();
  const inbound = new Set<string>();
  for (const document of documents) {
    for (const alias of documentAliases(document)) {
      const matches = aliases.get(alias) ?? [];
      matches.push(document);
      aliases.set(alias, matches);
    }
  }

  for (const source of documents) {
    for (const target of wikiLinks(source.body)) {
      const matches = aliases.get(normalizeRef(target)) ?? [];
      if (!matches.length) {
        findings.push({ type: "broken_link", severity: "error", document: summary(source), target });
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
      const entries = facts.get(fact.key) ?? [];
      entries.push({ document, label: fact.label, value: fact.value, normalized: normalizeFactValue(fact.value) });
      facts.set(fact.key, entries);
    }
  }
  for (const entries of facts.values()) {
    for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
      const left = entries[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
        const right = entries[rightIndex]!;
        if (left.document.id === right.document.id || left.normalized === right.normalized) continue;
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
  return { clean: findings.length === 0, documents_scanned: documents.length, counts, findings };
}

async function fetchLibrarianDocuments(options: CliOptions, projectId: string): Promise<LibrarianWikiDocument[]> {
  const workspaceId = multiremiApiConnection(options).workspaceId;
  if (!workspaceId) throw new Error("--workspace <workspace-id> is required for wiki lint");
  const [projectResponse, repositoriesResponse] = await Promise.all([
    multiremiApiRequest("GET", `/api/projects/${encodeURIComponent(projectId)}/docs?kind=wiki`, undefined, options),
    multiremiApiRequest("GET", `/api/workspaces/${encodeURIComponent(workspaceId)}/repos`, undefined, options),
  ]);
  const projectDocs = arrayField(projectResponse, "docs").map((value) => parseDocument(value, "project", null));
  const repositoryIds = arrayField(repositoriesResponse, "repositories")
    .map((value) => recordField(value, "id"))
    .filter(Boolean);
  const repositoryResponses = await Promise.all(repositoryIds.map(async (repositoryId) => ({
    repositoryId,
    response: await multiremiApiRequest(
      "GET",
      `/api/workspaces/${encodeURIComponent(workspaceId)}/repos/${encodeURIComponent(repositoryId)}/wiki`,
      undefined,
      options,
    ),
  })));
  const repositoryDocs = repositoryResponses.flatMap(({ repositoryId, response }) =>
    arrayField(response, "docs").map((value) => parseDocument(value, "repository", repositoryId))
  );
  return [...projectDocs, ...repositoryDocs];
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

function parseDocument(value: unknown, scope: LibrarianWikiDocument["scope"], repositoryId: string | null): LibrarianWikiDocument {
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
  return [...new Set([document.id, document.slug, document.path, path, basename].map(normalizeRef).filter(Boolean))];
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

function explicitFacts(body: string): Array<{ key: string; label: string; value: string }> {
  const facts: Array<{ key: string; label: string; value: string }> = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, "").replace(/^\*\*(.+)\*\*$/, "$1");
    if (!line || line.startsWith("#") || line.startsWith("|") || line.length > 260) continue;
    const match = line.match(/^(.{2,80}?)(?::|\s=\s|\sis\s)(.{1,160})$/i);
    if (!match) continue;
    const label = match[1]!.replace(/\*\*/g, "").trim();
    const value = match[2]!.trim();
    const key = label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (key && value) facts.push({ key, label, value });
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
