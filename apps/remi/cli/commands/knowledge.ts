import { readFileSync } from "node:fs";
import { CliError, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
import type { CliOptions } from "../multiremi/options.js";
import { wikiDiff, wikiPull, wikiPush, wikiStatus } from "../multiremi/commands/wiki-working-copy.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  booleanOption,
  clientFor,
  commandOptions,
  csvOption,
  encodePath,
  integerOption,
  positional,
  queryOptions,
  renderResource,
  requestBody,
  requireConfirmation,
  requiredWorkspace,
  stringOption,
  stringOptions,
} from "./resource-common.js";
import { resolveProject } from "./project.js";
import { resolveRepository } from "./repo.js";

type KnowledgeKind = "memory" | "wiki";

const PROJECT_OPTION: CliOptionSpec = { name: "project", type: "string", valueName: "project", description: "Project ID, unique short ID, or unique name" };
const REPOSITORY_OPTION: CliOptionSpec = { name: "repo", type: "string", valueName: "repository", description: "Repository ID, unique short ID, or unique name" };
const KNOWLEDGE_FIELDS: readonly CliOptionSpec[] = [
  PROJECT_OPTION,
  { name: "title", type: "string", valueName: "title", description: "Document title" },
  { name: "slug", type: "string", valueName: "slug", description: "Document slug" },
  { name: "summary", type: "string", valueName: "text", description: "Document summary" },
  { name: "content", type: "string", valueName: "text", description: "Document body", conflictsWith: ["content-file", "content-stdin"] },
  { name: "content-file", type: "string", valueName: "path|-", description: "Read document body from a file or stdin", conflictsWith: ["content", "content-stdin"] },
  { name: "content-stdin", type: "boolean", description: "Read document body from stdin", conflictsWith: ["content", "content-file"] },
  { name: "tags", type: "string", valueName: "a,b", description: "Comma-separated tags" },
  { name: "pinned", type: "boolean", description: "Pin or unpin memory" },
  { name: "ref", type: "string", valueName: "type:value", repeatable: true, description: "Citation reference" },
  { name: "expected-version", type: "integer", valueName: "n", description: "Expected document version" },
];

export function knowledgeCommandSpecs(): CommandSpec[] {
  return [
    group("memory", "Recall and maintain project memory"),
    group("wiki", "Search and maintain project wiki pages"),
    ...kindSpecs("memory"),
    ...kindSpecs("wiki"),
    migrationSpec("memory.migration.status", ["memory", "migration", "status"], "Show project knowledge migration status", "GET", "/api/project-knowledge/migration", [
      { path: ["project", "knowledge", "status"], deprecatedSince: "0.3.0", replacement: "remi memory migration status" },
    ]),
    migrationSpec("memory.migration.backfill", ["memory", "migration", "backfill"], "Backfill project knowledge", "POST", "/api/project-knowledge/migration/backfill", [
      { path: ["project", "knowledge", "backfill"], deprecatedSince: "0.3.0", replacement: "remi memory migration backfill" },
    ], [
      { name: "dry-run", type: "boolean", description: "Plan without writing" },
      { name: "resume", type: "boolean", description: "Resume a previous backfill" },
    ]),
    migrationSpec("memory.migration.verify", ["memory", "migration", "verify"], "Verify project knowledge migration", "POST", "/api/project-knowledge/migration/verify", [
      { path: ["project", "knowledge", "verify"], deprecatedSince: "0.3.0", replacement: "remi memory migration verify" },
    ]),
    migrationSpec("memory.migration.retry", ["memory", "migration", "retry"], "Retry failed project knowledge migration", "POST", "/api/project-knowledge/migration/retry-failed", [
      { path: ["project", "knowledge", "retry-failed"], deprecatedSince: "0.3.0", replacement: "remi memory migration retry" },
    ]),
    ...repositoryWikiSpecs(),
    ...wikiWorkingCopySpecs(),
  ];
}

