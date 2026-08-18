import { multiremiApiRequest } from "./http.js";
import type { CliOptions } from "./options.js";

const SERVER_NAME = "multiremi-project-knowledge";
const PROTOCOL_VERSION = "2024-11-05";

export interface ProjectKnowledgeMcpRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

export async function runProjectKnowledgeMcp(projectId: string): Promise<void> {
  if (!projectId.trim()) throw new Error("project id is required for project-knowledge-mcp");
  const options: CliOptions = {};
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const request = JSON.parse(line) as ProjectKnowledgeMcpRequest;
        const response = await handleProjectKnowledgeMcpRequest(projectId, options, request);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stderr.write(`[${SERVER_NAME}] request failed: ${safeError(error)}\n`);
      }
    }
  }
}

export async function handleProjectKnowledgeMcpRequest(
  projectId: string,
  options: CliOptions,
  request: ProjectKnowledgeMcpRequest,
): Promise<Record<string, unknown> | null> {
  if (request.id == null) return null;
  if (request.method === "initialize") {
    return result(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: "1.0.0" },
    });
  }
  if (request.method === "tools/list") return result(request.id, { tools: TOOLS });
  if (request.method !== "tools/call") return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  const name = request.params?.name ?? "";
  const args = request.params?.arguments ?? {};
  try {
    const value = await callTool(projectId, options, name, args);
    return result(request.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
  } catch (error) {
    return result(request.id, {
      content: [{ type: "text", text: safeError(error) }],
      isError: true,
    });
  }
}

async function callTool(
  projectId: string,
  options: CliOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "recall") {
    const query = requiredString(args.query, "query");
    const params = new URLSearchParams({ q: query, kind: optionalKind(args.kind) ?? "memory" });
    if (typeof args.limit === "number") params.set("limit", String(args.limit));
    return multiremiApiRequest("GET", `/api/projects/${encodeURIComponent(projectId)}/knowledge/recall?${params}`, undefined, options);
  }
  if (name === "read") {
    const ref = requiredString(args.ref, "ref");
    return multiremiApiRequest("GET", `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`, undefined, options);
  }
  if (name === "remember") {
    const title = requiredString(args.title, "title");
    const kind = optionalKind(args.kind) ?? "memory";
    return multiremiApiRequest("POST", `/api/projects/${encodeURIComponent(projectId)}/docs`, {
      kind,
      title,
      body: typeof args.content === "string" ? args.content : "",
      summary: typeof args.summary === "string" ? args.summary : undefined,
      tags: stringArray(args.tags),
      refs: referenceArray(args.refs),
      pinned: args.pinned === undefined ? kind === "memory" : Boolean(args.pinned),
      source_task_id: process.env.MULTIREMI_TASK_ID,
    }, options);
  }
  if (name === "update") {
    const ref = requiredString(args.ref, "ref");
    const body: Record<string, unknown> = {};
    for (const key of ["title", "summary", "content", "tags", "refs", "pinned", "expected_version"] as const) {
      if (!(key in args)) continue;
      body[key === "content" ? "body" : key] = key === "refs" ? referenceArray(args[key]) : args[key];
    }
    return multiremiApiRequest("PUT", `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}`, body, options);
  }
  if (name === "backlinks") {
    const ref = requiredString(args.ref, "ref");
    return multiremiApiRequest("GET", `/api/projects/${encodeURIComponent(projectId)}/docs/${encodeURIComponent(ref)}/backlinks`, undefined, options);
  }
  throw new Error(`Unknown tool: ${name}`);
}

const TOOLS = [
  {
    name: "recall",
    description: "Semantically search the current project and return compact hits. Call read with a hit's slug before using its full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["memory", "wiki"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
    },
  },
  {
    name: "read",
    description: "Read one current-project memory or wiki document by slug or id.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
  {
    name: "remember",
    description: "Create a sourced memory or wiki document in the current project.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, content: { type: "string" }, summary: { type: "string" },
        kind: { type: "string", enum: ["memory", "wiki"] }, tags: { type: "array", items: { type: "string" } },
        refs: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
        pinned: { type: "boolean" },
      },
      required: ["title"],
    },
  },
  {
    name: "update",
    description: "Update one current-project memory or wiki document with optimistic version checking.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" }, title: { type: "string" }, content: { type: "string" }, summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } }, refs: { type: "array", items: { type: "object" } },
        pinned: { type: "boolean" }, expected_version: { type: "integer" },
      },
      required: ["ref"],
    },
  },
  {
    name: "backlinks",
    description: "List current-project documents that contain a [[slug]] link to the target.",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
  },
];

function result(id: string | number, value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id: string | number, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function requiredString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalKind(value: unknown): "memory" | "wiki" | null {
  if (value == null || value === "") return null;
  if (value === "memory" || value === "wiki") return value;
  throw new Error("kind must be memory or wiki");
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function referenceArray(value: unknown): Array<{ type: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.value !== "string" || !row.value.trim()) return [];
    return [{ type: typeof row.type === "string" ? row.type : "", value: row.value }];
  });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}
