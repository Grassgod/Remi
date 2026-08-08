/**
 * Multiremi CLI — `project doc` / `project memory` command handlers.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import {
  type CliOptions,
  addQueryParam,
  hasOption,
  integerOption,
  rawStringOption,
} from "../options.js";
import { multiremiApiRequest } from "../http.js";
import { printJson, printProjectDocCollection } from "../output.js";
import {
  addStringBodyField,
  citationRefsOption,
  readOptionalTextBody,
} from "./fields.js";

export async function project(positional: string[], options: CliOptions): Promise<void> {
  const area = positional[0] ?? "";
  if (area === "doc") {
    await projectDoc(positional.slice(1), options);
    return;
  }
  if (area === "memory") {
    await projectMemory(positional.slice(1), options);
    return;
  }
  throw new Error("usage: multiremi project doc|memory ...");
}

export async function projectDoc(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const projectId = positional[1]?.trim();
  const ref = positional[2]?.trim();
  if (action === "list") {
    if (!projectId) throw new Error("usage: multiremi project doc list <project-id> [--kind wiki|memory] [--output json]");
    const params = new URLSearchParams();
    addQueryParam(params, "kind", rawStringOption(options, "kind"));
    const query = params.toString();
    printProjectDocCollection(await multiremiApiRequest(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/docs${query ? `?${query}` : ""}`,
      undefined,
      options,
    ), options);
    return;
  }
  if (action === "get") {
    if (!projectId || !ref) throw new Error("usage: multiremi project doc get <project-id> <slug-or-id> [--output json]");
    printJson(await multiremiApiRequest(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`,
      undefined,
      options,
    ));
    return;
  }
  if (action === "create") {
    if (!projectId) {
      throw new Error("usage: multiremi project doc create <project-id> --kind wiki|memory --title <title> [--slug <slug>] [--summary <text>] [--tags a,b] [--pinned] [--ref <type>:<value>] [--content <text>|--content-file <path>|--content-stdin]");
    }
    await projectDocCreate(projectId, options);
    return;
  }
  if (action === "update") {
    if (!projectId || !ref) {
      throw new Error("usage: multiremi project doc update <project-id> <slug-or-id> [--title <title>] [--summary <text>] [--tags a,b] [--pinned true|false] [--ref <type>:<value>] [--expected-version <n>] [--content <text>|--content-file <path>|--content-stdin]");
    }
    await projectDocUpdate(projectId, ref, options);
    return;
  }
  if (action === "delete") {
    if (!projectId || !ref) throw new Error("usage: multiremi project doc delete <project-id> <slug-or-id>");
    const response = await multiremiApiRequest(
      "DELETE",
      `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`,
      undefined,
      options,
    );
    printJson(response ?? { deleted: true });
    return;
  }
  if (action === "search") {
    if (!projectId || !ref) throw new Error("usage: multiremi project doc search <project-id> <query> [--kind wiki|memory] [--limit <n>]");
    const params = new URLSearchParams({ q: ref });
    addQueryParam(params, "kind", rawStringOption(options, "kind"));
    const limit = integerOption(options, "limit");
    if (limit !== null) params.set("limit", String(limit));
    printProjectDocCollection(await multiremiApiRequest(
      "GET",
      `/api/projects/${encodeURIComponent(projectId)}/docs?${params.toString()}`,
      undefined,
      options,
    ), options);
    return;
  }
  throw new Error("usage: multiremi project doc list|get|create|update|delete|search <project-id> ...");
}

export async function projectDocCreate(projectId: string, options: CliOptions): Promise<void> {
  const title = rawStringOption(options, "title");
  if (!title?.trim()) throw new Error("--title is required");
  const body: Record<string, unknown> = { kind: rawStringOption(options, "kind") ?? "wiki", title };
  addStringBodyField(body, options, "slug", "slug");
  addStringBodyField(body, options, "summary", "summary", false, true);
  await addProjectDocSharedBodyFields(body, options);
  printJson(await multiremiApiRequest("POST", `/api/projects/${encodeURIComponent(projectId)}/docs`, body, options));
}

export async function projectDocUpdate(projectId: string, ref: string, options: CliOptions): Promise<void> {
  const body: Record<string, unknown> = {};
  addStringBodyField(body, options, "title", "title");
  addStringBodyField(body, options, "summary", "summary", false, true);
  await addProjectDocSharedBodyFields(body, options);
  if (Object.keys(body).length === 0) {
    throw new Error("no fields to update; pass --title, --summary, --tags, --pinned, --ref, or --content");
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

export async function projectMemory(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  const projectId = positional[1]?.trim();
  if (action === "add") {
    if (!projectId) {
      throw new Error("usage: multiremi project memory add <project-id> --title <one-sentence fact> [--summary <text>] [--ref <type>:<value>] [--content <text>|--content-file <path>|--content-stdin]");
    }
    const title = rawStringOption(options, "title");
    if (!title?.trim()) throw new Error("--title is required");
    const body: Record<string, unknown> = { kind: "memory", title, pinned: true };
    addStringBodyField(body, options, "summary", "summary", false, true);
    await addProjectDocSharedBodyFields(body, options);
    // In-task provenance: the daemon injects MULTIREMI_TASK_ID into the agent
    // process, and the server backfills the issue behind that task.
    const taskId = process.env.MULTIREMI_TASK_ID?.trim();
    if (taskId) body.source_task_id = taskId;
    printJson(await multiremiApiRequest("POST", `/api/projects/${encodeURIComponent(projectId)}/docs`, body, options));
    return;
  }
  throw new Error("usage: multiremi project memory add <project-id> --title <one-sentence fact> ...");
}

/** --tags / --pinned / --ref / --content: shared by doc create, doc update, and memory add. */
export async function addProjectDocSharedBodyFields(body: Record<string, unknown>, options: CliOptions): Promise<void> {
  if (hasOption(options, "tags")) body.tags = parseProjectDocTags(rawStringOption(options, "tags") ?? "");
  const pinned = projectDocPinnedOption(options);
  if (pinned !== null) body.pinned = pinned;
  const refs = citationRefsOption(options);
  if (refs) body.refs = refs;
  const content = await readOptionalTextBody(options, "content");
  if (content.set) body.body = content.value;
}

export function parseProjectDocTags(raw: string): string[] {
  return raw.split(",").map((tag) => tag.trim()).filter(Boolean);
}

export function projectDocPinnedOption(options: CliOptions): boolean | null {
  if (!hasOption(options, "pinned")) return null;
  const value = rawStringOption(options, "pinned");
  // Bare `--pinned` parses as a boolean flag and means pinned=true.
  if (value == null) return true;
  if (value !== "true" && value !== "false") throw new Error("--pinned must be true or false");
  return value === "true";
}
