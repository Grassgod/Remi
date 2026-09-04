import {
  AsyncOperationController,
  CliError,
  ResourceResolver,
  sanitizeCliDetails,
  type CliApiClient,
  type CliHttpMethod,
  type CliIdentity,
  type CliMutation,
  type CliOptionSpec,
  type CliPositionalSpec,
  type CommandAlias,
  type CommandInvocation,
  type CommandSpec,
} from "../core/index.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  clientFor,
  booleanOption,
  commandOptions,
  encodePath,
  extractRecords,
  positional,
  integerOption,
  outputMode,
  queryOptions,
  renderResource,
  requestBody,
  requireConfirmation,
  requiredWorkspace,
  stringOption,
  stringOptions,
} from "./resource-common.js";

const HUMAN: readonly CliIdentity[] = ["human"];
const HUMAN_TASK: readonly CliIdentity[] = ["human", "task"];
const HUMAN_DAEMON: readonly CliIdentity[] = ["human", "daemon"];
const DEPRECATED_SINCE = "0.3.0";

type OperationPath = string | ((invocation: CommandInvocation, client: CliApiClient) => string | Promise<string>);

interface OperationDefinition {
  id: string;
  path: readonly string[];
  description: string;
  method: CliHttpMethod;
  apiPath: OperationPath;
  mutation?: CliMutation;
  auth?: readonly CliIdentity[];
  positionals?: readonly CliPositionalSpec[];
  options?: readonly CliOptionSpec[];
  aliases?: readonly CommandAlias[];
  query?: (invocation: CommandInvocation) => Record<string, string | number | boolean | null | undefined>;
  body?: (invocation: CommandInvocation) => Promise<Record<string, unknown>> | Record<string, unknown>;
  collections?: readonly string[];
  before?: (invocation: CommandInvocation, client: CliApiClient) => Promise<void>;
  negotiate?: boolean;
}

export function operationsCommandSpecs(): CommandSpec[] {
  return [
    ...runtimeSpecs(),
    ...daemonSpecs(),
    ...autopilotSpecs(),
    ...scmSpecs(),
    ...messagingSpecs(),
    ...feishuSpecs(),
    ...inboxSpecs(),
    ...notificationSpecs(),
    ...pinSpecs(),
    ...dashboardSpecs(),
    ...platformSpecs(),
    ...billingSpecs(),
    ...larkSpecs(),
    ...authContextSpecs(),
  ];
}

function runtimeSpecs(): CommandSpec[] {
  const runtime = (suffix: string) => async (invocation: CommandInvocation, client: CliApiClient) => {
    const id = await resolveRuntimeId(client, invocation, positional(invocation, 0, "runtime"));
    return `/api/runtimes/${encodePath(id)}${suffix}`;
  };
  return [
    group("runtime", "Manage execution runtimes and cloud nodes"),
    op({ id: "runtime.list", path: ["runtime", "list"], description: "List runtimes", method: "GET", apiPath: "/api/runtimes", auth: HUMAN_DAEMON, collections: ["runtimes"] }),
    op({ id: "runtime.get", path: ["runtime", "get"], description: "Get a runtime", method: "GET", apiPath: runtime(""), auth: HUMAN_DAEMON, positionals: [ref("runtime")] }),
    op({ id: "runtime.create", path: ["runtime", "create"], description: "Register a runtime", method: "POST", apiPath: "/api/multiremi/runtimes", auth: HUMAN_DAEMON, options: INPUT_OPTIONS, body: withWorkspace }),
    op({ id: "runtime.update", path: ["runtime", "update"], description: "Update a runtime", method: "PATCH", apiPath: runtime(""), mutation: "write", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS }),
    op({ id: "runtime.delete", path: ["runtime", "delete"], description: "Delete a runtime after reporting active impact", method: "DELETE", apiPath: runtime(""), mutation: "destructive", auth: HUMAN, positionals: [ref("runtime")], before: runtimeImpact }),
    op({ id: "runtime.archive-agents-and-delete", path: ["runtime", "archive-agents-and-delete"], description: "Archive active agents and delete a runtime", method: "POST", apiPath: runtime("/archive-agents-and-delete"), mutation: "destructive", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS, before: runtimeImpact }),
    op({ id: "runtime.model.list", path: ["runtime", "model", "list"], description: "List runtime models", method: "GET", apiPath: runtime("/models"), auth: HUMAN_DAEMON, positionals: [ref("runtime")], collections: ["models"] }),
    op({ id: "runtime.model.set", path: ["runtime", "model", "set"], description: "Replace runtime model configuration", method: "PUT", apiPath: runtime("/models"), mutation: "write", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS }),
    op({ id: "runtime.model.refresh", path: ["runtime", "model", "refresh"], description: "Request a runtime model refresh", method: "POST", apiPath: runtime("/models"), mutation: "write", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS }),
    op({ id: "runtime.model.status", path: ["runtime", "model", "status"], description: "Get a model refresh request", method: "GET", apiPath: async (i, c) => `${await runtime("/models")(i, c)}/${encodePath(positional(i, 1, "request"))}`, auth: HUMAN_DAEMON, positionals: [ref("runtime"), ref("request")] }),
    op({ id: "runtime.release.start", path: ["runtime", "release", "start"], description: "Start a runtime update", method: "POST", apiPath: runtime("/update"), mutation: "write", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS }),
    op({ id: "runtime.release.status", path: ["runtime", "release", "status"], description: "Get a runtime update request", method: "GET", apiPath: async (i, c) => `${await runtime("/update")(i, c)}/${encodePath(positional(i, 1, "update"))}`, auth: HUMAN_DAEMON, positionals: [ref("runtime"), ref("update")] }),
    runtimeCommandRunSpec(),
    op({ id: "runtime.skill.scan", path: ["runtime", "skill", "scan"], description: "Request local skill discovery", method: "POST", apiPath: runtime("/local-skills"), mutation: "write", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS }),
    op({ id: "runtime.skill.status", path: ["runtime", "skill", "status"], description: "Get local skill discovery status", method: "GET", apiPath: async (i, c) => `${await runtime("/local-skills")(i, c)}/${encodePath(positional(i, 1, "request"))}`, auth: HUMAN_DAEMON, positionals: [ref("runtime"), ref("request")] }),
    op({ id: "runtime.skill.import", path: ["runtime", "skill", "import"], description: "Import local runtime skills", method: "POST", apiPath: runtime("/local-skills/import"), mutation: "write", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS }),
    op({ id: "runtime.skill.import-status", path: ["runtime", "skill", "import-status"], description: "Get local skill import status", method: "GET", apiPath: async (i, c) => `${await runtime("/local-skills/import")(i, c)}/${encodePath(positional(i, 1, "request"))}`, auth: HUMAN_DAEMON, positionals: [ref("runtime"), ref("request")] }),
    op({ id: "runtime.directory.scan", path: ["runtime", "directory", "scan"], description: "Request a runtime directory scan", method: "POST", apiPath: runtime("/directory-scans"), mutation: "write", auth: HUMAN, positionals: [ref("runtime")], options: INPUT_OPTIONS }),
    op({ id: "runtime.directory.status", path: ["runtime", "directory", "status"], description: "Get directory scan status", method: "GET", apiPath: async (i, c) => `${await runtime("/directory-scans")(i, c)}/${encodePath(positional(i, 1, "request"))}`, auth: HUMAN_DAEMON, positionals: [ref("runtime"), ref("request")] }),
    ...[
      ["runtime.usage", ["runtime", "usage"], "/usage", "Get runtime daily usage"],
      ["runtime.usage.by-agent", ["runtime", "usage", "by-agent"], "/usage/by-agent", "Get runtime usage by agent"],
      ["runtime.usage.by-hour", ["runtime", "usage", "by-hour"], "/usage/by-hour", "Get runtime usage by hour"],
      ["runtime.task-activity", ["runtime", "task-activity"], "/task-activity", "Get runtime task activity"],
      ["runtime.activity", ["runtime", "activity"], "/activity", "Get runtime activity"],
    ].map(([id, path, suffix, description]) => op({ id: id as string, path: path as string[], description: description as string, method: "GET", apiPath: runtime(suffix as string), auth: HUMAN_DAEMON, positionals: [ref("runtime")] })),
    op({ id: "runtime.model.catalog", path: ["runtime", "model", "catalog"], description: "List fleet model providers", method: "GET", apiPath: "/api/models", auth: HUMAN, collections: ["providers"] }),
    op({ id: "runtime.cloud.status", path: ["runtime", "cloud", "status"], description: "Get cloud runtime status", method: "GET", apiPath: "/api/cloud-runtime", auth: HUMAN }),
    op({ id: "runtime.cloud.health", path: ["runtime", "cloud", "health"], description: "Check cloud runtime health", method: "GET", apiPath: "/api/cloud-runtime/healthz", auth: HUMAN }),
    op({ id: "runtime.cloud.ready", path: ["runtime", "cloud", "ready"], description: "Check cloud runtime readiness", method: "GET", apiPath: "/api/cloud-runtime/readyz", auth: HUMAN }),
    op({ id: "runtime.cloud.node.list", path: ["runtime", "cloud", "node", "list"], description: "List cloud runtime nodes", method: "GET", apiPath: "/api/cloud-runtime/nodes", auth: HUMAN, collections: ["nodes"] }),
    op({ id: "runtime.cloud.node.create", path: ["runtime", "cloud", "node", "create"], description: "Create a cloud runtime node", method: "POST", apiPath: "/api/cloud-runtime/nodes", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "runtime.cloud.node.delete", path: ["runtime", "cloud", "node", "delete"], description: "Delete cloud runtime nodes", method: "DELETE", apiPath: "/api/cloud-runtime/nodes", mutation: "destructive", auth: HUMAN, options: INPUT_OPTIONS }),
    ...["start", "stop", "reboot", "status", "exec"].map((action) => op({
      id: `runtime.cloud.node.${action}`,
      path: ["runtime", "cloud", "node", action],
      description: `${capital(action)} cloud runtime nodes`,
      method: "POST",
      apiPath: `/api/cloud-runtime/nodes/${action}`,
      mutation: action === "status" ? "read" : "write",
      auth: HUMAN,
      options: INPUT_OPTIONS,
    })),
  ];

  function runtimeCommandRunSpec(): CommandSpec {
    return {
      id: "runtime.command.run",
      path: ["runtime", "command", "run"],
      description: "Run a command on a runtime and wait for its result",
      capability: "runtime.command.run",
      auth: HUMAN,
      mutation: "write",
      outputs: ["table", "json", "jsonl"],
      positionals: [ref("runtime")],
      options: commandOptions([{
        name: "command",
        type: "string",
        valueName: "cmd",
        description: "Command to execute",
        required: true,
      }, {
        name: "arg",
        type: "string",
        valueName: "value",
        description: "Argument appended to the command",
        repeatable: true,
      }]),
      run: async (invocation) => {
        const client = await clientFor(invocation);
        const runtimeId = await resolveRuntimeId(client, invocation, positional(invocation, 0, "runtime"));
        const timeoutMs = integerOption(invocation, "timeout") ?? 60_000;
        const createdResponse = await client.request<Record<string, unknown>>({
          method: "POST",
          path: `/api/runtimes/${encodePath(runtimeId)}/commands`,
          body: {
            command: stringOption(invocation, "command"),
            args: stringOptions(invocation, "arg"),
            timeout_ms: timeoutMs,
          },
        });
        const created = createdResponse.data;
        const requestId = String(created.id ?? "").trim();
        if (!requestId) throw new CliError("server", "runtime command response did not include an id");
        const controller = new AsyncOperationController<Record<string, unknown>>({
          status: async (id) => (await client.request<Record<string, unknown>>({
            method: "GET",
            path: `/api/runtimes/${encodePath(runtimeId)}/commands/${encodePath(id)}`,
          })).data,
          cancel: async () => {
            throw new CliError("usage", "runtime commands cannot be cancelled from this CLI version");
          },
          state: (request) => String(request.status ?? ""),
          terminalStates: ["completed", "failed", "timeout"],
          successStates: ["completed"],
          failureDetails: (request) => request,
        });
        const finished = await controller.wait(requestId, {
          timeoutMs: timeoutMs + 3 * 60_000 + 10_000,
          pollIntervalMs: 500,
        });
        renderRuntimeCommandResult(invocation, finished);
      },
    };
  }
}

