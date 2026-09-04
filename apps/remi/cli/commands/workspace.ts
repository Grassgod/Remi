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
  booleanOption,
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

const RUNTIME_PROVISION_FIELDS: readonly CliOptionSpec[] = [
  { name: "kind", type: "string", valueName: "npm-global|command", description: "Provision kind" },
  { name: "enabled", type: "boolean", description: "Enable or disable the provision" },
  { name: "disabled", type: "boolean", description: "Disable the provision" },
  { name: "package", type: "string", valueName: "package", description: "Global npm package" },
  { name: "version", type: "string", valueName: "version", description: "Expected npm package version" },
  { name: "version-check", type: "boolean", description: "Verify the binary with --version" },
  { name: "bin", type: "string", valueName: "binary", description: "Binary used for readiness checks" },
  { name: "registry", type: "string", valueName: "url", description: "HTTPS npm registry" },
  { name: "command", type: "string", valueName: "shell", description: "Shell command" },
  { name: "arg", type: "string", valueName: "value", repeatable: true, description: "Command argument" },
  { name: "trigger", type: "string", valueName: "kind", repeatable: true, description: "cron, on_register, or on_change" },
  { name: "cron-expression", type: "string", valueName: "cron", description: "Cron expression" },
  { name: "timezone", type: "string", valueName: "iana", description: "IANA timezone" },
  { name: "timeout-ms", type: "integer", valueName: "ms", description: "Execution deadline" },
];

/**
 * Secrets are accepted but never echoed: the API answers with `*_configured`
 * flags only, so `--app-secret` is the one direction a credential travels. The
 * `*-op` flags exist because omitting a secret means "keep what is stored",
 * which is the only safe default for a partial update.
 */
