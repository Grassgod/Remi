import {
  CliError,
  ResourceResolver,
  type CliOptionSpec,
  type CommandInvocation,
  type CommandSpec,
} from "../core/index.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  clientFor,
  commandOptions,
  encodePath,
  extractRecords,
  integerOption,
  positional,
  renderResource,
  requestBody,
  requireConfirmation,
  stringOption,
  stringOptions,
} from "./resource-common.js";

const WORKSPACE_FIELDS: readonly CliOptionSpec[] = [
  { name: "name", type: "string", valueName: "name", description: "Workspace name" },
  { name: "slug", type: "string", valueName: "slug", description: "Workspace slug" },
  { name: "description", type: "string", valueName: "text", description: "Workspace description" },
  { name: "context", type: "string", valueName: "text", description: "Workspace context" },
  { name: "issue-prefix", type: "string", valueName: "prefix", description: "Issue key prefix" },
];

export function workspaceCommandSpecs(): CommandSpec[] {
  return [
    groupSpec(),
    readSpec("workspace.list", ["workspace", "list"], "List workspaces", [], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: "/api/workspaces" });
      renderResource(invocation, response.data, ["workspaces"]);
    }),
    readSpec("workspace.get", ["workspace", "get"], "Get a workspace", [refPositional("workspace")], async (invocation) => {
      const client = await clientFor(invocation);
      const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
      renderResource(invocation, workspace);
    }),
    writeSpec("workspace.create", ["workspace", "create"], "Create a workspace", [], WORKSPACE_FIELDS, async (invocation) => {
      const body = await workspaceBody(invocation);
      if (typeof body.name !== "string" || !body.name.trim()) throw new CliError("usage", "workspace name is required via --name or input JSON");
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: "/api/workspaces", body });
      renderResource(invocation, response.data);
    }),
    writeSpec("workspace.update", ["workspace", "update"], "Update a workspace", [refPositional("workspace")], WORKSPACE_FIELDS, async (invocation) => {
      const client = await clientFor(invocation);
      const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
      const body = await workspaceBody(invocation);
      if (!Object.keys(body).length) throw new CliError("usage", "workspace update requires fields or input JSON");
      const response = await client.request({ method: "PATCH", path: `/api/workspaces/${encodePath(String(workspace.id))}`, body });
      renderResource(invocation, response.data);
    }),
    destructiveSpec("workspace.delete", ["workspace", "delete"], "Delete a workspace", [refPositional("workspace")], async (invocation) => {
      const client = await clientFor(invocation);
      const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
      const response = await client.request({ method: "DELETE", path: `/api/workspaces/${encodePath(String(workspace.id))}` });
      renderResource(invocation, response.data);
    }),
    destructiveSpec("workspace.leave", ["workspace", "leave"], "Leave a workspace", [refPositional("workspace")], async (invocation) => {
      const client = await clientFor(invocation);
      const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
      const response = await client.request({ method: "POST", path: `/api/workspaces/${encodePath(String(workspace.id))}/leave`, body: {} });
      renderResource(invocation, response.data);
    }),
    scopedRead("workspace.env.get", ["workspace", "env", "get"], "Read workspace environment", "/env"),
    scopedWrite("workspace.env.update", ["workspace", "env", "update"], "Replace workspace environment", "/env", "PUT", [
      { name: "set", type: "string", valueName: "key=value", repeatable: true, description: "Set an environment entry" },
    ], envBody),
    scopedRead("workspace.ssh-mesh.get", ["workspace", "ssh-mesh", "get"], "Read SSH mesh settings", "/ssh-mesh"),
    scopedWrite("workspace.ssh-mesh.update", ["workspace", "ssh-mesh", "update"], "Update SSH mesh settings", "/ssh-mesh", "PUT"),
    scopedWrite("workspace.ssh-mesh.rotate", ["workspace", "ssh-mesh", "rotate"], "Rotate SSH mesh key material", "/ssh-mesh/rotate", "POST"),
    scopedWrite("workspace.ssh-mesh.test", ["workspace", "ssh-mesh", "test"], "Test SSH mesh connectivity", "/ssh-mesh/test", "POST"),
    scopedRead("workspace.relay.get", ["workspace", "relay", "get"], "Read relay configuration", "/relay-config"),
    scopedWrite("workspace.relay.discovery", ["workspace", "relay", "discovery"], "Update relay discovery settings", "/relay-config/discovery", "PUT"),
    scopedWrite("workspace.relay.update", ["workspace", "relay", "update"], "Update a relay engine", "/relay-config/:engine", "PUT", [refPositional("engine")]),
    scopedWrite("workspace.relay.reveal", ["workspace", "relay", "reveal"], "Reveal a relay engine credential", "/relay-config/:engine/reveal", "POST", [refPositional("engine")]),
    scopedRead("workspace.prompt.get", ["workspace", "prompt", "get"], "Read workspace prompt appendices", "/prompts"),
    scopedRead("workspace.prompt.template", ["workspace", "prompt", "template"], "Read the platform prompt template", "/prompt-template"),
    scopedWrite("workspace.prompt.update", ["workspace", "prompt", "update"], "Update workspace prompt appendices", "/prompts", "PUT", [
      { name: "bootstrap-prompt", type: "string", valueName: "text", description: "Bootstrap prompt appendix" },
      { name: "delta-prompt", type: "string", valueName: "text", description: "Delta prompt appendix" },
      { name: "expected-revision", type: "integer", valueName: "n", description: "Expected prompt revision" },
    ], promptBody),
    scopedRead("workspace.issue-archive.get", ["workspace", "issue-archive", "get"], "Read issue archive retention settings", "/issue-archive"),
    scopedWrite("workspace.issue-archive.update", ["workspace", "issue-archive", "update"], "Update issue archive retention settings", "/issue-archive", "PUT", [
      { name: "ttl-ms", type: "integer", valueName: "ms", description: "Archive retention duration" },
      { name: "sweep-interval-ms", type: "integer", valueName: "ms", description: "Archive sweep interval" },
    ], issueArchiveBody),
  ];
}