function daemonSpecs(): CommandSpec[] {
  return [
    group("daemon", "Manage local daemon lifecycle and machine retirement"),
    op({ id: "daemon.list", path: ["daemon", "list"], description: "List daemon machines", method: "GET", apiPath: "/api/multiremi/daemons", auth: HUMAN, query: (i) => ({ workspace_id: requiredWorkspace(i) }), collections: ["daemons"] }),
    op({ id: "daemon.get", path: ["daemon", "get"], description: "Get daemon routing settings", method: "GET", apiPath: (i) => `/api/daemons/${encodePath(positional(i, 0, "daemon"))}`, auth: HUMAN, positionals: [ref("daemon")], query: (i) => ({ workspace_id: requiredWorkspace(i) }) }),
    op({
      id: "daemon.dedicated.set",
      path: ["daemon", "dedicated", "set"],
      description: "Enable or disable project-only scheduling on a daemon",
      method: "PATCH",
      apiPath: (i) => `/api/daemons/${encodePath(positional(i, 0, "daemon"))}`,
      mutation: "write",
      auth: HUMAN,
      positionals: [ref("daemon")],
      options: [
        { name: "enabled", type: "boolean", description: "Only run bound projects", conflictsWith: ["disabled"] },
        { name: "disabled", type: "boolean", description: "Accept unrestricted work", conflictsWith: ["enabled"] },
      ],
      query: (i) => ({ workspace_id: requiredWorkspace(i) }),
      body: (i) => {
        const dedicated = i.options.enabled === true ? true : i.options.disabled === true ? false : null;
        if (dedicated === null) throw new CliError("usage", "daemon dedicated set requires --enabled or --disabled");
        return { dedicated };
      },
    }),
    op({ id: "daemon.retirement-plan", path: ["daemon", "retirement-plan"], description: "Review a daemon retirement plan", method: "GET", apiPath: (i) => `/api/multiremi/daemons/${encodePath(positional(i, 0, "daemon"))}/retirement-plan`, auth: HUMAN, positionals: [ref("daemon")], query: (i) => ({ workspace_id: requiredWorkspace(i) }) }),
    daemonRetireSpec(),
    ...["start", "stop", "restart", "status", "logs", "service"].map(localDaemonSpec),
  ];
}

function localDaemonSpec(action: string): CommandSpec {
  return {
    id: `daemon.local.${action}`,
    path: ["daemon", action],
    description: `${capital(action)} the local daemon`,
    auth: ["human", "daemon"],
    mutation: ["status", "logs"].includes(action) ? "read" : "write",
    outputs: ["table", "json", "jsonl"],
    parse: "passthrough",
    aliases: [{ path: [action], deprecatedSince: DEPRECATED_SINCE, replacement: `remi daemon ${action}`, dispatch: false }],
    run: async (invocation) => {
      const { runMultiremi } = await import("../multiremi.js");
      await runMultiremi(["daemon", action, ...invocation.rawArgs], { programName: "remi multiremi" });
    },
  };
}

function daemonRetireSpec(): CommandSpec {
  return {
    id: "daemon.retire",
    path: ["daemon", "retire"],
    description: "Retire a daemon machine after reviewing its impact",
    capability: "daemon.retire",
    auth: HUMAN,
    mutation: "destructive",
    outputs: ["table", "json", "jsonl"],
    positionals: [ref("daemon")],
    options: commandOptions(PAGE_OPTIONS, INPUT_OPTIONS, [YES_OPTION]),
    run: async (invocation) => {
      requireConfirmation(invocation);
      const daemonId = positional(invocation, 0, "daemon");
      const client = await clientFor(invocation);
      const query = { workspace_id: requiredWorkspace(invocation) };
      const planResponse = await client.request<Record<string, unknown>>({ method: "GET", path: `/api/multiremi/daemons/${encodePath(daemonId)}/retirement-plan`, query });
      const plan = isRecord(planResponse.data.plan) ? planResponse.data.plan : {};
      const impact = isRecord(plan.impact) ? plan.impact : {};
      console.error(`Retiring daemon ${daemonId}: ${Number(impact.runtimes_removed ?? 0)} runtime(s), ${Number(impact.agents_detached ?? 0)} agent(s), ${Number(impact.queued_tasks_requeued ?? 0)} queued task(s) affected.`);
      const supplied = await requestBody(invocation);
      const response = await client.request({
        method: "POST",
        path: `/api/multiremi/daemons/${encodePath(daemonId)}/retire`,
        query,
        body: { ...supplied, expected_snapshot: supplied.expected_snapshot ?? plan.snapshot, workspace_id: requiredWorkspace(invocation) },
      });
      renderSafe(invocation, response.data);
    },
  };
}