const FEISHU_BOT_FIELDS: readonly CliOptionSpec[] = [
  { name: "agent", type: "string", valueName: "agent-id", description: "Agent that answers concierge messages" },
  { name: "runtime", type: "string", valueName: "runtime-id", description: "Runtime that hosts the connector" },
  { name: "app-id", type: "string", valueName: "cli_xxx", description: "Feishu App ID" },
  { name: "app-secret", type: "string", valueName: "secret", description: "Feishu App Secret (stored encrypted)" },
  { name: "domain", type: "string", valueName: "feishu|lark|bytedance", description: "Open platform domain" },
  { name: "enabled", type: "boolean", description: "Run the concierge after saving" },
  { name: "disabled", type: "boolean", description: "Save the configuration without running it" },
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
    readSpec("workspace.runtime-provision.list", ["workspace", "runtime-provision", "list"], "List Runtime provisions", [refPositional("workspace")], async (invocation) => {
      const { client, workspaceId } = await runtimeProvisionScope(invocation);
      const response = await client.request({ method: "GET", path: `/api/workspaces/${encodePath(workspaceId)}/runtime-provisions` });
      renderResource(invocation, response.data, ["provisions"]);
    }),
    readSpec("workspace.runtime-provision.get", ["workspace", "runtime-provision", "get"], "Get a Runtime provision", [refPositional("workspace"), refPositional("provision")], async (invocation) => {
      const { client, workspaceId } = await runtimeProvisionScope(invocation);
      const provisionId = positional(invocation, 1, "provision");
      const response = await client.request({ method: "GET", path: runtimeProvisionPath(workspaceId, provisionId) });
      renderResource(invocation, response.data);
    }),
    readSpec("workspace.runtime-provision.states", ["workspace", "runtime-provision", "states"], "List per-Runtime provision states", [refPositional("workspace"), refPositional("provision")], async (invocation) => {
      const { client, workspaceId } = await runtimeProvisionScope(invocation);
      const provisionId = positional(invocation, 1, "provision");
      const response = await client.request({ method: "GET", path: `${runtimeProvisionPath(workspaceId, provisionId)}/states` });
      renderResource(invocation, response.data, ["states"]);
    }),
    writeSpec("workspace.runtime-provision.create", ["workspace", "runtime-provision", "create"], "Create a Runtime provision", [refPositional("workspace")], RUNTIME_PROVISION_FIELDS, async (invocation) => {
      const { client, workspaceId } = await runtimeProvisionScope(invocation);
      const body = await runtimeProvisionBody(invocation);
      const response = await client.request({ method: "POST", path: `/api/workspaces/${encodePath(workspaceId)}/runtime-provisions`, body });
      renderResource(invocation, response.data);
    }),
    writeSpec("workspace.runtime-provision.update", ["workspace", "runtime-provision", "update"], "Update a Runtime provision", [refPositional("workspace"), refPositional("provision")], RUNTIME_PROVISION_FIELDS, async (invocation) => {
      const { client, workspaceId } = await runtimeProvisionScope(invocation);
      const provisionId = positional(invocation, 1, "provision");
      const body = await runtimeProvisionBody(invocation);
      const response = await client.request({ method: "PATCH", path: runtimeProvisionPath(workspaceId, provisionId), body });
      renderResource(invocation, response.data);
    }),
    destructiveSpec("workspace.runtime-provision.delete", ["workspace", "runtime-provision", "delete"], "Delete a Runtime provision", [refPositional("workspace"), refPositional("provision")], async (invocation) => {
      const { client, workspaceId } = await runtimeProvisionScope(invocation);
      const provisionId = positional(invocation, 1, "provision");
      const response = await client.request({ method: "DELETE", path: runtimeProvisionPath(workspaceId, provisionId) });
      renderResource(invocation, response.data);
    }),
    scopedRead("workspace.env.get", ["workspace", "env", "get"], "Read workspace environment", "/env"),
    scopedWrite("workspace.env.update", ["workspace", "env", "update"], "Replace workspace environment", "/env", "PUT", [
      { name: "set", type: "string", valueName: "key=value", repeatable: true, description: "Set an environment entry" },
    ], envBody),
    scopedRead("workspace.organizer.get", ["workspace", "organizer", "get"], "Read Organizer mode", "/organizer"),
    scopedWrite("workspace.organizer.update", ["workspace", "organizer", "update"], "Update Organizer mode", "/organizer", "PUT", [
      { name: "mode", type: "string", valueName: "report_only|act", description: "Organizer action mode" },
    ], organizerBody),
    scopedRead("workspace.issue-topics.get", ["workspace", "issue-topics", "get"], "Read automatic Feishu Issue topic settings", "/issue-topics"),
    scopedWrite(
      "workspace.issue-topics.set",
      ["workspace", "issue-topics", "set"],
      "Configure automatic Feishu Issue topics",
      "/issue-topics",
      "PUT",
      [
        { name: "chat-id", type: "string", valueName: "chat-id", description: "Feishu group chat ID" },
        { name: "project", type: "string", valueName: "project-id", repeatable: true, description: "Limit topics to a project" },
        { name: "enabled", type: "boolean", description: "Create topics for new Issues" },
        { name: "disabled", type: "boolean", description: "Stop creating topics" },
      ],
      issueTopicsBody,
    ),
    scopedRead("workspace.ssh-mesh.get", ["workspace", "ssh-mesh", "get"], "Read SSH mesh settings", "/ssh-mesh"),
    scopedWrite("workspace.ssh-mesh.update", ["workspace", "ssh-mesh", "update"], "Update SSH mesh settings", "/ssh-mesh", "PUT"),
    scopedWrite("workspace.ssh-mesh.rotate", ["workspace", "ssh-mesh", "rotate"], "Rotate SSH mesh key material", "/ssh-mesh/rotate", "POST"),
    scopedWrite("workspace.ssh-mesh.test", ["workspace", "ssh-mesh", "test"], "Test SSH mesh connectivity", "/ssh-mesh/test", "POST"),
    scopedRead("workspace.relay.get", ["workspace", "relay", "get"], "Read relay configuration", "/relay-config"),
    scopedWrite("workspace.relay.discovery", ["workspace", "relay", "discovery"], "Update relay discovery settings", "/relay-config/discovery", "PUT"),
    scopedWrite("workspace.relay.update", ["workspace", "relay", "update"], "Update a relay engine", "/relay-config/:engine", "PUT", [refPositional("engine")]),
    scopedWrite("workspace.relay.reveal", ["workspace", "relay", "reveal"], "Reveal a relay engine credential", "/relay-config/:engine/reveal", "POST", [refPositional("engine")]),
    scopedRead("workspace.bot-menu.get", ["workspace", "bot-menu", "get"], "Read the workspace Feishu bot menu", "/bot-menu"),
    scopedWrite(
      "workspace.bot-menu.update",
      ["workspace", "bot-menu", "update"],
      "Replace the workspace Feishu bot menu",
      "/bot-menu",
      "PUT",
    ),
    scopedWrite(
      "workspace.bot-menu.publish",
      ["workspace", "bot-menu", "publish"],
      "Validate or publish the workspace Feishu bot menu",
      "/bot-menu/publish",
      "POST",
      [{ name: "live", type: "boolean", description: "Publish to Feishu instead of dry-run validation" }],
      async (invocation) => ({ dry_run: booleanOption(invocation, "live") !== true }),
    ),
    readSpec(
      "workspace.bot-menu.publish-status",
      ["workspace", "bot-menu", "publish-status"],
      "Read a Feishu bot menu publish request",
      [refPositional("workspace"), refPositional("request")],
      async (invocation) => {
        const client = await clientFor(invocation);
        const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
        const requestId = positional(invocation, 1, "request");
        const response = await client.request({
          method: "GET",
          path: `/api/workspaces/${encodePath(String(workspace.id))}/bot-menu/publish/${encodePath(requestId)}`,
        });
        renderResource(invocation, response.data);
      },
    ),
    scopedRead("workspace.feishu-bot.get", ["workspace", "feishu-bot", "get"], "Read the workspace Feishu concierge configuration", "/feishu-bot"),
    scopedRead("workspace.feishu-bot.status", ["workspace", "feishu-bot", "status"], "Read Feishu concierge runtime status", "/feishu-bot/status"),
    scopedRead("workspace.feishu-bot.candidates", ["workspace", "feishu-bot", "candidates"], "List Agents and Runtimes the concierge can use", "/feishu-bot/candidates"),
    scopedRead("workspace.feishu-bot.audit", ["workspace", "feishu-bot", "audit"], "Read the Feishu concierge audit trail", "/feishu-bot/audit"),
    scopedWrite(
      "workspace.feishu-bot.set",
      ["workspace", "feishu-bot", "set"],
      "Create or update the workspace Feishu concierge configuration",
      "/feishu-bot",
      "PUT",
      FEISHU_BOT_FIELDS,
      feishuBotBody,
    ),
    scopedWrite("workspace.feishu-bot.test", ["workspace", "feishu-bot", "test"], "Test the Feishu concierge credentials", "/feishu-bot/test", "POST"),
    scopedWrite("workspace.feishu-bot.deploy", ["workspace", "feishu-bot", "deploy"], "Enable and deploy the Feishu concierge", "/feishu-bot/deploy", "POST"),
    scopedWrite("workspace.feishu-bot.stop", ["workspace", "feishu-bot", "stop"], "Stop the Feishu concierge", "/feishu-bot/stop", "POST"),
    scopedWrite(
      "workspace.feishu-bot.register",
      ["workspace", "feishu-bot", "register"],
      "Start a scan-to-create registration for a Feishu concierge app",
      "/feishu-bot/registration",
      "POST",
      [{ name: "brand", type: "string", valueName: "feishu|lark", description: "Open platform brand" }],
      async (invocation) => requestBody(invocation, { brand: stringOption(invocation, "brand") ?? undefined }),
    ),
    readSpec(
      "workspace.feishu-bot.register-status",
      ["workspace", "feishu-bot", "register-status"],
      "Poll a Feishu concierge registration session",
      [refPositional("workspace"), refPositional("session")],
      async (invocation) => {
        const { client, workspaceId } = await feishuBotRegistrationScope(invocation);
        const response = await client.request({
          method: "GET",
          path: `${feishuBotRegistrationPath(workspaceId, positional(invocation, 1, "session"))}`,
        });
        renderResource(invocation, response.data);
      },
    ),
    destructiveSpec(
      "workspace.feishu-bot.register-cancel",
      ["workspace", "feishu-bot", "register-cancel"],
      "Discard a Feishu concierge registration session",
      [refPositional("workspace"), refPositional("session")],
      async (invocation) => {
        const { client, workspaceId } = await feishuBotRegistrationScope(invocation);
        const response = await client.request({
          method: "DELETE",
          path: feishuBotRegistrationPath(workspaceId, positional(invocation, 1, "session")),
        });
        renderResource(invocation, response.data);
      },
    ),
    destructiveSpec("workspace.feishu-bot.delete", ["workspace", "feishu-bot", "delete"], "Delete the workspace Feishu concierge configuration", [refPositional("workspace")], async (invocation) => {
      const client = await clientFor(invocation);
      const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
      const response = await client.request({ method: "DELETE", path: `/api/workspaces/${encodePath(String(workspace.id))}/feishu-bot` });
      renderResource(invocation, response.data);
    }),
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
    run: async () => { throw new CliError("usage", "usage: remi workspace list|get|create|update|delete|leave|runtime-provision|env|ssh-mesh|relay|bot-menu|feishu-bot ..."); },
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

async function runtimeProvisionScope(invocation: CommandInvocation) {
  const client = await clientFor(invocation);
  const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
  return { client, workspaceId: String(workspace.id) };
}

function runtimeProvisionPath(workspaceId: string, provisionId: string): string {
  return `/api/workspaces/${encodePath(workspaceId)}/runtime-provisions/${encodePath(provisionId)}`;
}

async function runtimeProvisionBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  const args = stringOptions(invocation, "arg");
  const triggers = stringOptions(invocation, "trigger");
  return requestBody(invocation, {
    kind: stringOption(invocation, "kind") ?? undefined,
    enabled: booleanOption(invocation, "disabled") === true ? false : booleanOption(invocation, "enabled") ?? undefined,
    package: stringOption(invocation, "package") ?? undefined,
    version: stringOption(invocation, "version") ?? undefined,
    version_check: booleanOption(invocation, "version-check") ?? undefined,
    bin: stringOption(invocation, "bin") ?? undefined,
    registry: stringOption(invocation, "registry") ?? undefined,
    command: rawStringOption(invocation, "command"),
    args: args.length ? args : undefined,
    trigger_kinds: triggers.length ? triggers : undefined,
    cron_expression: stringOption(invocation, "cron-expression") ?? undefined,
    timezone: stringOption(invocation, "timezone") ?? undefined,
    timeout_ms: integerOption(invocation, "timeout-ms") ?? undefined,
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

async function feishuBotRegistrationScope(invocation: CommandInvocation) {
  const client = await clientFor(invocation);
  const workspace = await resolveWorkspace(client, positional(invocation, 0, "workspace"));
  return { client, workspaceId: String(workspace.id) };
}

function feishuBotRegistrationPath(workspaceId: string, sessionId: string): string {
  return `/api/workspaces/${encodePath(workspaceId)}/feishu-bot/registration/${encodePath(sessionId)}`;
}

async function feishuBotBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  const body = await requestBody(invocation, {
    agent_id: stringOption(invocation, "agent") ?? undefined,
    runtime_id: stringOption(invocation, "runtime") ?? undefined,
    app_id: stringOption(invocation, "app-id") ?? undefined,
    app_secret: rawStringOption(invocation, "app-secret"),
    domain: stringOption(invocation, "domain") ?? undefined,
    enabled: booleanOption(invocation, "disabled") === true ? false : booleanOption(invocation, "enabled") ?? undefined,
  });
  // The API requires an explicit boolean so a save can never flip the bot on or
  // off by accident; the CLI asks rather than guessing.
  if (typeof body.enabled !== "boolean") {
    throw new CliError("usage", "workspace feishu-bot set requires --enabled or --disabled");
  }
  return body;
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

async function organizerBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  const body = await requestBody(invocation, { mode: stringOption(invocation, "mode") ?? undefined });
  if (body.mode !== "report_only" && body.mode !== "act") {
    throw new CliError("usage", "workspace organizer update requires --mode report_only|act or input JSON");
  }
  return body;
}

async function issueTopicsBody(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  const projects = stringOptions(invocation, "project");
  const body = await requestBody(invocation, {
    enabled: booleanOption(invocation, "disabled") === true
      ? false
      : booleanOption(invocation, "enabled") ?? undefined,
    chat_id: stringOption(invocation, "chat-id") ?? undefined,
    project_ids: projects.length ? projects : undefined,
  });
  if (typeof body.enabled !== "boolean") {
    throw new CliError("usage", "workspace issue-topics set requires --enabled or --disabled");
  }
  if (body.enabled && (typeof body.chat_id !== "string" || !body.chat_id.trim())) {
    throw new CliError("usage", "workspace issue-topics set requires --chat-id when enabled");
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