function repositoryWikiSpecs(): CommandSpec[] {
  const fields: readonly CliOptionSpec[] = [
    REPOSITORY_OPTION,
    { name: "path", type: "string", valueName: "path", description: "Repository-relative Wiki path" },
    { name: "slug", type: "string", valueName: "slug", description: "Wiki document slug" },
    { name: "title", type: "string", valueName: "title", description: "Wiki document title" },
    { name: "summary", type: "string", valueName: "text", description: "Wiki document summary" },
    { name: "content", type: "string", valueName: "text", description: "Wiki document body", conflictsWith: ["content-file", "content-stdin"] },
    { name: "content-file", type: "string", valueName: "path|-", description: "Read document body from a file or stdin", conflictsWith: ["content", "content-stdin"] },
    { name: "content-stdin", type: "boolean", description: "Read document body from stdin", conflictsWith: ["content", "content-file"] },
    { name: "tags", type: "string", valueName: "a,b", description: "Comma-separated tags" },
    { name: "ref", type: "string", valueName: "type:value", repeatable: true, description: "Citation reference" },
    { name: "source-revision", type: "string", valueName: "sha", description: "Source repository revision" },
    { name: "status", type: "string", valueName: "status", description: "Repository Wiki status" },
    { name: "status-message", type: "string", valueName: "text", description: "Repository Wiki status detail" },
    { name: "expected-version", type: "integer", valueName: "n", description: "Expected document version" },
  ];
  const repositoryRef = (invocation: CommandInvocation, positionalIndex?: number): string => {
    const value = stringOption(invocation, "repo")
      ?? (positionalIndex === undefined ? null : invocation.positionals[positionalIndex]?.trim() || null);
    if (!value) throw new CliError("usage", `--repo or <repository> is required for ${invocation.spec.path.join(" ")}`);
    return value;
  };
  const requestPath = async (invocation: CommandInvocation, ref: string, suffix = "") => {
    const client = await clientFor(invocation);
    const repository = await resolveRepository(client, requiredWorkspace(invocation), ref);
    return {
      client,
      path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repos/${encodePath(String(repository.id))}/wiki${suffix}`,
    };
  };
  return [
    spec("wiki.repository.list", ["wiki", "repository", "list"], "List repository Wiki status or documents", "read", [{ name: "repository", required: false }], [REPOSITORY_OPTION], async (invocation) => {
      const ref = stringOption(invocation, "repo") ?? invocation.positionals[0]?.trim() ?? null;
      if (!ref) {
        const client = await clientFor(invocation);
        const response = await client.request({ method: "GET", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repository-wikis` });
        renderResource(invocation, response.data, ["repositories"]);
        return;
      }
      const target = await requestPath(invocation, ref);
      const response = await target.client.request({ method: "GET", path: target.path, query: queryOptions(invocation) });
      renderResource(invocation, response.data, ["docs"]);
    }),
    spec("wiki.repository.get", ["wiki", "repository", "get"], "Get a repository Wiki document", "read", [refPositional("repository"), refPositional("document")], [], async (invocation) => {
      const target = await requestPath(invocation, repositoryRef(invocation, 0), `/${encodePath(positional(invocation, 1, "document"))}`);
      const response = await target.client.request({ method: "GET", path: target.path });
      renderResource(invocation, response.data);
    }),
    spec("wiki.repository.create", ["wiki", "repository", "create"], "Create a repository Wiki document", "write", [refPositional("repository")], [...INPUT_OPTIONS, ...fields], async (invocation) => {
      const target = await requestPath(invocation, repositoryRef(invocation, 0));
      const response = await target.client.request({ method: "POST", path: target.path, body: await repositoryWikiBody(invocation, true) });
      renderResource(invocation, response.data);
    }),
    spec("wiki.repository.update", ["wiki", "repository", "update"], "Update a repository Wiki document", "write", [refPositional("repository"), refPositional("document")], [...INPUT_OPTIONS, ...fields], async (invocation) => {
      const target = await requestPath(invocation, repositoryRef(invocation, 0), `/${encodePath(positional(invocation, 1, "document"))}`);
      const response = await target.client.request({ method: "PUT", path: target.path, body: await repositoryWikiBody(invocation, false) });
      renderResource(invocation, response.data);
    }),
    spec("wiki.repository.delete", ["wiki", "repository", "delete"], "Delete a repository Wiki document", "destructive", [refPositional("repository"), refPositional("document")], [YES_OPTION, { name: "expected-version", type: "integer", valueName: "n", description: "Expected document version" }], async (invocation) => {
      requireConfirmation(invocation);
      const target = await requestPath(invocation, repositoryRef(invocation, 0), `/${encodePath(positional(invocation, 1, "document"))}`);
      const response = await target.client.request({ method: "DELETE", path: target.path, query: { expected_version: integerOption(invocation, "expected-version") } });
      renderResource(invocation, response.data);
    }),
    spec("wiki.repository.revisions", ["wiki", "repository", "revisions"], "List repository Wiki document revisions", "read", [refPositional("repository"), refPositional("document")], [], async (invocation) => {
      const target = await requestPath(invocation, repositoryRef(invocation, 0), `/${encodePath(positional(invocation, 1, "document"))}/revisions`);
      const response = await target.client.request({ method: "GET", path: target.path });
      renderResource(invocation, response.data, ["revisions"]);
    }),
    spec("wiki.repository.build", ["wiki", "repository", "build"], "Build or refresh one repository Wiki", "destructive", [refPositional("repository")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const target = await requestPath(invocation, repositoryRef(invocation, 0), "/build");
      const response = await target.client.request({ method: "POST", path: target.path, body: {} });
      renderResource(invocation, response.data);
    }, [], ["human"]),
    spec("wiki.repository.atlas.status", ["wiki", "repository", "atlas", "status"], "Show Repository Wiki Atlas setup", "read", [], [], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repository-wikis/atlas` });
      renderResource(invocation, response.data);
    }, [], ["human"]),
    spec("wiki.repository.atlas.configure", ["wiki", "repository", "atlas", "configure"], "Configure Repository Wiki Atlas automations", "destructive", [], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repository-wikis/atlas`, body: {} });
      renderResource(invocation, response.data);
    }, [], ["human"]),
  ];
}

