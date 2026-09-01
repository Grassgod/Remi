import { readFileSync } from "node:fs";
import { CliError, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
import type { CliOptions } from "../multiremi/options.js";
import { wikiDiff, wikiMove, wikiPull, wikiPush, wikiStatus } from "../multiremi/commands/wiki-working-copy.js";
import { wikiLint, wikiMerge } from "../multiremi/commands/wiki-librarian.js";
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
  { name: "path", type: "string", valueName: "path", description: "Workspace-relative Markdown path" },
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
    group("knowledge", "Submit and inspect raw knowledge compilation work"),
    ...knowledgeControlPlaneSpecs(),
    group("memory", "Recall and maintain project memory"),
    group("wiki", "Search and maintain project wiki pages"),
    ...kindSpecs("memory"),
    ...kindSpecs("wiki"),
    publishSpec("memory"),
    publishSpec("wiki"),
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

function knowledgeControlPlaneSpecs(): CommandSpec[] {
  const scopeOptions: readonly CliOptionSpec[] = [
    PROJECT_OPTION,
    REPOSITORY_OPTION,
    { name: "scope", type: "string", valueName: "project_wiki|repository_wiki|memory", description: "Knowledge target scope" },
    { name: "status", type: "string", valueName: "status", description: "Submission or run status" },
  ];
  return [
    spec("knowledge.submit", ["knowledge", "submit"], "Submit raw knowledge for Atlas compilation", "write", [], [
      ...INPUT_OPTIONS,
      ...scopeOptions,
      { name: "path", type: "string", valueName: "path", description: "Proposed Wiki path" },
      { name: "slug", type: "string", valueName: "slug", description: "Proposed Memory or Wiki slug" },
      { name: "content", type: "string", valueName: "text", description: "Raw body", conflictsWith: ["content-file", "content-stdin"] },
      { name: "content-file", type: "string", valueName: "path|-", description: "Read raw body from a file or stdin", conflictsWith: ["content", "content-stdin"] },
      { name: "content-stdin", type: "boolean", description: "Read raw body from stdin", conflictsWith: ["content", "content-file"] },
      { name: "patch", type: "string", valueName: "text", description: "Optional raw patch" },
      { name: "base-revision", type: "string", valueName: "revision", description: "Revision on which the proposal is based" },
    ], async (invocation) => {
      const client = await clientFor(invocation);
      const scope = stringOption(invocation, "scope");
      const project = await resolvedProjectOption(invocation, client);
      const repository = await resolvedRepositoryOption(invocation, client);
      const body = await requestBody(invocation, {
        workspace_id: requiredWorkspace(invocation),
        project_id: project?.id,
        repository_id: repository?.id,
        scope: scope ?? undefined,
        proposed_path: rawOption(invocation, "path"),
        proposed_slug: rawOption(invocation, "slug"),
        body: readContentOption(invocation),
        patch: rawOption(invocation, "patch"),
        base_revision: rawOption(invocation, "base-revision"),
      });
      if (typeof body.scope !== "string" || !body.scope.trim()) throw new CliError("usage", "knowledge submit requires --scope or input JSON");
      const response = await client.request({ method: "POST", path: "/api/knowledge/submissions", body });
      renderResource(invocation, response.data, ["submission"]);
    }),
    spec("knowledge.submissions", ["knowledge", "submissions"], "List raw knowledge submissions", "read", [], [...scopeOptions, ...PAGE_OPTIONS], async (invocation) => {
      const client = await clientFor(invocation);
      const project = await resolvedProjectOption(invocation, client);
      const repository = await resolvedRepositoryOption(invocation, client);
      const response = await client.request({
        method: "GET",
        path: "/api/knowledge/submissions",
        query: queryOptions(invocation, {
          workspace_id: requiredWorkspace(invocation),
          project_id: project?.id,
          repository_id: repository?.id,
          scope: stringOption(invocation, "scope"),
          status: stringOption(invocation, "status"),
        }),
      });
      renderResource(invocation, response.data, ["submissions"]);
    }),
    spec("knowledge.inspect", ["knowledge", "inspect"], "Inspect one raw knowledge submission", "read", [refPositional("submission")], [], async (invocation) => {
      const response = await (await clientFor(invocation)).request({
        method: "GET",
        path: `/api/knowledge/submissions/${encodePath(positional(invocation, 0, "submission"))}`,
      });
      renderResource(invocation, response.data, ["submission"]);
    }),
    spec("knowledge.runs", ["knowledge", "runs"], "List knowledge compilation runs", "read", [], [PROJECT_OPTION, REPOSITORY_OPTION, { name: "status", type: "string", valueName: "status", description: "Compilation run status" }, ...PAGE_OPTIONS], async (invocation) => {
      const client = await clientFor(invocation);
      const project = await resolvedProjectOption(invocation, client);
      const repository = await resolvedRepositoryOption(invocation, client);
      const response = await client.request({
        method: "GET",
        path: "/api/knowledge/runs",
        query: queryOptions(invocation, {
          workspace_id: requiredWorkspace(invocation),
          project_id: project?.id,
          repository_id: repository?.id,
          status: stringOption(invocation, "status"),
        }),
      });
      renderResource(invocation, response.data, ["runs"]);
    }),
    spec("knowledge.run.show", ["knowledge", "run", "show"], "Show a knowledge compilation run and its provenance", "read", [refPositional("run")], [], async (invocation) => {
      const response = await (await clientFor(invocation)).request({
        method: "GET",
        path: `/api/knowledge/runs/${encodePath(positional(invocation, 0, "run"))}`,
      });
      renderResource(invocation, response.data);
    }),
    spec("knowledge.migrate-legacy", ["knowledge", "migrate-legacy"], "Copy legacy Wiki and Memory into raw submissions", "write", [], [
      PROJECT_OPTION,
      REPOSITORY_OPTION,
      { name: "batch-size", type: "integer", valueName: "n", description: "Maximum legacy documents to inspect" },
      { name: "dry-run", type: "boolean", description: "Count candidates without writing" },
      { name: "execute", type: "boolean", description: "Create idempotent raw submissions" },
    ], async (invocation) => {
      const dryRun = booleanOption(invocation, "dry-run") === true;
      const execute = booleanOption(invocation, "execute") === true;
      if (dryRun === execute) throw new CliError("usage", "knowledge migrate-legacy requires exactly one of --dry-run or --execute");
      const client = await clientFor(invocation);
      const project = await resolvedProjectOption(invocation, client);
      const repository = await resolvedRepositoryOption(invocation, client);
      const response = await client.request({
        method: "POST",
        path: "/api/knowledge/migrate-legacy",
        body: {
          workspace_id: requiredWorkspace(invocation),
          project_id: project?.id,
          repository_id: repository?.id,
          batch_size: integerOption(invocation, "batch-size") ?? undefined,
          dry_run: dryRun,
          execute,
        },
      });
      renderResource(invocation, response.data);
    }, [], ["human", "task"]),
  ];
}

function publishSpec(kind: KnowledgeKind): CommandSpec {
  return spec(`${kind}.publish`, [kind, "publish"], `Publish curated ${kind} from raw submissions`, "write", [], [
    ...INPUT_OPTIONS,
    PROJECT_OPTION,
    ...(kind === "wiki" ? [REPOSITORY_OPTION] : []),
    { name: "submission", type: "string", valueName: "id", repeatable: true, description: "Raw submission ID; repeat for many inputs" },
    { name: "dedupe-key", type: "string", valueName: "key", description: "Idempotency key for this compilation" },
    { name: "action", type: "string", valueName: "create|update|merge|split|reject|noop", description: "Compilation output action" },
    { name: "document", type: "string", valueName: "id|slug|path", description: "Existing document for update or merge" },
    ...KNOWLEDGE_FIELDS,
  ], async (invocation) => {
    const client = await clientFor(invocation);
    const repository = kind === "wiki" ? await resolvedRepositoryOption(invocation, client) : null;
    const project = repository ? null : await resolvedProjectOption(invocation, client, true);
    const body = await publishBody(invocation, kind);
    const response = repository
      ? await client.request({
          method: "POST",
          path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repos/${encodePath(String(repository.id))}/wiki/publish`,
          body,
        })
      : await client.request({
          method: "POST",
          path: `/api/projects/${encodePath(String(project!.id))}/knowledge/publish`,
          body,
        });
    renderResource(invocation, response.data, ["outputs"]);
  }, [], ["task"]);
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
      if (kind === "memory" && (typeof body.body !== "string" || !body.body.trim())) {
        throw new CliError("usage", "memory body is required via --content, --content-file, --content-stdin, or input JSON");
      }
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
  const specs = (["pull", "status", "diff", "push"] as const).map((action) => spec(
    `wiki.${action}`,
    ["wiki", action],
    `${action[0]!.toUpperCase()}${action.slice(1)} the wiki working copy`,
    action === "status" || action === "diff" ? "read" : "write",
    [],
    [PROJECT_OPTION],
    async (invocation) => {
      const projectRef = action === "pull" || action === "diff"
        ? requireProjectOption(invocation)
        : projectOption(invocation);
      const project = projectRef
        ? await resolveProject(await clientFor(invocation), requiredWorkspace(invocation), projectRef)
        : null;
      const projectId = project ? String(project.id) : null;
      const options = legacyOptions(invocation);
      if (action === "pull") await wikiPull(options, projectId!);
      else if (action === "status") await wikiStatus(options, projectId);
      else if (action === "diff") await wikiDiff(options, projectId!);
      else await wikiPush(options, projectId);
    },
  ));
  specs.push(spec(
    "wiki.mv",
    ["wiki", "mv"],
    "Move a Wiki page without changing its identity",
    "write",
    [refPositional("document"), { name: "new-path", required: true }],
    [PROJECT_OPTION],
    async (invocation) => {
      const projectRef = projectOption(invocation);
      const project = projectRef
        ? await resolveProject(await clientFor(invocation), requiredWorkspace(invocation), projectRef)
        : null;
      await wikiMove(
        legacyOptions(invocation),
        project ? String(project.id) : null,
        positional(invocation, 0, "document"),
        positional(invocation, 1, "new-path"),
      );
    },
  ));
  specs.push(spec(
    "wiki.lint",
    ["wiki", "lint"],
    "Report duplicate, contradictory, orphaned, and broken-link Wiki pages",
    "read",
    [],
    [PROJECT_OPTION],
    async (invocation) => {
      const project = await resolveProject(
        await clientFor(invocation),
        requiredWorkspace(invocation),
        requireProjectOption(invocation),
      );
      await wikiLint(legacyOptions(invocation), String(project.id));
    },
  ));
  specs.push(spec(
    "wiki.merge",
    ["wiki", "merge"],
    "Merge source Wiki pages into a target and preserve their references",
    "destructive",
    [refPositional("target"), { name: "source", required: true, variadic: true }],
    [PROJECT_OPTION, YES_OPTION],
    async (invocation) => {
      requireConfirmation(invocation);
      const project = await resolveProject(
        await clientFor(invocation),
        requiredWorkspace(invocation),
        requireProjectOption(invocation),
      );
      await wikiMerge(
        legacyOptions(invocation),
        String(project.id),
        positional(invocation, 0, "target"),
        invocation.positionals.slice(1),
      );
    },
  ));
  return specs;
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

async function publishBody(invocation: CommandInvocation, kind: KnowledgeKind): Promise<Record<string, unknown>> {
  const submissionIds = stringOptions(invocation, "submission");
  const body = await requestBody(invocation, {
    submission_ids: submissionIds.length ? submissionIds : undefined,
    dedupe_key: rawOption(invocation, "dedupe-key"),
  });
  if (Array.isArray(body.outputs) || (body.output && typeof body.output === "object")) return body;
  body.output = {
    action: rawOption(invocation, "action") ?? "create",
    ref: rawOption(invocation, "document"),
    kind,
    title: rawOption(invocation, "title"),
    slug: rawOption(invocation, "slug"),
    path: rawOption(invocation, "path"),
    summary: "summary" in invocation.options ? rawOption(invocation, "summary") || null : undefined,
    body: readContentOption(invocation),
    tags: "tags" in invocation.options ? csvOption(invocation, "tags") ?? [] : undefined,
    pinned: booleanOption(invocation, "pinned") ?? (kind === "memory" ? true : undefined),
    refs: "ref" in invocation.options ? referenceOptions(invocation) : undefined,
    expected_version: integerOption(invocation, "expected-version") ?? undefined,
  };
  return body;
}

async function resolvedProjectOption(
  invocation: CommandInvocation,
  client: Awaited<ReturnType<typeof clientFor>>,
  required = false,
) {
  const ref = projectOption(invocation);
  if (!ref) {
    if (required) throw new CliError("usage", `--project is required for ${invocation.spec.path.join(" ")}`);
    return null;
  }
  return resolveProject(client, requiredWorkspace(invocation), ref);
}

async function resolvedRepositoryOption(
  invocation: CommandInvocation,
  client: Awaited<ReturnType<typeof clientFor>>,
) {
  const ref = stringOption(invocation, "repo");
  return ref ? resolveRepository(client, requiredWorkspace(invocation), ref) : null;
}

function readContentOption(invocation: CommandInvocation): string | undefined {
  const contentFile = stringOption(invocation, "content-file");
  if (invocation.options["content-stdin"] === true) return readFileSync(0, "utf8");
  if (contentFile) return readFileSync(contentFile === "-" ? 0 : contentFile, "utf8");
  return rawOption(invocation, "content");
}

function referenceOptions(invocation: CommandInvocation): Array<{ type: string; value: string }> {
  return stringOptions(invocation, "ref").flatMap((raw) => {
    const entry = raw.trim();
    if (!entry) return [];
    if (/^https?:\/\//i.test(entry)) return [{ type: "url", value: entry }];
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) throw new CliError("usage", "--ref expects type:value or an http(s) URL");
    return [{ type: entry.slice(0, separator), value: entry.slice(separator + 1) }];
  });
}

async function knowledgeBody(invocation: CommandInvocation, kind: KnowledgeKind, creating: boolean) {
  return requestBody(invocation, {
    kind: creating ? kind : undefined,
    title: rawOption(invocation, "title"),
    slug: rawOption(invocation, "slug"),
    path: rawOption(invocation, "path"),
    summary: "summary" in invocation.options ? rawOption(invocation, "summary") || null : undefined,
    body: readContentOption(invocation),
    tags: "tags" in invocation.options ? csvOption(invocation, "tags") ?? [] : undefined,
    pinned: booleanOption(invocation, "pinned") ?? (creating && kind === "memory" ? true : undefined),
    refs: "ref" in invocation.options ? referenceOptions(invocation) : undefined,
    expected_version: integerOption(invocation, "expected-version") ?? undefined,
    source_task_id: creating && kind === "memory" ? process.env.MULTIREMI_TASK_ID?.trim() || undefined : undefined,
  });
}

async function repositoryWikiBody(invocation: CommandInvocation, creating: boolean): Promise<Record<string, unknown>> {
  return requestBody(invocation, {
    path: rawOption(invocation, "path"),
    slug: rawOption(invocation, "slug"),
    title: rawOption(invocation, "title"),
    summary: "summary" in invocation.options ? rawOption(invocation, "summary") || null : undefined,
    body: readContentOption(invocation),
    tags: "tags" in invocation.options ? csvOption(invocation, "tags") ?? [] : undefined,
    refs: "ref" in invocation.options ? referenceOptions(invocation) : undefined,
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

function group(kind: KnowledgeKind | "knowledge", description: string): CommandSpec {
  const usage = kind === "knowledge"
    ? "submit|submissions|inspect|runs|run show|migrate-legacy"
    : "list|search|get|create|update|delete|backlinks|publish";
  return { id: kind, path: [kind], description, parse: "passthrough", run: async () => { throw new CliError("usage", `usage: remi ${kind} ${usage} ...`); } };
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