function autopilotSpecs(): CommandSpec[] {
  const base = async (i: CommandInvocation, client: CliApiClient) => `/api/autopilots/${encodePath(await resolveListedId(
    client, i, positional(i, 0, "autopilot"), "autopilot", "/api/autopilots", ["autopilots"],
  ))}`;
  return [
    group("autopilot", "Manage scheduled and webhook automations"),
    op({ id: "autopilot.list", path: ["autopilot", "list"], description: "List autopilots", method: "GET", apiPath: "/api/autopilots", auth: HUMAN, query: (i) => queryOptions(i, { workspace_id: requiredWorkspace(i) }), collections: ["autopilots"] }),
    op({ id: "autopilot.get", path: ["autopilot", "get"], description: "Get an autopilot", method: "GET", apiPath: base, auth: HUMAN, positionals: [ref("autopilot")] }),
    op({ id: "autopilot.create", path: ["autopilot", "create"], description: "Create an autopilot", method: "POST", apiPath: "/api/autopilots", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS, body: withWorkspace }),
    op({ id: "autopilot.update", path: ["autopilot", "update"], description: "Update an autopilot", method: "PATCH", apiPath: base, mutation: "write", auth: HUMAN, positionals: [ref("autopilot")], options: INPUT_OPTIONS }),
    op({ id: "autopilot.delete", path: ["autopilot", "delete"], description: "Delete an autopilot", method: "DELETE", apiPath: base, mutation: "destructive", auth: HUMAN, positionals: [ref("autopilot")] }),
    op({ id: "autopilot.run.list", path: ["autopilot", "run", "list"], description: "List autopilot runs", method: "GET", apiPath: async (i, c) => `${await base(i, c)}/runs`, auth: HUMAN, positionals: [ref("autopilot")], collections: ["runs"] }),
    op({ id: "autopilot.run.get", path: ["autopilot", "run", "get"], description: "Get an autopilot run", method: "GET", apiPath: async (i, c) => `${await base(i, c)}/runs/${encodePath(positional(i, 1, "run"))}`, auth: HUMAN, positionals: [ref("autopilot"), ref("run")] }),
    op({ id: "autopilot.run", path: ["autopilot", "run"], description: "Run an autopilot", method: "POST", apiPath: async (i, c) => `${await base(i, c)}/trigger`, mutation: "write", auth: HUMAN, positionals: [ref("autopilot")], options: INPUT_OPTIONS }),
    op({ id: "autopilot.delivery.list", path: ["autopilot", "delivery", "list"], description: "List autopilot webhook deliveries", method: "GET", apiPath: async (i, c) => `${await base(i, c)}/deliveries`, auth: HUMAN, positionals: [ref("autopilot")], collections: ["deliveries"] }),
    op({ id: "autopilot.delivery.get", path: ["autopilot", "delivery", "get"], description: "Get an autopilot delivery", method: "GET", apiPath: async (i, c) => `${await base(i, c)}/deliveries/${encodePath(positional(i, 1, "delivery"))}`, auth: HUMAN, positionals: [ref("autopilot"), ref("delivery")] }),
    op({ id: "autopilot.delivery.replay", path: ["autopilot", "delivery", "replay"], description: "Replay an autopilot delivery", method: "POST", apiPath: async (i, c) => `${await base(i, c)}/deliveries/${encodePath(positional(i, 1, "delivery"))}/replay`, mutation: "write", auth: HUMAN, positionals: [ref("autopilot"), ref("delivery")], options: INPUT_OPTIONS }),
    op({ id: "autopilot.trigger.list", path: ["autopilot", "trigger", "list"], description: "List autopilot triggers", method: "GET", apiPath: base, auth: HUMAN, positionals: [ref("autopilot")], collections: ["triggers"] }),
    op({ id: "autopilot.trigger.create", path: ["autopilot", "trigger", "create"], description: "Create an autopilot trigger", method: "POST", apiPath: async (i, c) => `${await base(i, c)}/triggers`, mutation: "write", auth: HUMAN, positionals: [ref("autopilot")], options: INPUT_OPTIONS }),
    op({ id: "autopilot.trigger.update", path: ["autopilot", "trigger", "update"], description: "Update an autopilot trigger", method: "PATCH", apiPath: async (i, c) => `${await base(i, c)}/triggers/${encodePath(positional(i, 1, "trigger"))}`, mutation: "write", auth: HUMAN, positionals: [ref("autopilot"), ref("trigger")], options: INPUT_OPTIONS }),
    op({ id: "autopilot.trigger.delete", path: ["autopilot", "trigger", "delete"], description: "Delete an autopilot trigger", method: "DELETE", apiPath: async (i, c) => `${await base(i, c)}/triggers/${encodePath(positional(i, 1, "trigger"))}`, mutation: "destructive", auth: HUMAN, positionals: [ref("autopilot"), ref("trigger")] }),
    op({ id: "autopilot.trigger.rotate-token", path: ["autopilot", "trigger", "rotate-token"], description: "Rotate a webhook trigger token", method: "POST", apiPath: async (i, c) => `${await base(i, c)}/triggers/${encodePath(positional(i, 1, "trigger"))}/rotate-webhook-token`, mutation: "destructive", auth: HUMAN, positionals: [ref("autopilot"), ref("trigger")] }),
    op({ id: "autopilot.trigger.set-secret", path: ["autopilot", "trigger", "set-secret"], description: "Set a webhook signing secret", method: "PUT", apiPath: async (i, c) => `${await base(i, c)}/triggers/${encodePath(positional(i, 1, "trigger"))}/signing-secret`, mutation: "write", auth: HUMAN, positionals: [ref("autopilot"), ref("trigger")], options: INPUT_OPTIONS }),
    op({ id: "autopilot.scheduler", path: ["autopilot", "scheduler"], description: "Get scheduler state", method: "GET", apiPath: "/api/multiremi/scheduler", auth: HUMAN }),
  ];
}