function kindSpecs(kind: KnowledgeKind): CommandSpec[] {
  const aliases = kind === "memory"
    ? {
        search: [{ path: ["memory", "recall"], deprecatedSince: "0.3.0", replacement: "remi memory search" }],
        get: [{ path: ["memory", "read"], deprecatedSince: "0.3.0", replacement: "remi memory get" }],
        create: [
          { path: ["memory", "remember"], deprecatedSince: "0.3.0", replacement: "remi memory create" },
          { path: ["memory", "add"], deprecatedSince: "0.3.0", replacement: "remi memory create" },
        ],
        delete: [{ path: ["memory", "forget"], deprecatedSince: "0.3.0", replacement: "remi memory delete" }],
      }
    : {
        search: [],
        get: [{ path: ["wiki", "read"], deprecatedSince: "0.3.0", replacement: "remi wiki get" }],
        create: [],
        delete: [],
      };
  const specs: CommandSpec[] = [
    spec(`${kind}.list`, [kind, "list"], `List ${kind} documents`, "read", [], [PROJECT_OPTION, ...PAGE_OPTIONS], async (invocation) => {
      const client = await clientFor(invocation);
      const projectRef = projectOption(invocation);
      const response = projectRef
        ? await projectRequest(invocation, client, projectRef, "GET", `/docs`, undefined, { kind, q: stringOption(invocation, "query"), limit: integerOption(invocation, "limit") })
        : await client.request({ method: "GET", path: "/api/project-docs", query: { workspace_id: requiredWorkspace(invocation), kind, q: stringOption(invocation, "query"), limit: integerOption(invocation, "limit") } });
      renderResource(invocation, response.data, ["docs"]);
    }),
    spec(`${kind}.search`, [kind, "search"], `Search ${kind} documents`, "read", [refPositional("query")], [PROJECT_OPTION, ...PAGE_OPTIONS], async (invocation) => {
      const client = await clientFor(invocation);
      const query = positional(invocation, 0, "query");
      const projectRef = projectOption(invocation);
      const response = projectRef
        ? await projectRequest(invocation, client, projectRef, "GET", "/knowledge/recall", undefined, { kind, q: query, limit: integerOption(invocation, "limit") })
        : await client.request({ method: "GET", path: "/api/project-docs", query: { workspace_id: requiredWorkspace(invocation), kind, q: query, limit: integerOption(invocation, "limit") } });
      renderResource(invocation, response.data, ["hits", "docs"]);
    }, aliases.search),
    spec(`${kind}.get`, [kind, "get"], `Get a ${kind} document`, "read", [refPositional("document")], [PROJECT_OPTION], async (invocation) => {
      const projectRef = requireProjectOption(invocation);
      const client = await clientFor(invocation);
      const response = await projectRequest(invocation, client, projectRef, "GET", `/docs/${encodePath(positional(invocation, 0, "document"))}`);
      renderResource(invocation, response.data);
    }, aliases.get),
    spec(`${kind}.create`, [kind, "create"], `Create a ${kind} document`, "write", [], [...INPUT_OPTIONS, ...KNOWLEDGE_FIELDS], async (invocation) => {
      const projectRef = requireProjectOption(invocation);
      const client = await clientFor(invocation);
      const body = await knowledgeBody(invocation, kind, true);
      if (typeof body.title !== "string" || !body.title.trim()) throw new CliError("usage", `${kind} title is required via --title or input JSON`);
      const response = await projectRequest(invocation, client, projectRef, "POST", "/docs", body);
      renderResource(invocation, response.data);
    }, aliases.create),
    spec(`${kind}.update`, [kind, "update"], `Update a ${kind} document`, "write", [refPositional("document")], [...INPUT_OPTIONS, ...KNOWLEDGE_FIELDS], async (invocation) => {
      const projectRef = requireProjectOption(invocation);
      const client = await clientFor(invocation);
      const body = await knowledgeBody(invocation, kind, false);
      if (!Object.keys(body).length) throw new CliError("usage", `${kind} update requires fields or input JSON`);
      const response = await projectRequest(invocation, client, projectRef, "PUT", `/docs/${encodePath(positional(invocation, 0, "document"))}`, body);
      renderResource(invocation, response.data);
    }),
    spec(`${kind}.delete`, [kind, "delete"], `Delete a ${kind} document`, "destructive", [refPositional("document")], [PROJECT_OPTION, YES_OPTION, { name: "expected-version", type: "integer", valueName: "n", description: "Expected document version" }], async (invocation) => {
      requireConfirmation(invocation);
      const projectRef = requireProjectOption(invocation);
      const client = await clientFor(invocation);
      const response = await projectRequest(invocation, client, projectRef, "DELETE", `/docs/${encodePath(positional(invocation, 0, "document"))}`, undefined, { expected_version: integerOption(invocation, "expected-version") });
      renderResource(invocation, response.data);
    }, aliases.delete),
    spec(`${kind}.backlinks`, [kind, "backlinks"], `List backlinks to a ${kind} document`, "read", [refPositional("document")], [PROJECT_OPTION], async (invocation) => {
      const projectRef = requireProjectOption(invocation);
      const client = await clientFor(invocation);
      const response = await projectRequest(invocation, client, projectRef, "GET", `/docs/${encodePath(positional(invocation, 0, "document"))}/backlinks`);
      renderResource(invocation, response.data, ["docs"]);
    }),
  ];
  if (kind === "wiki") {
    specs.push(spec("wiki.revisions", ["wiki", "revisions"], "List wiki document revisions", "read", [refPositional("document")], [PROJECT_OPTION], async (invocation) => {
      const projectRef = requireProjectOption(invocation);
      const client = await clientFor(invocation);
      const response = await projectRequest(invocation, client, projectRef, "GET", `/docs/${encodePath(positional(invocation, 0, "document"))}/revisions`);
      renderResource(invocation, response.data, ["revisions"]);
    }, [{ path: ["wiki", "history"], deprecatedSince: "0.3.0", replacement: "remi wiki revisions" }]));
  }
  return specs;
}

