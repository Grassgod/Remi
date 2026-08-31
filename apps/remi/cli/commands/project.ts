import { CliError, CliRenderer, ResourceResolver, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  booleanOption,
  clientFor,
  commandOptions,
  encodePath,
  extractRecords,
  integerOption,
  outputMode,
  positional,
  queryOptions,
  renderResource,
  requestBody,
  requireConfirmation,
  requiredWorkspace,
  stringOption,
  stringOptions,
} from "./resource-common.js";
import { resolveRepository } from "./repo.js";

const PROJECT_FIELDS: readonly CliOptionSpec[] = [
  { name: "title", type: "string", valueName: "title", description: "Project title" },
  { name: "description", type: "string", valueName: "text", description: "Project description" },
  { name: "instructions", type: "string", valueName: "text", description: "Project instructions" },
  { name: "icon", type: "string", valueName: "icon", description: "Project icon" },
  { name: "status", type: "string", valueName: "status", description: "Project status" },
  { name: "priority", type: "string", valueName: "priority", description: "Project priority" },
  { name: "lead", type: "string", valueName: "member-or-agent", description: "Project lead reference" },
  { name: "lead-type", type: "string", valueName: "member|agent", description: "Project lead type" },
  { name: "default-assignee", type: "string", valueName: "ref", description: "Default issue assignee" },
  { name: "default-assignee-type", type: "string", valueName: "agent|member|squad", description: "Default issue assignee type" },
  { name: "repo", type: "string", valueName: "repo", repeatable: true, description: "Associate an imported repository" },
  { name: "expected-version", type: "integer", valueName: "n", description: "Expected instructions revision" },
];