function scmSpecs(): CommandSpec[] {
  const connection = async (i: CommandInvocation, client: CliApiClient) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/scm/connections/${encodePath(await resolveListedId(
    client, i, positional(i, 0, "connection"), "SCM connection",
    `/api/workspaces/${encodePath(requiredWorkspace(i))}/scm/connections`, ["connections"],
  ))}`;
  return [
    group("scm", "Manage source-control connections, repositories, and change requests"),
    op({ id: "scm.capabilities", path: ["scm", "capabilities"], description: "List SCM provider capabilities", method: "GET", apiPath: "/api/scm/capabilities", auth: HUMAN }),
    op({ id: "scm.connection.list", path: ["scm", "connection", "list"], description: "List SCM connections", method: "GET", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/scm/connections`, auth: HUMAN, collections: ["connections"] }),
    op({ id: "scm.connection.get", path: ["scm", "connection", "get"], description: "Get an SCM connection", method: "GET", apiPath: connection, auth: HUMAN, positionals: [ref("connection")] }),
    op({ id: "scm.connection.create", path: ["scm", "connection", "create"], description: "Create an SCM connection", method: "POST", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/scm/connections`, mutation: "write", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "scm.connection.update", path: ["scm", "connection", "update"], description: "Update an SCM connection", method: "PATCH", apiPath: connection, mutation: "write", auth: HUMAN, positionals: [ref("connection")], options: INPUT_OPTIONS }),
    op({ id: "scm.connection.delete", path: ["scm", "connection", "delete"], description: "Delete an SCM connection after reporting repository impact", method: "DELETE", apiPath: connection, mutation: "destructive", auth: HUMAN, positionals: [ref("connection")], before: scmImpact }),
    op({ id: "scm.connection.verify", path: ["scm", "connection", "verify"], description: "Verify an SCM connection", method: "POST", apiPath: async (i, c) => `${await connection(i, c)}/verify`, mutation: "write", auth: HUMAN, positionals: [ref("connection")] }),
    op({ id: "scm.repository.bind", path: ["scm", "repository", "bind"], description: "Bind a repository to an SCM connection", method: "PUT", apiPath: async (i, c) => `${await connection(i, c)}/repositories/${encodePath(positional(i, 1, "repository"))}`, mutation: "write", auth: HUMAN, positionals: [ref("connection"), ref("repository")], options: INPUT_OPTIONS }),
    op({ id: "scm.repository.unbind", path: ["scm", "repository", "unbind"], description: "Unbind a repository from an SCM connection", method: "DELETE", apiPath: async (i, c) => `${await connection(i, c)}/repositories/${encodePath(positional(i, 1, "repository"))}`, mutation: "destructive", auth: HUMAN, positionals: [ref("connection"), ref("repository")] }),
    op({ id: "scm.event.list", path: ["scm", "event", "list"], description: "List normalized SCM events", method: "GET", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/scm/events`, auth: HUMAN, collections: ["events"] }),
    op({ id: "scm.event.get", path: ["scm", "event", "get"], description: "Get an SCM event and evidence", method: "GET", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/scm/events/${encodePath(positional(i, 0, "event"))}`, auth: HUMAN, positionals: [ref("event")] }),
    op({ id: "scm.change-request.list", path: ["scm", "change-request", "list"], description: "List change requests linked to an issue", method: "GET", apiPath: (i) => `/api/issues/${encodePath(positional(i, 0, "issue"))}/change-requests`, auth: HUMAN_TASK, positionals: [ref("issue")], collections: ["changeRequests"] }),
    op({ id: "scm.change-request.link", path: ["scm", "change-request", "link"], description: "Link a change request to an issue", method: "PUT", apiPath: changeRequestPath, mutation: "write", auth: HUMAN_TASK, positionals: [ref("issue"), ref("change-request")] }),
    op({ id: "scm.change-request.unlink", path: ["scm", "change-request", "unlink"], description: "Unlink a change request from an issue", method: "DELETE", apiPath: changeRequestPath, mutation: "destructive", auth: HUMAN_TASK, positionals: [ref("issue"), ref("change-request")] }),
  ];
}

/**
 * The channel-independent messaging commands.
 *
 * `remi feishu` below is the same workflow bound to one channel and one
 * legacy id space; it stays for shipped clients. Anything new belongs here,
 * where the channel is whatever the Connection's Provider serves.
 */
function messagingSpecs(): CommandSpec[] {
  const workspaceBase = (i: CommandInvocation) =>
    `/api/workspaces/${encodePath(requiredWorkspace(i))}/messaging`;
  const connection = (i: CommandInvocation) =>
    `${workspaceBase(i)}/connections/${encodePath(positional(i, 0, "connection"))}`;
  const source = (i: CommandInvocation) =>
    `${workspaceBase(i)}/sources/${encodePath(positional(i, 0, "source"))}`;
  // A message id is only unique inside its Connection, so both halves of the
  // key travel in the path rather than the id being looked up workspace-wide.
  const message = (i: CommandInvocation) =>
    `${connection(i)}/messages/${encodePath(positional(i, 1, "message"))}`;
  const messageRef: readonly CliPositionalSpec[] = [ref("connection"), ref("message")];

  const sourceFields: readonly CliOptionSpec[] = [
    { name: "name", type: "string", valueName: "name", description: "Source display name" },
    { name: "connection", type: "string", valueName: "id", description: "Connection that ingests for this source" },
    { name: "conversation", type: "string", valueName: "id", repeatable: true, description: "Allowlisted conversation ID" },
    { name: "clear-allowlist", type: "boolean", conflictsWith: ["conversation"], description: "Replace the allowlist with an empty list" },
    { name: "enabled", type: "boolean", description: "Enable or disable ingestion" },
    { name: "retention-days", type: "integer", valueName: "days", description: "Message retention period" },
    { name: "poll-interval-seconds", type: "integer", valueName: "seconds", description: "Minimum poll interval" },
    { name: "unprocessed-retry-seconds", type: "integer", valueName: "seconds", description: "Delay before retrying unresolved messages" },
    { name: "unprocessed-retry-limit", type: "integer", valueName: "count", description: "Retries before timeout dismissal" },
  ];
  const sourceBody = (i: CommandInvocation) => requestBody(i, {
    name: stringOption(i, "name") ?? undefined,
    connection_id: stringOption(i, "connection") ?? undefined,
    allowlist: booleanOption(i, "clear-allowlist")
      ? []
      : i.options.conversation === undefined ? undefined : stringOptions(i, "conversation"),
    enabled: booleanOption(i, "enabled") ?? undefined,
    retention_days: integerOption(i, "retention-days") ?? undefined,
    poll_interval_seconds: integerOption(i, "poll-interval-seconds") ?? undefined,
    unprocessed_retry_seconds: integerOption(i, "unprocessed-retry-seconds") ?? undefined,
    unprocessed_retry_limit: integerOption(i, "unprocessed-retry-limit") ?? undefined,
  });
  const issueProposalOptions: readonly CliOptionSpec[] = [
    { name: "title", type: "string", valueName: "text", required: true, description: "Issue title" },
    { name: "description", type: "string", valueName: "text", description: "Issue description" },
    { name: "project-id", type: "string", valueName: "id", description: "Project ID" },
    { name: "priority", type: "string", valueName: "priority", description: "Issue priority" },
    { name: "assignee-type", type: "string", valueName: "type", description: "Suggested assignee type" },
    { name: "assignee-id", type: "string", valueName: "id", description: "Suggested assignee ID" },
  ];
  const issueProposalBody = (i: CommandInvocation) => requestBody(i, {
    title: requiredStringOption(i, "title"),
    description: stringOption(i, "description") ?? undefined,
    project_id: stringOption(i, "project-id") ?? undefined,
    priority: stringOption(i, "priority") ?? undefined,
    assignee_type: stringOption(i, "assignee-type") ?? undefined,
    assignee_id: stringOption(i, "assignee-id") ?? undefined,
  });
  return [
    group("messaging", "Connect message channels and process what they deliver"),
    op({
      id: "messaging.provider.list",
      path: ["messaging", "provider", "list"],
      description: "List registered providers and the channels they serve",
      method: "GET",
      apiPath: (i) => `${workspaceBase(i)}/providers`,
      auth: HUMAN,
      collections: ["providers"],
    }),
    op({ id: "messaging.connection.list", path: ["messaging", "connection", "list"], description: "List message connections and their health", method: "GET", apiPath: (i) => `${workspaceBase(i)}/connections`, auth: HUMAN, collections: ["connections"] }),
    op({
      id: "messaging.connection.add",
      path: ["messaging", "connection", "add"],
      description: "Connect a provider to a channel",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/connections`,
      mutation: "write",
      auth: HUMAN,
      options: [
        ...INPUT_OPTIONS,
        { name: "name", type: "string", valueName: "name", required: true, description: "Connection display name" },
        { name: "provider", type: "string", valueName: "id", required: true, description: "Registered provider, e.g. lark_cli" },
        { name: "channel", type: "string", valueName: "channel", description: "Channel to serve; defaults to the provider's only one" },
      ],
      // Provider configuration is provider-shaped, so it arrives as JSON
      // through --data rather than as a flag per provider.
      body: (i) => requestBody(i, {
        name: requiredStringOption(i, "name"),
        provider: requiredStringOption(i, "provider"),
        channel: stringOption(i, "channel") ?? undefined,
      }),
    }),
    op({ id: "messaging.connection.get", path: ["messaging", "connection", "get"], description: "Get a message connection", method: "GET", apiPath: connection, auth: HUMAN, positionals: [ref("connection")] }),
    op({ id: "messaging.connection.authorization.start", path: ["messaging", "connection", "authorization", "start"], description: "Start interactive authorization for a message connection", method: "POST", apiPath: (i) => `${connection(i)}/authorization-sessions`, mutation: "write", auth: HUMAN, positionals: [ref("connection")] }),
    op({ id: "messaging.connection.authorization.get", path: ["messaging", "connection", "authorization", "get"], description: "Get an interactive authorization session", method: "GET", apiPath: (i) => `${connection(i)}/authorization-sessions/${encodePath(positional(i, 1, "session"))}`, auth: HUMAN, positionals: [ref("connection"), ref("session")] }),
    op({
      id: "messaging.connection.update",
      path: ["messaging", "connection", "update"],
      description: "Rename a connection or replace its provider configuration",
      method: "PATCH",
      apiPath: connection,
      mutation: "write",
      auth: HUMAN,
      positionals: [ref("connection")],
      options: [...INPUT_OPTIONS, { name: "name", type: "string", valueName: "name", description: "Connection display name" }],
      body: (i) => requestBody(i, { name: stringOption(i, "name") ?? undefined }),
    }),
    op({ id: "messaging.connection.delete", path: ["messaging", "connection", "delete"], description: "Delete a connection with its sources, messages and outcomes", method: "DELETE", apiPath: connection, mutation: "destructive", auth: HUMAN, positionals: [ref("connection")] }),
    op({ id: "messaging.connection.check", path: ["messaging", "connection", "check"], description: "Ask the provider whether the connection still works", method: "POST", apiPath: (i) => `${connection(i)}/check`, mutation: "write", auth: HUMAN, positionals: [ref("connection")] }),
    op({ id: "messaging.source.list", path: ["messaging", "source", "list"], description: "List message sources", method: "GET", apiPath: (i) => `${workspaceBase(i)}/sources`, auth: HUMAN, collections: ["sources"] }),
    op({ id: "messaging.source.get", path: ["messaging", "source", "get"], description: "Get a message source", method: "GET", apiPath: source, auth: HUMAN, positionals: [ref("source")] }),
    op({ id: "messaging.source.status", path: ["messaging", "source", "status"], description: "Show sync health, lag, and unresolved backlog", method: "GET", apiPath: (i) => `${source(i)}/status`, auth: HUMAN_TASK, positionals: [ref("source")] }),
    op({ id: "messaging.source.add", path: ["messaging", "source", "add"], description: "Add a source that ingests through a connection", method: "POST", apiPath: (i) => `${workspaceBase(i)}/sources`, mutation: "write", auth: HUMAN, options: [...INPUT_OPTIONS, ...sourceFields], body: sourceBody }),
    op({ id: "messaging.source.update", path: ["messaging", "source", "update"], description: "Update a source and its allowlist", method: "PATCH", apiPath: source, mutation: "write", auth: HUMAN, positionals: [ref("source")], options: [...INPUT_OPTIONS, ...sourceFields], body: sourceBody }),
    op({ id: "messaging.source.delete", path: ["messaging", "source", "delete"], description: "Delete a source with its messages, outcomes and sync cursor", method: "DELETE", apiPath: source, mutation: "destructive", auth: HUMAN, positionals: [ref("source")] }),
    op({
      id: "messaging.source.available-conversations",
      path: ["messaging", "source", "available-conversations"],
      description: "Search candidate conversations for a source allowlist through its provider",
      method: "GET",
      apiPath: (i) => `${source(i)}/available-conversations`,
      auth: HUMAN,
      positionals: [ref("source")],
      query: (i) => ({
        q: stringOption(i, "query"),
        cursor: stringOption(i, "cursor"),
        limit: integerOption(i, "limit"),
      }),
      collections: ["conversations"],
    }),
    op({
      id: "messaging.conversation.list",
      path: ["messaging", "conversation", "list"],
      description: "List conversations that have already delivered messages",
      method: "GET",
      apiPath: (i) => `${workspaceBase(i)}/conversations`,
      auth: HUMAN_TASK,
      collections: ["conversations"],
    }),
    op({
      id: "messaging.message.list",
      path: ["messaging", "message", "list"],
      description: "List ingested messages",
      method: "GET",
      apiPath: (i) => `${workspaceBase(i)}/messages`,
      auth: HUMAN_TASK,
      options: [
        { name: "unprocessed", type: "boolean", conflictsWith: ["processed"], description: "Only messages without an outcome" },
        { name: "processed", type: "boolean", conflictsWith: ["unprocessed"], description: "Only messages that already have an outcome" },
        { name: "source", type: "string", valueName: "id", description: "Filter by source ID" },
        { name: "connection", type: "string", valueName: "id", description: "Filter by connection ID" },
        { name: "conversation", type: "string", valueName: "id", description: "Filter by conversation ID" },
        { name: "since", type: "string", valueName: "timestamp", description: "Earliest message timestamp" },
        { name: "until", type: "string", valueName: "timestamp", description: "Latest message timestamp" },
        { name: "offset", type: "integer", valueName: "count", description: "Skip this many messages" },
      ],
      query: (i) => ({
        limit: integerOption(i, "limit"),
        offset: integerOption(i, "offset"),
        unprocessed: booleanOption(i, "unprocessed"),
        processed: booleanOption(i, "processed"),
        // Literal text, not a wildcard pattern.
        q: stringOption(i, "query"),
        source: stringOption(i, "source"),
        connection: stringOption(i, "connection"),
        conversation: stringOption(i, "conversation"),
        since: stringOption(i, "since"),
        until: stringOption(i, "until"),
      }),
      collections: ["messages"],
    }),
    op({
      id: "messaging.message.get",
      path: ["messaging", "message", "get"],
      description: "Get one message and everything already decided about it",
      method: "GET",
      apiPath: message,
      auth: HUMAN_TASK,
      positionals: messageRef,
    }),
    op({
      id: "messaging.message.resolve",
      path: ["messaging", "message", "resolve"],
      description: "Record a message outcome and mark it processed",
      method: "POST",
      apiPath: (i) => `${message(i)}/resolve`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: messageRef,
      options: [
        { name: "outcome", type: "string", valueName: "kind", required: true, description: "ignored or dismissed" },
        { name: "reason", type: "string", valueName: "text", description: "Decision reason" },
        { name: "task-id", type: "string", valueName: "id", description: "Processing task ID (human calls only)" },
      ],
      body: (i) => requestBody(i, {
        outcome: requiredStringOption(i, "outcome"),
        reason: stringOption(i, "reason") ?? undefined,
        task_id: stringOption(i, "task-id") ?? undefined,
      }),
    }),
    op({
      id: "messaging.message.notify",
      path: ["messaging", "message", "notify"],
      description: "Create an Inbox reminder for a message",
      method: "POST",
      apiPath: (i) => `${message(i)}/notify`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: messageRef,
      options: [{ name: "summary", type: "string", valueName: "text", required: true, description: "Reminder summary" }],
      body: (i) => requestBody(i, { summary: requiredStringOption(i, "summary") }),
    }),
    op({
      id: "messaging.message.draft-reply",
      path: ["messaging", "message", "draft-reply"],
      description: "Create an Inbox reply draft for a message",
      method: "POST",
      apiPath: (i) => `${message(i)}/draft-reply`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: messageRef,
      options: [{ name: "draft-text", type: "string", valueName: "text", required: true, description: "Reply draft text" }],
      body: (i) => requestBody(i, { draft_text: requiredStringOption(i, "draft-text") }),
    }),
    op({
      id: "messaging.message.propose-issue",
      path: ["messaging", "message", "propose-issue"],
      description: "Propose an Issue for human approval and resolve a message",
      method: "POST",
      apiPath: (i) => `${message(i)}/propose-issue`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: messageRef,
      options: issueProposalOptions,
      body: issueProposalBody,
    }),
    op({
      id: "messaging.message.create-issue",
      path: ["messaging", "message", "create-issue"],
      description: "Atomically create an Issue and resolve a message",
      method: "POST",
      apiPath: (i) => `${message(i)}/create-issue`,
      mutation: "write",
      auth: HUMAN,
      positionals: messageRef,
      options: issueProposalOptions,
      body: issueProposalBody,
    }),
    op({
      id: "messaging.proposal.list",
      path: ["messaging", "proposal", "list"],
      description: "List Issue proposals awaiting human approval",
      method: "GET",
      apiPath: (i) => `${workspaceBase(i)}/proposals`,
      auth: HUMAN_TASK,
      options: [
        { name: "status", type: "string", valueName: "status", description: "pending, approved, or rejected" },
        { name: "source", type: "string", valueName: "id", description: "Filter by source ID" },
        { name: "offset", type: "integer", valueName: "count", description: "Skip this many proposals" },
      ],
      query: (i) => ({
        status: stringOption(i, "status"),
        source: stringOption(i, "source"),
        limit: integerOption(i, "limit"),
        offset: integerOption(i, "offset"),
      }),
      collections: ["proposals"],
    }),
    op({
      id: "messaging.proposal.approve",
      path: ["messaging", "proposal", "approve"],
      description: "Approve an Issue proposal",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/proposals/${encodePath(positional(i, 0, "proposal"))}/approve`,
      mutation: "write",
      auth: HUMAN,
      positionals: [ref("proposal")],
    }),
    op({
      id: "messaging.proposal.reject",
      path: ["messaging", "proposal", "reject"],
      description: "Reject an Issue proposal",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/proposals/${encodePath(positional(i, 0, "proposal"))}/reject`,
      mutation: "write",
      auth: HUMAN,
      positionals: [ref("proposal")],
    }),
  ];
}