function migrationSpec(
  id: string,
  path: string[],
  description: string,
  method: "GET" | "POST",
  apiPath: string,
  aliases: NonNullable<CommandSpec["aliases"]>,
  extraOptions: readonly CliOptionSpec[] = [],
): CommandSpec {
  return spec(id, path, description, method === "GET" ? "read" : "write", [{ name: "project", required: false }], [PROJECT_OPTION, ...INPUT_OPTIONS, ...extraOptions], async (invocation) => {
    const client = await clientFor(invocation);
    const projectRef = projectOption(invocation, 0);
    const project = projectRef ? await resolveProject(client, requiredWorkspace(invocation), projectRef) : null;
    const body = method === "POST" ? await requestBody(invocation, {
      project_id: project?.id,
      workspace_id: requiredWorkspace(invocation),
      dry_run: booleanOption(invocation, "dry-run") ?? undefined,
      resume: booleanOption(invocation, "resume") ?? undefined,
    }) : undefined;
    const response = await client.request({ method, path: apiPath, query: method === "GET" ? { workspace_id: requiredWorkspace(invocation) } : undefined, body });
    renderResource(invocation, response.data);
  }, aliases, ["human"]);
}

function wikiWorkingCopySpecs(): CommandSpec[] {
  return (["pull", "status", "diff", "push"] as const).map((action) => spec(
    `wiki.${action}`,
    ["wiki", action],
    `${action[0]!.toUpperCase()}${action.slice(1)} the wiki working copy`,
    action === "status" || action === "diff" ? "read" : "write",
    [],
    [PROJECT_OPTION],
    async (invocation) => {
      const projectRef = requireProjectOption(invocation);
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), projectRef);
      const options = legacyOptions(invocation);
      if (action === "pull") await wikiPull(options, String(project.id));
      else if (action === "status") await wikiStatus(options, String(project.id));
      else if (action === "diff") await wikiDiff(options, String(project.id));
      else await wikiPush(options, String(project.id));
    },
  ));
}