export function projectCommandSpecs(): CommandSpec[] {
  return [
    { id: "project", path: ["project"], description: "Manage projects and project resources", parse: "passthrough", run: async () => { throw new CliError("usage", "usage: remi project list|get|search|create|update|archive|restore|defaults|resource ..."); } },
    spec("project.list", ["project", "list"], "List projects", "read", ["human", "task"], [], PAGE_OPTIONS, async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: "/api/projects", query: { workspace_id: requiredWorkspace(invocation) } });
      renderResource(invocation, response.data, ["projects"]);
    }),
    spec("project.search", ["project", "search"], "Search projects", "read", ["human", "task"], [queryPositional()], PAGE_OPTIONS, async (invocation) => {
      const client = await clientFor(invocation);
      const query = invocation.positionals[0]?.trim() || stringOption(invocation, "query") || "";
      const response = await client.request({ method: "GET", path: "/api/projects/search", query: queryOptions(invocation, { workspace_id: requiredWorkspace(invocation), q: query }) });
      renderResource(invocation, response.data, ["projects"]);
    }),
    spec("project.get", ["project", "get"], "Get a project", "read", ["human", "task"], [refPositional("project")], PAGE_OPTIONS, async (invocation) => {
      const client = await clientFor(invocation);
      renderResource(invocation, await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project")));
    }),
    spec("project.defaults", ["project", "defaults"], "Show project issue defaults", "read", ["human", "task"], [refPositional("project")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
      const defaults = projectDefaultAssignee(project);
      new CliRenderer().render(defaults, {
        mode: outputMode(invocation),
        columns: [
          { header: "PROJECT", value: (row: Record<string, unknown>) => row.project_id, maxWidth: 28 },
          { header: "ASSIGNEE_TYPE", value: (row: Record<string, unknown>) => row.default_assignee_type, maxWidth: 16 },
          { header: "ASSIGNEE_ID", value: (row: Record<string, unknown>) => row.default_assignee_id, maxWidth: 28 },
        ],
      });
    }),
    spec("project.create", ["project", "create"], "Create a project", "write", ["human"], [], [...INPUT_OPTIONS, ...PROJECT_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const body = await projectBody(invocation, client, true);
      if (typeof body.title !== "string" || !body.title.trim()) throw new CliError("usage", "project title is required via --title or input JSON");
      const response = await client.request({ method: "POST", path: "/api/projects", body });
      renderResource(invocation, response.data);
    }),
    spec("project.update", ["project", "update"], "Update a project", "write", ["human"], [refPositional("project")], [...INPUT_OPTIONS, ...PROJECT_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
      const body = await projectBody(invocation, client, false);
      delete body.resources;
      if (!Object.keys(body).length) throw new CliError("usage", "project update requires fields or input JSON");
      const response = await client.request({ method: "PUT", path: `/api/projects/${encodePath(String(project.id))}`, body });
      renderResource(invocation, response.data);
    }),
    spec("project.archive", ["project", "archive"], "Archive a project", "destructive", ["human"], [refPositional("project")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
      const response = await client.request({ method: "DELETE", path: `/api/projects/${encodePath(String(project.id))}` });
      renderResource(invocation, response.data);
    }, [{ path: ["project", "delete"], deprecatedSince: "0.3.0", replacement: "remi project archive" }]),
    spec("project.restore", ["project", "restore"], "Restore an archived project", "write", ["human"], [refPositional("project")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
      const response = await client.request({ method: "POST", path: `/api/projects/${encodePath(String(project.id))}/restore`, body: {} });
      renderResource(invocation, response.data);
    }),
    resourceSpec("project.resource.list", ["project", "resource", "list"], "List project resources", "read", [], async (invocation, client, projectId) => {
      const response = await client.request({ method: "GET", path: `/api/projects/${encodePath(projectId)}/resources` });
      renderResource(invocation, response.data, ["resources"]);
    }),
    resourceSpec("project.resource.create", ["project", "resource", "create"], "Create a project resource", "write", INPUT_OPTIONS, async (invocation, client, projectId) => {
      const response = await client.request({ method: "POST", path: `/api/projects/${encodePath(projectId)}/resources`, body: await requestBody(invocation) });
      renderResource(invocation, response.data);
    }),
    resourceSpec("project.resource.update", ["project", "resource", "update"], "Update a project resource", "write", INPUT_OPTIONS, async (invocation, client, projectId) => {
      const resource = positional(invocation, 1, "resource");
      const response = await client.request({ method: "PUT", path: `/api/projects/${encodePath(projectId)}/resources/${encodePath(resource)}`, body: await requestBody(invocation) });
      renderResource(invocation, response.data);
    }, true),
    resourceSpec("project.resource.delete", ["project", "resource", "delete"], "Delete a project resource", "destructive", [YES_OPTION], async (invocation, client, projectId) => {
      requireConfirmation(invocation);
      const resource = positional(invocation, 1, "resource");
      const response = await client.request({ method: "DELETE", path: `/api/projects/${encodePath(projectId)}/resources/${encodePath(resource)}` });
      renderResource(invocation, response.data);
    }, true),
    spec("project.device.list", ["project", "device", "list"], "List devices allowed to run a project", "read", ["human", "task"], [refPositional("project")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
      const response = await client.request({ method: "GET", path: `/api/projects/${encodePath(String(project.id))}/devices` });
      renderResource(invocation, response.data, ["devices"]);
    }),
    spec("project.device.add", ["project", "device", "add"], "Allow a device to run a project", "write", ["human"], [refPositional("project"), refPositional("daemon")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
      const response = await client.request({
        method: "POST",
        path: `/api/projects/${encodePath(String(project.id))}/devices`,
        body: { daemon_id: positional(invocation, 1, "daemon") },
      });
      renderResource(invocation, response.data);
    }),
    spec(
      "project.device.set",
      ["project", "device", "set"],
      "Atomically replace the devices allowed to run a project",
      "write",
      ["human"],
      [refPositional("project")],
      [
        { name: "daemon", type: "string", valueName: "daemon", repeatable: true, description: "Allowed daemon ID" },
        { name: "clear", type: "boolean", description: "Remove all restrictions and allow any device" },
      ],
      async (invocation) => {
        const daemonIds = [...new Set(stringOptions(invocation, "daemon").map((value) => value.trim()).filter(Boolean))];
        const clear = booleanOption(invocation, "clear") === true;
        if (clear && daemonIds.length > 0) {
          throw new CliError("usage", "project device set accepts either --daemon or --clear, not both");
        }
        if (!clear && daemonIds.length === 0) {
          throw new CliError("usage", "project device set requires at least one --daemon or --clear");
        }
        const client = await clientFor(invocation);
        const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
        const response = await client.request({
          method: "PUT",
          path: `/api/projects/${encodePath(String(project.id))}/devices`,
          body: { daemon_ids: clear ? [] : daemonIds },
        });
        renderResource(invocation, response.data, ["devices"]);
      },
    ),
    spec("project.device.remove", ["project", "device", "remove"], "Remove a project device restriction", "destructive", ["human"], [refPositional("project"), refPositional("daemon")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
      const response = await client.request({
        method: "DELETE",
        path: `/api/projects/${encodePath(String(project.id))}/devices/${encodePath(positional(invocation, 1, "daemon"))}`,
      });
      renderResource(invocation, response.data);
    }),
  ];
}