function feishuSpecs(): CommandSpec[] {
  const workspaceBase = (i: CommandInvocation) =>
    `/api/workspaces/${encodePath(requiredWorkspace(i))}/feishu`;
  const source = (i: CommandInvocation) =>
    `${workspaceBase(i)}/sources/${encodePath(positional(i, 0, "source"))}`;
  const sourceFields: readonly CliOptionSpec[] = [
    { name: "name", type: "string", valueName: "name", description: "Source display name" },
    { name: "endpoint-name", type: "string", valueName: "name", description: "Legacy endpoint name; maps to a messaging connection" },
    { name: "chat", type: "string", valueName: "chat-id", repeatable: true, description: "Allowlisted chat ID" },
    { name: "clear-allowlist", type: "boolean", conflictsWith: ["chat"], description: "Replace the allowlist with an empty list" },
    { name: "enabled", type: "boolean", description: "Enable or disable ingestion" },
    { name: "retention-days", type: "integer", valueName: "days", description: "Message retention period" },
    { name: "poll-interval-seconds", type: "integer", valueName: "seconds", description: "Minimum poll interval" },
    { name: "unprocessed-retry-seconds", type: "integer", valueName: "seconds", description: "Delay before retrying unresolved messages" },
    { name: "unprocessed-retry-limit", type: "integer", valueName: "count", description: "Retries before timeout dismissal" },
  ];
  const sourceBody = (i: CommandInvocation) => requestBody(i, {
    name: stringOption(i, "name") ?? undefined,
    endpoint_name: stringOption(i, "endpoint-name") ?? undefined,
    allowlist: booleanOption(i, "clear-allowlist")
      ? []
      : i.options.chat === undefined ? undefined : stringOptions(i, "chat"),
    enabled: booleanOption(i, "enabled") ?? undefined,
    retention_days: integerOption(i, "retention-days") ?? undefined,
    poll_interval_seconds: integerOption(i, "poll-interval-seconds") ?? undefined,
    unprocessed_retry_seconds: integerOption(i, "unprocessed-retry-seconds") ?? undefined,
    unprocessed_retry_limit: integerOption(i, "unprocessed-retry-limit") ?? undefined,
  });
  const issueProposalOptions: readonly CliOptionSpec[] = [
    { name: "title", type: "string", valueName: "text", required: true, description: "Issue title" },
    { name: "description", type: "string", valueName: "text", description: "Issue description" },
    { name: "project-id", type: "string", valueName: "id", description: "Project ID" },
    { name: "priority", type: "string", valueName: "priority", description: "Issue priority" },
    { name: "assignee-type", type: "string", valueName: "type", description: "Suggested assignee type" },
    { name: "assignee-id", type: "string", valueName: "id", description: "Suggested assignee ID" },
  ];
  const issueProposalBody = (i: CommandInvocation) => requestBody(i, {
    title: requiredStringOption(i, "title"),
    description: stringOption(i, "description") ?? undefined,
    project_id: stringOption(i, "project-id") ?? undefined,
    priority: stringOption(i, "priority") ?? undefined,
    assignee_type: stringOption(i, "assignee-type") ?? undefined,
    assignee_id: stringOption(i, "assignee-id") ?? undefined,
  });
  return [
    group("feishu", "Ingest and process allowlisted Feishu messages"),
    op({ id: "feishu.source.list", path: ["feishu", "source", "list"], description: "List Feishu message sources", method: "GET", apiPath: (i) => `${workspaceBase(i)}/sources`, auth: HUMAN, collections: ["sources"] }),
    op({ id: "feishu.source.get", path: ["feishu", "source", "get"], description: "Get a Feishu message source", method: "GET", apiPath: source, auth: HUMAN, positionals: [ref("source")] }),
    op({ id: "feishu.source.status", path: ["feishu", "source", "status"], description: "Show connection health, lag, and unresolved backlog", method: "GET", apiPath: (i) => `${source(i)}/status`, auth: HUMAN_TASK, positionals: [ref("source")] }),
    op({ id: "feishu.source.add", path: ["feishu", "source", "add"], description: "Add a Feishu source (legacy id space; prefer remi messaging source add)", method: "POST", apiPath: (i) => `${workspaceBase(i)}/sources`, mutation: "write", auth: HUMAN, options: [...INPUT_OPTIONS, ...sourceFields], body: sourceBody }),
    op({ id: "feishu.source.update", path: ["feishu", "source", "update"], description: "Update a Feishu source and its allowlist", method: "PATCH", apiPath: source, mutation: "write", auth: HUMAN, positionals: [ref("source")], options: [...INPUT_OPTIONS, ...sourceFields], body: sourceBody }),
    op({ id: "feishu.source.delete", path: ["feishu", "source", "delete"], description: "Delete a Feishu source with its messages and outcomes", method: "DELETE", apiPath: source, mutation: "destructive", auth: HUMAN, positionals: [ref("source")] }),
    op({ id: "feishu.endpoint.list", path: ["feishu", "endpoint", "list"], description: "List legacy endpoint names and health", method: "GET", apiPath: (i) => `${workspaceBase(i)}/endpoints`, auth: HUMAN, collections: ["endpoints"] }),
    op({ id: "feishu.endpoint.check", path: ["feishu", "endpoint", "check"], description: "Re-probe one legacy endpoint", method: "POST", apiPath: (i) => `${workspaceBase(i)}/endpoints/${encodePath(positional(i, 0, "endpoint"))}/check`, mutation: "write", auth: HUMAN, positionals: [ref("endpoint")] }),
    op({
      id: "feishu.source.available-chats",
      path: ["feishu", "source", "available-chats"],
      description: "Search candidate chats for a source allowlist through its endpoint",
      method: "GET",
      apiPath: (i) => `${source(i)}/available-chats`,
      auth: HUMAN,
      positionals: [ref("source")],
      options: [
        { name: "query", type: "string", valueName: "text", required: true, description: "Chat or person name, email, or exact ID" },
        { name: "scope", type: "string", valueName: "scope", description: "group (default) or person" },
      ],
      query: (i) => ({
        q: requiredStringOption(i, "query"),
        scope: stringOption(i, "scope"),
        limit: integerOption(i, "limit"),
      }),
      collections: ["chats"],
    }),
    op({
      id: "feishu.chats.list",
      path: ["feishu", "chats", "list"],
      description: "List chats that have already delivered messages",
      method: "GET",
      apiPath: (i) => `${workspaceBase(i)}/chats`,
      auth: HUMAN_TASK,
      collections: ["chats"],
    }),
    op({
      id: "feishu.proposals.list",
      path: ["feishu", "proposals", "list"],
      description: "List Issue proposals awaiting human approval",
      method: "GET",
      apiPath: (i) => `${workspaceBase(i)}/proposals`,
      auth: HUMAN_TASK,
      options: [
        { name: "status", type: "string", valueName: "status", description: "pending, approved, or rejected" },
        { name: "source", type: "string", valueName: "id", description: "Filter by source ID" },
        { name: "offset", type: "integer", valueName: "count", description: "Skip this many proposals" },
      ],
      query: (i) => ({
        status: stringOption(i, "status"),
        source: stringOption(i, "source"),
        limit: integerOption(i, "limit"),
        offset: integerOption(i, "offset"),
      }),
      collections: ["proposals"],
    }),
    op({
      id: "feishu.messages.list",
      path: ["feishu", "messages", "list"],
      description: "List ingested Feishu messages",
      method: "GET",
      apiPath: (i) => `${workspaceBase(i)}/messages`,
      auth: HUMAN_TASK,
      options: [
        { name: "unprocessed", type: "boolean", conflictsWith: ["processed"], description: "Only messages without an outcome" },
        { name: "processed", type: "boolean", conflictsWith: ["unprocessed"], description: "Only messages that already have an outcome" },
        { name: "query", type: "string", valueName: "text", description: "Match message text (literal, not a wildcard pattern)" },
        { name: "source", type: "string", valueName: "id", description: "Filter by source ID" },
        { name: "since", type: "string", valueName: "timestamp", description: "Earliest message timestamp" },
        { name: "until", type: "string", valueName: "timestamp", description: "Latest message timestamp" },
        { name: "chat", type: "string", valueName: "chat-id", description: "Filter by chat ID" },
        { name: "offset", type: "integer", valueName: "count", description: "Skip this many messages" },
      ],
      query: (i) => ({
        limit: integerOption(i, "limit"),
        offset: integerOption(i, "offset"),
        unprocessed: booleanOption(i, "unprocessed"),
        processed: booleanOption(i, "processed"),
        q: stringOption(i, "query"),
        source: stringOption(i, "source"),
        since: stringOption(i, "since"),
        until: stringOption(i, "until"),
        chat: stringOption(i, "chat"),
      }),
      collections: ["messages"],
    }),
    op({
      id: "feishu.messages.resolve",
      path: ["feishu", "messages", "resolve"],
      description: "Record a message outcome and mark it processed",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/messages/${encodePath(positional(i, 0, "message"))}/resolve`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: [ref("message")],
      options: [
        { name: "outcome", type: "string", valueName: "kind", required: true, description: "ignored or dismissed" },
        { name: "reason", type: "string", valueName: "text", description: "Decision reason" },
        { name: "task-id", type: "string", valueName: "id", description: "Processing task ID (human calls only)" },
      ],
      body: (i) => requestBody(i, {
        outcome: requiredStringOption(i, "outcome"),
        reason: stringOption(i, "reason") ?? undefined,
        task_id: stringOption(i, "task-id") ?? undefined,
      }),
    }),
    op({
      id: "feishu.messages.create-issue",
      path: ["feishu", "messages", "create-issue"],
      description: "Atomically create an Issue and resolve a Feishu message",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/messages/${encodePath(positional(i, 0, "message"))}/create-issue`,
      mutation: "write",
      auth: HUMAN,
      positionals: [ref("message")],
      options: issueProposalOptions,
      body: issueProposalBody,
    }),
    op({
      id: "feishu.messages.propose-issue",
      path: ["feishu", "messages", "propose-issue"],
      description: "Propose an Issue for human approval and resolve a Feishu message",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/messages/${encodePath(positional(i, 0, "message"))}/propose-issue`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: [ref("message")],
      options: issueProposalOptions,
      body: issueProposalBody,
    }),
    op({
      id: "feishu.messages.notify",
      path: ["feishu", "messages", "notify"],
      description: "Create an Inbox reminder for a Feishu message",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/messages/${encodePath(positional(i, 0, "message"))}/notify`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: [ref("message")],
      options: [{ name: "summary", type: "string", valueName: "text", required: true, description: "Reminder summary" }],
      body: (i) => requestBody(i, { summary: requiredStringOption(i, "summary") }),
    }),
    op({
      id: "feishu.messages.draft-reply",
      path: ["feishu", "messages", "draft-reply"],
      description: "Create an Inbox reply draft for a Feishu message",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/messages/${encodePath(positional(i, 0, "message"))}/draft-reply`,
      mutation: "write",
      auth: HUMAN_TASK,
      positionals: [ref("message")],
      options: [{ name: "draft-text", type: "string", valueName: "text", required: true, description: "Reply draft text" }],
      body: (i) => requestBody(i, { draft_text: requiredStringOption(i, "draft-text") }),
    }),
    op({
      id: "feishu.proposals.approve",
      path: ["feishu", "proposals", "approve"],
      description: "Approve a Feishu Issue proposal",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/proposals/${encodePath(positional(i, 0, "proposal"))}/approve`,
      mutation: "write",
      auth: HUMAN,
      positionals: [ref("proposal")],
    }),
    op({
      id: "feishu.proposals.reject",
      path: ["feishu", "proposals", "reject"],
      description: "Reject a Feishu Issue proposal",
      method: "POST",
      apiPath: (i) => `${workspaceBase(i)}/proposals/${encodePath(positional(i, 0, "proposal"))}/reject`,
      mutation: "write",
      auth: HUMAN,
      positionals: [ref("proposal")],
    }),
  ];
}