async function projectRequest(
  invocation: CommandInvocation,
  client: Awaited<ReturnType<typeof clientFor>>,
  projectRef: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  suffix: string,
  body?: unknown,
  query?: Record<string, unknown>,
) {
  const project = await resolveProject(client, requiredWorkspace(invocation), projectRef);
  return client.request({
    method,
    path: `/api/projects/${encodePath(String(project.id))}${suffix}`,
    body,
    query: query as Record<string, string | number | boolean | null | undefined> | undefined,
  });
}

async function knowledgeBody(invocation: CommandInvocation, kind: KnowledgeKind, creating: boolean) {
  const contentFile = stringOption(invocation, "content-file");
  const content = invocation.options["content-stdin"] === true
    ? readFileSync(0, "utf8")
    : contentFile
    ? readFileSync(contentFile === "-" ? 0 : contentFile, "utf8")
    : rawOption(invocation, "content");
  const refs = stringOptions(invocation, "ref").flatMap((raw) => {
    const entry = raw.trim();
    if (!entry) return [];
    if (/^https?:\/\//i.test(entry)) return [{ type: "url", value: entry }];
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) throw new CliError("usage", "--ref expects type:value or an http(s) URL");
    return [{ type: entry.slice(0, separator), value: entry.slice(separator + 1) }];
  });
  return requestBody(invocation, {
    kind: creating ? kind : undefined,
    title: rawOption(invocation, "title"),
    slug: rawOption(invocation, "slug"),
    summary: "summary" in invocation.options ? rawOption(invocation, "summary") || null : undefined,
    body: content,
    tags: "tags" in invocation.options ? csvOption(invocation, "tags") ?? [] : undefined,
    pinned: booleanOption(invocation, "pinned") ?? (creating && kind === "memory" ? true : undefined),
    refs: "ref" in invocation.options ? refs : undefined,
    expected_version: integerOption(invocation, "expected-version") ?? undefined,
    source_task_id: creating && kind === "memory" ? process.env.MULTIREMI_TASK_ID?.trim() || undefined : undefined,
  });
}