export async function resolveProject(
  client: Awaited<ReturnType<typeof clientFor>>,
  workspaceId: string,
  ref: string,
): Promise<Record<string, unknown>> {
  return new ResourceResolver<Record<string, unknown>>({
    kind: "project",
    getById: async (id) => {
      try {
        const response = await client.request<Record<string, unknown>>({ method: "GET", path: `/api/projects/${encodePath(id)}` });
        return response.data;
      } catch (error) {
        if (error instanceof CliError && error.code === "not_found") return null;
        throw error;
      }
    },
    search: async (query) => {
      const response = await client.request<unknown>({ method: "GET", path: "/api/projects/search", query: { workspace_id: workspaceId, q: query, include_closed: true } });
      const records = extractRecords(response.data, ["projects"]);
      if (records.length) return records;
      // Text search does not match project ids. Fall back to the workspace list,
      // which carries each project's summary (including the default assignee),
      // so id/name resolution also works against older servers.
      const listed = await client.request<unknown>({ method: "GET", path: "/api/projects", query: { workspace_id: workspaceId } });
      return extractRecords(listed.data, ["projects"]);
    },
    id: (project) => String(project.id ?? ""),
    name: (project) => typeof project.name === "string" ? project.name : typeof project.title === "string" ? project.title : null,
  }).resolve(ref);
}

export function projectDefaultAssignee(project: Record<string, unknown>): Record<string, unknown> {
  return {
    project_id: project.id ?? null,
    default_assignee_type: project.default_assignee_type ?? project.defaultAssigneeType ?? null,
    default_assignee_id: project.default_assignee_id ?? project.defaultAssigneeId ?? null,
  };
}

async function projectBody(
  invocation: CommandInvocation,
  client: Awaited<ReturnType<typeof clientFor>>,
  includeResources: boolean,
): Promise<Record<string, unknown>> {
  const repos = includeResources
    ? await Promise.all(stringOptions(invocation, "repo").map((ref) => resolveRepository(client, requiredWorkspace(invocation), ref)))
    : [];
  return requestBody(invocation, {
    workspace_id: includeResources ? requiredWorkspace(invocation) : undefined,
    title: stringOption(invocation, "title") ?? undefined,
    description: stringOption(invocation, "description") ?? undefined,
    instructions: stringOption(invocation, "instructions") ?? undefined,
    icon: stringOption(invocation, "icon") ?? undefined,
    status: stringOption(invocation, "status") ?? undefined,
    priority: stringOption(invocation, "priority") ?? undefined,
    lead_id: stringOption(invocation, "lead") ?? undefined,
    lead_type: stringOption(invocation, "lead-type") ?? undefined,
    default_assignee_id: stringOption(invocation, "default-assignee") ?? undefined,
    default_assignee_type: stringOption(invocation, "default-assignee-type") ?? undefined,
    expected_instructions_revision: integerOption(invocation, "expected-version") ?? undefined,
    resources: repos.length ? repos.map((repo) => ({ resource_type: "github_repo", resource_ref: { url: repo.url } })) : undefined,
  });
}

function spec(
  id: string,
  path: string[],
  description: string,
  mutation: "read" | "write" | "destructive",
  auth: CommandSpec["auth"],
  positionals: CommandSpec["positionals"],
  options: readonly CliOptionSpec[],
  run: CommandSpec["run"],
  aliases: CommandSpec["aliases"] = [],
): CommandSpec {
  return { id, path, description, capability: id, auth, mutation, outputs: ["table", "json", "jsonl"], positionals, options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []), aliases, run };
}

function resourceSpec(
  id: string,
  path: string[],
  description: string,
  mutation: "read" | "write" | "destructive",
  options: readonly CliOptionSpec[],
  execute: (invocation: CommandInvocation, client: Awaited<ReturnType<typeof clientFor>>, projectId: string) => Promise<void>,
  resourcePositional = false,
): CommandSpec {
  return spec(id, path, description, mutation, mutation === "read" ? ["human", "task"] : ["human"], [
    refPositional("project"),
    ...(resourcePositional ? [refPositional("resource")] : []),
  ], options, async (invocation) => {
    const client = await clientFor(invocation);
    const project = await resolveProject(client, requiredWorkspace(invocation), positional(invocation, 0, "project"));
    await execute(invocation, client, String(project.id));
  });
}

function refPositional(name: string) { return { name, required: true } as const; }
function queryPositional() { return { name: "query", required: false } as const; }