function inboxSpecs(): CommandSpec[] {
  const timezoneOffsetOption: CliOptionSpec = {
    name: "timezone-offset",
    type: "integer",
    valueName: "minutes",
    description: "Browser-style UTC offset used for grouped counts",
  };
  return [
    group("inbox", "Read and archive inbox items"),
    op({ id: "inbox.list", path: ["inbox", "list"], description: "List inbox items", method: "GET", apiPath: "/api/inbox", auth: HUMAN_TASK, collections: ["items"] }),
    op({ id: "inbox.page", path: ["inbox", "page"], description: "List one inbox page", method: "GET", apiPath: "/api/inbox/page", auth: HUMAN_TASK, options: PAGE_OPTIONS, query: queryOptions, collections: ["items"] }),
    op({ id: "inbox.summary", path: ["inbox", "summary"], description: "Get grouped inbox counts", method: "GET", apiPath: "/api/inbox/summary", auth: HUMAN_TASK, options: [timezoneOffsetOption], query: (i) => ({ timezone_offset: integerOption(i, "timezone-offset") }) }),
    op({ id: "inbox.unread-count", path: ["inbox", "unread-count"], description: "Get unread inbox count", method: "GET", apiPath: "/api/inbox/unread-count", auth: HUMAN_TASK }),
    ...["read", "archive"].map((action) => op({ id: `inbox.${action}`, path: ["inbox", action], description: `${capital(action)} an inbox item`, method: "POST", apiPath: (i) => `/api/inbox/${encodePath(positional(i, 0, "item"))}/${action}`, mutation: "write", auth: HUMAN_TASK, positionals: [ref("item")] })),
    ...[
      ["inbox.mark-all-read", ["inbox", "mark-all-read"], "/api/inbox/mark-all-read", "Mark all inbox items read"],
      ["inbox.archive-all", ["inbox", "archive-all"], "/api/inbox/archive-all", "Archive all inbox items"],
      ["inbox.archive-all-read", ["inbox", "archive-all-read"], "/api/inbox/archive-all-read", "Archive all read inbox items"],
      ["inbox.archive-completed", ["inbox", "archive-completed"], "/api/inbox/archive-completed", "Archive completed inbox items"],
    ].map(([id, path, apiPath, description]) => op({ id: id as string, path: path as string[], description: description as string, method: "POST", apiPath: apiPath as string, mutation: "destructive", auth: HUMAN_TASK })),
  ];
}

