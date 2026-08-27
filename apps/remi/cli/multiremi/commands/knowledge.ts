/** Top-level `memory` and `wiki` command handlers. */

import {
  type CliOptions,
  addQueryParam,
  hasOption,
  integerOption,
  rawStringOption,
} from "../options.js";
import { multiremiApiConnection, multiremiApiRequest } from "../http.js";
import { printJson, printProjectDocCollection, printProjectKnowledgeHits } from "../output.js";
import {
  addStringBodyField,
  citationRefsOption,
  readOptionalTextBody,
} from "./fields.js";
import { wikiDiff, wikiMove, wikiPull, wikiPush, wikiStatus } from "./wiki-working-copy.js";

type KnowledgeKind = "memory" | "wiki";

export async function memory(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action === "list") {
    await listKnowledge("memory", options);
    return;
  }
  if (action === "search" || action === "recall") {
    const query = positional[1]?.trim();
    if (!query) throw new Error("usage: multiremi memory recall <query> [--project <project-id>] [--limit <n>]");
    await searchKnowledge("memory", query, options);
    return;
  }
  if (action === "read" || action === "get") {
    await readKnowledge("memory", positional[1], options);
    return;
  }
  if (action === "remember" || action === "add") {
    await createKnowledge("memory", options);
    return;
  }
  if (action === "update") {
    await updateKnowledge("memory", positional[1], options);
    return;
  }
  if (action === "forget" || action === "delete") {
    await deleteKnowledge("memory", positional[1], options);
    return;
  }
  if (action === "backlinks") {
    await backlinks("memory", positional[1], options);
    return;
  }
  throw new Error("usage: multiremi memory list|search|recall|read|remember|update|forget|backlinks ...");
}

export async function wiki(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action === "pull") {
    await wikiPull(options, requireProject("wiki", "pull", options));
    return;
  }
  if (action === "status") {
    await wikiStatus(options, projectOption(options));
    return;
  }
  if (action === "diff") {
    await wikiDiff(options, requireProject("wiki", "diff", options));
    return;
  }
  if (action === "mv") {
    const ref = positional[1]?.trim();
    const destination = positional[2]?.trim();
    if (!ref || !destination) throw new Error("usage: multiremi wiki mv <ref> <new-path> [--project <project-id>]");
    await wikiMove(options, projectOption(options), ref, destination);
    return;
  }
  if (action === "push") {
    await wikiPush(options, projectOption(options));
    return;
  }
  if (action === "list") {
    await listKnowledge("wiki", options);
    return;
  }
  if (action === "search") {
    const query = positional[1]?.trim();
    if (!query) throw new Error("usage: multiremi wiki search <query> [--project <project-id>] [--limit <n>]");
    await searchKnowledge("wiki", query, options);
    return;
  }
  if (action === "read" || action === "get") {
    await readKnowledge("wiki", positional[1], options);
    return;
  }
  if (action === "create") {
    await createKnowledge("wiki", options);
    return;
  }
  if (action === "update") {
    await updateKnowledge("wiki", positional[1], options);
    return;
  }
  if (action === "delete") {
    await deleteKnowledge("wiki", positional[1], options);
    return;
  }
  if (action === "history" || action === "revisions") {
    await history("wiki", positional[1], options);
    return;
  }
  if (action === "backlinks") {
    await backlinks("wiki", positional[1], options);
    return;
  }
  throw new Error("usage: multiremi wiki list|search|read|create|update|delete|history|backlinks|pull|status|diff|mv|push ...");
}

async function listKnowledge(kind: KnowledgeKind, options: CliOptions): Promise<void> {
  const projectId = projectOption(options);
  if (projectId) {
    printProjectDocCollection(await multiremiApiRequest(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/docs?kind=${kind}`,
      undefined,
      options,
    ), options);
    return;
  }
  const params = workspaceKnowledgeParams(kind, options);
  printProjectDocCollection(await multiremiApiRequest(
    "GET",
    `/api/project-docs?${params}`,
    undefined,
    options,
  ), options);
}

async function searchKnowledge(kind: KnowledgeKind, query: string, options: CliOptions): Promise<void> {
  const projectId = projectOption(options);
  const limit = integerOption(options, "limit");
  if (projectId) {
    const params = new URLSearchParams({ q: query, kind });
    if (limit !== null) params.set("limit", String(limit));
    printProjectKnowledgeHits(await multiremiApiRequest(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/knowledge/recall?${params}`,
      undefined,
      options,
    ), options);
    return;
  }
  const params = workspaceKnowledgeParams(kind, options);
  params.set("q", query);
  if (limit !== null) params.set("limit", String(limit));
  printProjectDocCollection(await multiremiApiRequest(
    "GET",
    `/api/project-docs?${params}`,
    undefined,
    options,
  ), options);
}