async function repositoryWikiBody(invocation: CommandInvocation, creating: boolean): Promise<Record<string, unknown>> {
  const contentFile = stringOption(invocation, "content-file");
  const content = invocation.options["content-stdin"] === true
    ? readFileSync(0, "utf8")
    : contentFile
    ? readFileSync(contentFile === "-" ? 0 : contentFile, "utf8")
    : rawOption(invocation, "content");
  const refs = stringOptions(invocation, "ref").map((entry) => {
    const value = entry.trim();
    if (/^https?:\/\//i.test(value)) return { type: "url", value };
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1) throw new CliError("usage", "--ref expects type:value or an http(s) URL");
    return { type: value.slice(0, separator), value: value.slice(separator + 1) };
  });
  return requestBody(invocation, {
    path: rawOption(invocation, "path"),
    slug: rawOption(invocation, "slug"),
    title: rawOption(invocation, "title"),
    summary: "summary" in invocation.options ? rawOption(invocation, "summary") || null : undefined,
    body: content,
    tags: "tags" in invocation.options ? csvOption(invocation, "tags") ?? [] : undefined,
    refs: "ref" in invocation.options ? refs : undefined,
    source_revision: rawOption(invocation, "source-revision"),
    source_task_id: creating ? process.env.MULTIREMI_TASK_ID?.trim() || undefined : undefined,
    source_issue_id: creating ? process.env.MULTIREMI_ISSUE_ID?.trim() || undefined : undefined,
    status: creating ? undefined : rawOption(invocation, "status"),
    status_message: creating ? undefined : ("status-message" in invocation.options ? rawOption(invocation, "status-message") || null : undefined),
    expected_version: creating ? undefined : integerOption(invocation, "expected-version") ?? undefined,
  });
}

function rawOption(invocation: CommandInvocation, name: string): string | undefined {
  const value = invocation.options[name];
  return typeof value === "string" ? value : undefined;
}

function projectOption(invocation: CommandInvocation, positionalIndex?: number): string | null {
  return stringOption(invocation, "project")
    ?? (positionalIndex === undefined ? null : invocation.positionals[positionalIndex]?.trim() || null)
    ?? process.env.MULTIREMI_PROJECT_ID?.trim()
    ?? null;
}

function requireProjectOption(invocation: CommandInvocation): string {
  const project = projectOption(invocation);
  if (!project) throw new CliError("usage", `--project is required for ${invocation.spec.path.join(" ")}`);
  return project;
}

function legacyOptions(invocation: CommandInvocation): CliOptions {
  const options: CliOptions = {};
  for (const [key, value] of Object.entries(invocation.options)) {
    options[key] = Array.isArray(value) ? value.map(String) : typeof value === "boolean" ? value : String(value);
  }
  return options;
}

function group(kind: KnowledgeKind, description: string): CommandSpec {
  return { id: kind, path: [kind], description, parse: "passthrough", run: async () => { throw new CliError("usage", `usage: remi ${kind} list|search|get|create|update|delete|backlinks ...`); } };
}

function spec(
  id: string,
  path: string[],
  description: string,
  mutation: "read" | "write" | "destructive",
  positionals: CommandSpec["positionals"],
  options: readonly CliOptionSpec[],
  run: CommandSpec["run"],
  aliases: CommandSpec["aliases"] = [],
  auth: CommandSpec["auth"] = ["human", "task"],
): CommandSpec {
  return { id, path, description, capability: id, auth, mutation, outputs: ["table", "json", "jsonl"], positionals, options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []), aliases, run };
}

function refPositional(name: string) { return { name, required: true } as const; }