function notificationSpecs(): CommandSpec[] {
  const channelPath = async (invocation: CommandInvocation, client: CliApiClient) => {
    const channelId = await resolveListedId(
      client,
      invocation,
      positional(invocation, 0, "channel"),
      "notification channel",
      "/api/multiremi/notification-channels",
      ["channels"],
    );
    return `/api/multiremi/notification-channels/${encodePath(channelId)}`;
  };
  const deliveryStatusOption: CliOptionSpec = {
    name: "status",
    type: "string",
    valueName: "pending|sent|failed",
    description: "Delivery status filter",
  };
  return [
    group("notification", "Manage notification preferences"),
    op({ id: "notification.get", path: ["notification", "get"], description: "Get notification preferences", method: "GET", apiPath: "/api/notification-preferences", auth: HUMAN_TASK, query: (i) => ({ workspace_id: requiredWorkspace(i) }) }),
    op({ id: "notification.update", path: ["notification", "update"], description: "Update notification preferences", method: "PUT", apiPath: "/api/notification-preferences", mutation: "write", auth: HUMAN_TASK, options: INPUT_OPTIONS, body: withWorkspace }),
    op({ id: "notification.channel.list", path: ["notification", "channel", "list"], description: "List outbound notification channels", method: "GET", apiPath: "/api/multiremi/notification-channels", auth: HUMAN_TASK, query: (i) => ({ workspace_id: requiredWorkspace(i) }), collections: ["channels"] }),
    op({ id: "notification.channel.create", path: ["notification", "channel", "create"], description: "Create an outbound notification channel", method: "POST", apiPath: "/api/multiremi/notification-channels", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS, body: withWorkspace }),
    op({ id: "notification.channel.update", path: ["notification", "channel", "update"], description: "Update an outbound notification channel", method: "PATCH", apiPath: channelPath, mutation: "write", auth: HUMAN, positionals: [ref("channel")], options: INPUT_OPTIONS }),
    op({ id: "notification.channel.delete", path: ["notification", "channel", "delete"], description: "Delete an outbound notification channel", method: "DELETE", apiPath: channelPath, mutation: "destructive", auth: HUMAN, positionals: [ref("channel")] }),
    op({ id: "notification.delivery.list", path: ["notification", "delivery", "list"], description: "List outbound notification deliveries", method: "GET", apiPath: "/api/multiremi/notification-deliveries", auth: HUMAN_TASK, options: [deliveryStatusOption], query: (i) => queryOptions(i, { workspace_id: requiredWorkspace(i), status: stringOption(i, "status") }), collections: ["deliveries"] }),
    op({ id: "notification.delivery.retry", path: ["notification", "delivery", "retry"], description: "Retry an outbound notification delivery", method: "POST", apiPath: (i) => `/api/multiremi/notification-deliveries/${encodePath(positional(i, 0, "delivery"))}/retry`, mutation: "write", auth: HUMAN, positionals: [ref("delivery")] }),
  ];
}

function pinSpecs(): CommandSpec[] {
  return [
    group("pin", "Manage pinned resources"),
    op({ id: "pin.list", path: ["pin", "list"], description: "List pinned resources", method: "GET", apiPath: "/api/pins", auth: HUMAN_TASK, collections: ["pins"] }),
    op({ id: "pin.create", path: ["pin", "create"], description: "Pin a resource", method: "POST", apiPath: "/api/pins", mutation: "write", auth: HUMAN_TASK, options: INPUT_OPTIONS, body: withWorkspace }),
    op({ id: "pin.reorder", path: ["pin", "reorder"], description: "Reorder pinned resources", method: "PUT", apiPath: "/api/pins/reorder", mutation: "write", auth: HUMAN_TASK, options: INPUT_OPTIONS, body: withWorkspace }),
    op({ id: "pin.delete", path: ["pin", "delete"], description: "Remove a pinned resource", method: "DELETE", apiPath: (i) => `/api/pins/${encodePath(positional(i, 0, "type"))}/${encodePath(positional(i, 1, "resource"))}`, mutation: "destructive", auth: HUMAN_TASK, positionals: [ref("type"), ref("resource")] }),
  ];
}

function dashboardSpecs(): CommandSpec[] {
  return [
    group("dashboard", "Read workspace activity and usage analytics"),
    ...[
      ["dashboard.usage.daily", ["dashboard", "usage", "daily"], "/api/dashboard/usage/daily", "Get daily usage"],
      ["dashboard.usage.by-agent", ["dashboard", "usage", "by-agent"], "/api/dashboard/usage/by-agent", "Get usage by agent"],
      ["dashboard.runtime.daily", ["dashboard", "runtime", "daily"], "/api/dashboard/runtime/daily", "Get runtime daily activity"],
      ["dashboard.agent-runtime", ["dashboard", "agent-runtime"], "/api/dashboard/agent-runtime", "Get agent runtime activity"],
      ["dashboard.agent-activity", ["dashboard", "agent-activity"], "/api/agent-activity-30d", "Get 30-day agent activity"],
      ["dashboard.agent-runs", ["dashboard", "agent-runs"], "/api/agent-run-counts", "Get agent run counts"],
      ["dashboard.agent-tasks", ["dashboard", "agent-tasks"], "/api/agent-task-snapshot", "Get agent task snapshot"],
      ["dashboard.assignee-frequency", ["dashboard", "assignee-frequency"], "/api/assignee-frequency", "Get assignee frequency"],
    ].map(([id, path, apiPath, description]) => op({ id: id as string, path: path as string[], description: description as string, method: "GET", apiPath: apiPath as string, auth: HUMAN_TASK, query: (i) => queryOptions(i, { workspace_id: requiredWorkspace(i) }) })),
  ];
}

function platformSpecs(): CommandSpec[] {
  return [
    group("platform", "Inspect platform health, feedback, releases, and operations"),
    ...[
      ["platform.health", ["platform", "health"], "/health", "Get platform health"],
      ["platform.ready", ["platform", "ready"], "/readyz", "Get platform readiness"],
      ["platform.realtime", ["platform", "realtime"], "/health/realtime", "Get realtime transport health"],
      ["platform.config", ["platform", "config"], "/api/multiremi/platform/config", "Get effective platform configuration and degradation status"],
      ["platform.status", ["platform", "status"], "/api/multiremi/platform/status", "Get platform deployment status"],
      ["platform.operation.list", ["platform", "operation", "list"], "/api/multiremi/platform/operations", "List platform operations"],
      ["platform.feedback.list", ["platform", "feedback", "list"], "/api/multiremi/feedback", "List product feedback"],
      ["platform.release.version", ["platform", "release", "version"], "/api/remi/releases/latest/version", "Get the latest CLI release version"],
    ].map(([id, path, apiPath, description]) => op({ id: id as string, path: path as string[], description: description as string, method: "GET", apiPath: apiPath as string, auth: HUMAN })),
    op({ id: "platform.feedback.create", path: ["platform", "feedback", "create"], description: "Submit product feedback", method: "POST", apiPath: "/api/feedback", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "platform.settings.update", path: ["platform", "settings", "update"], description: "Update platform settings", method: "PATCH", apiPath: "/api/multiremi/platform/settings", mutation: "destructive", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "platform.operation.create", path: ["platform", "operation", "create"], description: "Queue a platform update, restart, rollback, or update check", method: "POST", apiPath: "/api/multiremi/platform/operations", mutation: "destructive", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "platform.operation.cancel", path: ["platform", "operation", "cancel"], description: "Cancel a queued or running platform operation", method: "POST", apiPath: (i) => `/api/multiremi/platform/operations/${encodePath(positional(i, 0, "operation"))}/cancel`, mutation: "destructive", auth: HUMAN, positionals: [ref("operation")] }),
    op({ id: "platform.release.latest", path: ["platform", "release", "latest"], description: "Get latest release metadata", method: "GET", apiPath: (i) => `/api/remi/releases/latest/${encodePath(positional(i, 0, "filename"))}`, auth: HUMAN, positionals: [ref("filename")] }),
    op({ id: "platform.release.get", path: ["platform", "release", "get"], description: "Get tagged release metadata", method: "GET", apiPath: (i) => `/api/remi/releases/download/${encodePath(positional(i, 0, "tag"))}/${encodePath(positional(i, 1, "filename"))}`, auth: HUMAN, positionals: [ref("tag"), ref("filename")] }),
    platformUpdateAlias(),
  ];
}

function platformUpdateAlias(): CommandSpec {
  return {
    id: "platform.local.update",
    path: ["platform", "local-update"],
    description: "Run the local CLI updater",
    auth: HUMAN,
    mutation: "destructive",
    outputs: ["table", "json", "jsonl"],
    parse: "passthrough",
    aliases: [{ path: ["update"], deprecatedSince: DEPRECATED_SINCE, replacement: "remi platform operation create", dispatch: false }],
    run: async (invocation) => {
      const { runUpdate } = await import("../update.js");
      await runUpdate([...invocation.rawArgs]);
    },
  };
}