async function readKnowledge(kind: KnowledgeKind, rawRef: string | undefined, options: CliOptions): Promise<void> {
  const projectId = requireProject(kind, "read", options);
  const ref = requireRef(kind, "read", rawRef);
  printJson(await multiremiApiRequest(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`,
    undefined,
    options,
  ));
}

async function createKnowledge(kind: KnowledgeKind, options: CliOptions): Promise<void> {
  const action = kind === "memory" ? "remember" : "create";
  const projectId = requireProject(kind, action, options);
  const title = rawStringOption(options, "title");
  if (!title?.trim()) throw new Error("--title is required");
  const body: Record<string, unknown> = {
    kind,
    title,
    ...(kind === "memory" ? { pinned: true } : {}),
  };
  addStringBodyField(body, options, "slug", "slug");
  addStringBodyField(body, options, "path", "path");
  addStringBodyField(body, options, "summary", "summary", false, true);
  await addKnowledgeBodyFields(body, options);
  if (kind === "memory") {
    if (typeof body.body !== "string" || !body.body.trim()) {
      throw new Error("memory body is required");
    }
    const taskId = process.env.MULTIREMI_TASK_ID?.trim();
    if (taskId) body.source_task_id = taskId;
  }
  printJson(await multiremiApiRequest(
    "POST",
    `/api/projects/${encodeURIComponent(projectId)}/docs`,
    body,
    options,
  ));
}

async function updateKnowledge(
  kind: KnowledgeKind,
  rawRef: string | undefined,
  options: CliOptions,
): Promise<void> {
  const projectId = requireProject(kind, "update", options);
  const ref = requireRef(kind, "update", rawRef);
  const body: Record<string, unknown> = {};
  addStringBodyField(body, options, "title", "title");
  addStringBodyField(body, options, "path", "path");
  addStringBodyField(body, options, "summary", "summary", false, true);
  await addKnowledgeBodyFields(body, options);
  if (Object.keys(body).length === 0) {
    throw new Error("no fields to update; pass --title, --path, --summary, --tags, --pinned, --ref, or --content");
  }
  const expectedVersion = integerOption(options, "expected-version");
  if (expectedVersion !== null) body.expected_version = expectedVersion;
  printJson(await multiremiApiRequest(
    "PUT",
    `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`,
    body,
    options,
  ));
}

async function deleteKnowledge(
  kind: KnowledgeKind,
  rawRef: string | undefined,
  options: CliOptions,
): Promise<void> {
  const action = kind === "memory" ? "forget" : "delete";
  const projectId = requireProject(kind, action, options);
  const ref = requireRef(kind, action, rawRef);
  printJson(await multiremiApiRequest(
    "DELETE",
    `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`,
    undefined,
    options,
  ));
}

async function backlinks(kind: KnowledgeKind, rawRef: string | undefined, options: CliOptions): Promise<void> {
  const projectId = requireProject(kind, "backlinks", options);
  const ref = requireRef(kind, "backlinks", rawRef);
  printProjectDocCollection(await multiremiApiRequest(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}/backlinks`,
    undefined,
    options,
  ), options);
}

async function history(kind: KnowledgeKind, rawRef: string | undefined, options: CliOptions): Promise<void> {
  const projectId = requireProject(kind, "history", options);
  const ref = requireRef(kind, "history", rawRef);
  printJson(await multiremiApiRequest(
    "GET",
    `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}/revisions`,
    undefined,
    options,
  ));
}

function workspaceKnowledgeParams(kind: KnowledgeKind, options: CliOptions): URLSearchParams {
  const params = new URLSearchParams({ kind });
  addQueryParam(params, "workspace_id", multiremiApiConnection(options).workspaceId);
  return params;
}

function projectOption(options: CliOptions): string | null {
  return rawStringOption(options, "project")?.trim()
    || process.env.MULTIREMI_PROJECT_ID?.trim()
    || null;
}

function requireProject(kind: KnowledgeKind, action: string, options: CliOptions): string {
  const projectId = projectOption(options);
  if (!projectId) throw new Error(`--project <project-id> is required for ${kind} ${action}`);
  return projectId;
}

function requireRef(kind: KnowledgeKind, action: string, rawRef: string | undefined): string {
  const ref = rawRef?.trim();
  if (!ref) throw new Error(`usage: multiremi ${kind} ${action} <slug-or-id> --project <project-id>`);
  return ref;
}

async function addKnowledgeBodyFields(body: Record<string, unknown>, options: CliOptions): Promise<void> {
  if (hasOption(options, "tags")) body.tags = parseKnowledgeTags(rawStringOption(options, "tags") ?? "");
  const pinned = knowledgePinnedOption(options);
  if (pinned !== null) body.pinned = pinned;
  const refs = citationRefsOption(options);
  if (refs) body.refs = refs;
  const content = await readOptionalTextBody(options, "content");
  if (content.set) body.body = content.value;
}

export function parseKnowledgeTags(raw: string): string[] {
  return raw.split(",").map((tag) => tag.trim()).filter(Boolean);
}

export function knowledgePinnedOption(options: CliOptions): boolean | null {
  if (!hasOption(options, "pinned")) return null;
  const value = rawStringOption(options, "pinned");
  if (value == null) return true;
  if (value !== "true" && value !== "false") throw new Error("--pinned must be true or false");
  return value === "true";
}