export async function resolveWorkspace(
  client: Awaited<ReturnType<typeof clientFor>>,
  ref: string,
): Promise<Record<string, unknown>> {
  return new ResourceResolver<Record<string, unknown>>({
    kind: "workspace",
    getById: async (id) => {
      try {
        const response = await client.request<Record<string, unknown>>({ method: "GET", path: `/api/workspaces/${encodePath(id)}` });
        return response.data;
      } catch (error) {
        if (error instanceof CliError && error.code === "not_found") return null;
        throw error;
      }
    },
    search: async () => {
      const response = await client.request<unknown>({ method: "GET", path: "/api/workspaces" });
      return extractRecords(response.data, ["workspaces"]);
    },
    id: (workspace) => String(workspace.id ?? ""),
    name: (workspace) => typeof workspace.name === "string" ? workspace.name : typeof workspace.slug === "string" ? workspace.slug : null,
  }).resolve(ref);
}

function groupSpec(): CommandSpec {
  return {
    id: "workspace",
    path: ["workspace"],
    description: "Manage workspaces and workspace settings",
    parse: "passthrough",
    run: async () => { throw new CliError("usage", "usage: remi workspace list|get|create|update|delete|leave|env|ssh-mesh|relay ..."); },
  };
}

function readSpec(
  id: string,
  path: string[],
  description: string,
  positionals: CommandSpec["positionals"],
  run: CommandSpec["run"],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth: ["human"],
    mutation: "read",
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions(PAGE_OPTIONS),
    run,
  };
}

function writeSpec(
  id: string,
  path: string[],
  description: string,
  positionals: CommandSpec["positionals"],
  fields: readonly CliOptionSpec[],
  run: CommandSpec["run"],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth: ["human"],
    mutation: "write",
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions(INPUT_OPTIONS, fields),
    run,
  };
}