function billingSpecs(): CommandSpec[] {
  return [
    group("billing", "Inspect billing and create checkout or portal sessions"),
    ...[
      ["billing.balance", ["billing", "balance"], "/api/cloud-billing/balance", "Get billing balance"],
      ["billing.transaction.list", ["billing", "transaction", "list"], "/api/cloud-billing/transactions", "List billing transactions"],
      ["billing.batch.list", ["billing", "batch", "list"], "/api/cloud-billing/batches", "List billing batches"],
      ["billing.topup.list", ["billing", "topup", "list"], "/api/cloud-billing/topups", "List top-ups"],
      ["billing.tier.list", ["billing", "tier", "list"], "/api/cloud-billing/price-tiers", "List price tiers"],
    ].map(([id, path, apiPath, description]) => op({ id: id as string, path: path as string[], description: description as string, method: "GET", apiPath: apiPath as string, auth: HUMAN })),
    op({ id: "billing.checkout.create", path: ["billing", "checkout", "create"], description: "Create a checkout session", method: "POST", apiPath: "/api/cloud-billing/checkout-sessions", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "billing.checkout.get", path: ["billing", "checkout", "get"], description: "Get a checkout session", method: "GET", apiPath: (i) => `/api/cloud-billing/checkout-sessions/${encodePath(positional(i, 0, "session"))}`, auth: HUMAN, positionals: [ref("session")] }),
    op({ id: "billing.portal.create", path: ["billing", "portal", "create"], description: "Create a billing portal session", method: "POST", apiPath: "/api/cloud-billing/portal-sessions", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS }),
  ];
}

function larkSpecs(): CommandSpec[] {
  return [
    group("lark", "Manage Lark workspace installations and bindings"),
    op({ id: "lark.installation.list", path: ["lark", "installation", "list"], description: "List Lark installations", method: "GET", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/lark/installations`, auth: HUMAN, collections: ["installations"] }),
    op({ id: "lark.install.begin", path: ["lark", "install", "begin"], description: "Begin Lark installation", method: "POST", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/lark/install/begin`, mutation: "write", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "lark.install.status", path: ["lark", "install", "status"], description: "Get Lark installation status", method: "GET", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/lark/install/${encodePath(positional(i, 0, "session"))}/status`, auth: HUMAN, positionals: [ref("session")] }),
    op({ id: "lark.installation.delete", path: ["lark", "installation", "delete"], description: "Delete a Lark installation", method: "DELETE", apiPath: (i) => `/api/workspaces/${encodePath(requiredWorkspace(i))}/lark/installations/${encodePath(positional(i, 0, "installation"))}`, mutation: "destructive", auth: HUMAN, positionals: [ref("installation")] }),
    op({ id: "lark.binding.redeem", path: ["lark", "binding", "redeem"], description: "Redeem a Lark binding code", method: "POST", apiPath: "/api/lark/binding/redeem", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "lark.daemon.install", path: ["lark", "daemon", "install"], description: "Install daemon Lark support", method: "POST", apiPath: "/api/multiremi/install/daemon", mutation: "destructive", auth: HUMAN, options: INPUT_OPTIONS }),
    op({ id: "lark.daemon.status", path: ["lark", "daemon", "status"], description: "Get daemon Lark install state", method: "GET", apiPath: "/api/multiremi/install/daemon", auth: HUMAN }),
  ];
}

function authContextSpecs(): CommandSpec[] {
  return [
    op({ id: "context.auth.lark", path: ["context", "auth", "lark"], description: "Get the Lark login URL", method: "GET", apiPath: "/auth/lark/url", auth: HUMAN, negotiate: false }),
    op({ id: "context.auth.google", path: ["context", "auth", "google"], description: "Authenticate with Google", method: "POST", apiPath: "/auth/google", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS, negotiate: false }),
    op({ id: "context.auth.send-code", path: ["context", "auth", "send-code"], description: "Send an email login code", method: "POST", apiPath: "/auth/send-code", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS, negotiate: false }),
    op({ id: "context.auth.verify-code", path: ["context", "auth", "verify-code"], description: "Verify an email login code", method: "POST", apiPath: "/auth/verify-code", mutation: "write", auth: HUMAN, options: INPUT_OPTIONS, negotiate: false }),
    op({ id: "context.auth.logout", path: ["context", "auth", "logout"], description: "Log out the current browser context", method: "POST", apiPath: "/auth/logout", mutation: "destructive", auth: HUMAN, negotiate: false }),
  ];
}

function op(definition: OperationDefinition): CommandSpec {
  const mutation = definition.mutation ?? (definition.method === "GET" ? "read" : "write");
  return {
    id: definition.id,
    path: definition.path,
    description: definition.description,
    capability: definition.id,
    auth: definition.auth ?? HUMAN,
    mutation,
    outputs: ["table", "json", "jsonl"],
    positionals: definition.positionals,
    aliases: definition.aliases,
    options: commandOptions(
      mutation === "read" ? PAGE_OPTIONS : [],
      definition.options ?? [],
      mutation === "destructive" ? [YES_OPTION] : [],
    ),
    run: async (invocation) => {
      if (mutation === "destructive") requireConfirmation(invocation);
      const client = await clientFor(invocation, { skipCapability: definition.negotiate === false });
      await definition.before?.(invocation, client);
      const path = typeof definition.apiPath === "string"
        ? definition.apiPath
        : await definition.apiPath(invocation, client);
      const body = definition.body
        ? await definition.body(invocation)
        : definition.method === "POST" || definition.method === "PUT" || definition.method === "PATCH"
          ? await requestBody(invocation)
          : undefined;
      const response = await client.request({
        method: definition.method,
        path,
        query: definition.query?.(invocation) ?? (mutation === "read" ? queryOptions(invocation) : undefined),
        body,
      });
      renderSafe(invocation, response.data, definition.collections);
    },
  };
}

function group(name: string, description: string): CommandSpec {
  return { id: `${name}.group`, path: [name], description, hidden: false, parse: "passthrough", run: async () => {} };
}

function ref(name: string): CliPositionalSpec {
  return { name, required: true };
}

async function withWorkspace(invocation: CommandInvocation): Promise<Record<string, unknown>> {
  return requestBody(invocation, { workspace_id: requiredWorkspace(invocation) });
}

async function resolveRuntimeId(client: CliApiClient, invocation: CommandInvocation, value: string): Promise<string> {
  return resolveListedId(client, invocation, value, "runtime", "/api/runtimes", ["runtimes"]);
}

async function resolveListedId(
  client: CliApiClient,
  invocation: CommandInvocation,
  value: string,
  kind: string,
  path: string,
  collections: readonly string[],
): Promise<string> {
  const list = async () => extractRecords((await client.request({
    method: "GET",
    path,
    query: queryOptions(invocation, { workspace_id: requiredWorkspace(invocation) }),
  })).data, collections);
  const resource = await new ResourceResolver<Record<string, unknown>>({
    kind,
    getById: async (id) => (await list()).find((entry) => entry.id === id) ?? null,
    search: list,
    id: (entry) => String(entry.id ?? ""),
    name: (entry) => typeof entry.name === "string" ? entry.name : typeof entry.title === "string" ? entry.title : null,
  }).resolve(value);
  return String(resource.id);
}

async function runtimeImpact(invocation: CommandInvocation, client: CliApiClient): Promise<void> {
  const runtimeId = await resolveRuntimeId(client, invocation, positional(invocation, 0, "runtime"));
  const response = await client.request({ method: "GET", path: "/api/agents", query: { workspace_id: requiredWorkspace(invocation), runtime_id: runtimeId } });
  const active = extractRecords(response.data, ["agents"]).filter((agent) => agent.status !== "archived");
  console.error(`Deleting runtime ${runtimeId}: ${active.length} active agent(s) are currently attached; active work may be interrupted.`);
}

async function scmImpact(invocation: CommandInvocation, client: CliApiClient): Promise<void> {
  const listPath = `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/scm/connections`;
  const connectionId = await resolveListedId(client, invocation, positional(invocation, 0, "connection"), "SCM connection", listPath, ["connections"]);
  const response = await client.request<Record<string, unknown>>({ method: "GET", path: `${listPath}/${encodePath(connectionId)}` });
  const connection = isRecord(response.data.connection) ? response.data.connection : {};
  const repositories = extractRecords(connection.repositories, ["repositories"]);
  console.error(`Deleting SCM connection ${connectionId}: ${repositories.length} repository binding(s) will stop receiving SCM events.`);
}

function changeRequestPath(invocation: CommandInvocation): string {
  return `/api/issues/${encodePath(positional(invocation, 0, "issue"))}/change-requests/${encodePath(positional(invocation, 1, "change-request"))}`;
}

function renderSafe(invocation: CommandInvocation, value: unknown, collections: readonly string[] = []): void {
  renderResource(invocation, omitSecretFields(sanitizeCliDetails(value)), collections);
}

function renderRuntimeCommandResult(invocation: CommandInvocation, value: Record<string, unknown>): void {
  if (outputMode(invocation) !== "table") {
    renderSafe(invocation, value);
    return;
  }
  const exitCode = value.exit_code ?? value.exitCode;
  console.log(`Exit code: ${exitCode == null ? "-" : String(exitCode)}`);
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

function omitSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitSecretFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:authorization|token|password|secret|api[-_]?key|credential|cookie)/i.test(key))
    .map(([key, entry]) => [key, omitSecretFields(entry)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function capital(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function requiredStringOption(invocation: CommandInvocation, name: string): string {
  const value = stringOption(invocation, name);
  if (!value) throw new CliError("usage", `--${name} is required`);
  return value;
}