function destructiveSpec(
  id: string,
  path: string[],
  description: string,
  positionals: CommandSpec["positionals"],
  execute: CommandSpec["run"],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth: ["human"],
    mutation: "destructive",
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions([YES_OPTION]),
    run: async (invocation) => {
      requireConfirmation(invocation);
      await execute(invocation);
    },
  };
}

function scopedRead(id: string, path: string[], description: string, suffix: string): CommandSpec {
  return readSpec(id, path, description, [refPositional("workspace")], async (invocation) => {
    const client = await clientFor(invocation);
    const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
    const response = await client.request({ method: "GET", path: `/api/workspaces/${encodePath(String(workspace.id))}${suffix}` });
    renderResource(invocation, response.data);
  });
}

function scopedWrite(
  id: string,
  path: string[],
  description: string,
  suffix: string,
  method: "POST" | "PUT",
  extra: readonly (CliOptionSpec | ReturnType<typeof refPositional>)[] = [],
  bodyBuilder: (invocation: CommandInvocation) => Promise<Record<string, unknown>> = requestBody,
): CommandSpec {
  const positionalFields = extra.filter((field): field is ReturnType<typeof refPositional> => "required" in field && !("type" in field));
  const options = extra.filter((field): field is CliOptionSpec => "type" in field);
  return {
    id,
    path,
    description,
    capability: id,
    auth: ["human"],
    mutation: "write",
    outputs: ["table", "json", "jsonl"],
    positionals: [refPositional("workspace"), ...positionalFields],
    options: commandOptions(INPUT_OPTIONS, options),
    run: async (invocation) => {
      const client = await clientFor(invocation);
      const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
      const engine = positionalFields.length ? positional(invocation, 1, positionalFields[0]!.name) : "";
      const scopedSuffix = suffix.replace(":engine", encodePath(engine));
      const body = await bodyBuilder(invocation);
      const response = await client.request({ method, path: `/api/workspaces/${encodePath(String(workspace.id))}${scopedSuffix}`, body });
      renderResource(invocation, response.data);
    },
  };
}

async function workspaceBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  return requestBody(invocation, {
    name: stringOption(invocation, "name") ?? undefined,
    slug: stringOption(invocation, "slug") ?? undefined,
    description: stringOption(invocation, "description") ?? undefined,
    context: stringOption(invocation, "context") ?? undefined,
    issue_prefix: stringOption(invocation, "issue-prefix") ?? undefined,
  });
}

async function envBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  const body = await requestBody(invocation);
  const pairs = stringOptions(invocation, "set");
  if (!pairs.length) return body;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new CliError("usage", "--set expects key=value");
    env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return { ...body, env };
}

async function promptBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  return requestBody(invocation, {
    bootstrap_prompt: rawStringOption(invocation, "bootstrap-prompt"),
    delta_prompt: rawStringOption(invocation, "delta-prompt"),
    expected_revision: integerOption(invocation, "expected-revision") ?? undefined,
  });
}

async function issueArchiveBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  const ttlMs = integerOption(invocation, "ttl-ms");
  const sweepIntervalMs = integerOption(invocation, "sweep-interval-ms");
  const body = await requestBody(invocation, {
    ttl_ms: ttlMs ?? undefined,
    sweep_interval_ms: sweepIntervalMs ?? undefined,
  });
  if (!Number.isSafeInteger(body.ttl_ms) || !Number.isSafeInteger(body.sweep_interval_ms)) {
    throw new CliError("usage", "workspace issue-archive update requires --ttl-ms and --sweep-interval-ms or input JSON");
  }
  return body;
}

function rawStringOption(invocation: CommandInvocation, name: string): string | undefined {
  const value = invocation.options[name];
  return typeof value === "string" ? value : undefined;
}

function refPositional(name: string) {
  return { name, required: true } as const;
}
