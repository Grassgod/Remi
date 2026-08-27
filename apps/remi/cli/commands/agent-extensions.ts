import {
  CliError,
  ResourceResolver,
  type CliApiClient,
  type CliIdentity,
  type CliMutation,
  type CliOptionSpec,
  type CommandAlias,
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
const DEPRECATED_SINCE = "0.3.0";

const AGENT_FIELDS: readonly CliOptionSpec[] = [
  { name: "name", type: "string", valueName: "name", description: "Agent name" },
  { name: "description", type: "string", valueName: "text", description: "Agent description" },
  { name: "instructions", type: "string", valueName: "text", description: "Agent instructions" },
  { name: "avatar-url", type: "string", valueName: "url", description: "Agent avatar URL" },
  { name: "provider", type: "string", valueName: "claude|codex", description: "Agent provider" },
  { name: "model", type: "string", valueName: "model", description: "Agent model" },
  { name: "thinking-level", type: "string", valueName: "level", description: "Reasoning effort" },
  { name: "visibility", type: "string", valueName: "private|workspace", description: "Agent visibility" },
  { name: "max-concurrent-tasks", type: "integer", valueName: "n", description: "Maximum concurrent tasks" },
  { name: "issue-creation-requires-proposal", type: "boolean", description: "Require human approval before this agent can create Issues" },
];

const SQUAD_FIELDS: readonly CliOptionSpec[] = [
  { name: "name", type: "string", valueName: "name", description: "Squad name" },
  { name: "description", type: "string", valueName: "text", description: "Squad description" },
  { name: "instructions", type: "string", valueName: "text", description: "Squad instructions" },
  { name: "avatar-url", type: "string", valueName: "url", description: "Squad avatar URL" },
  { name: "leader", type: "string", valueName: "agent-id", description: "Leader agent" },
];

const SKILL_FIELDS: readonly CliOptionSpec[] = [
  { name: "name", type: "string", valueName: "name", description: "Skill name" },
  { name: "description", type: "string", valueName: "text", description: "Skill description" },
  { name: "content", type: "string", valueName: "markdown", description: "Primary SKILL.md content" },
];

export function agentExtensionCommandSpecs(): CommandSpec[] {
  return [
    ...agentSpecs(),
    ...squadSpecs(),
    ...skillSpecs(),
    ...pluginSpecs(),
  ];
}

function agentSpecs(): CommandSpec[] {
  return [
    group("agent", "Manage agents, templates, skills, and provider plugins"),
    spec("agent.list", ["agent", "list"], "List agents", "read", HUMAN_TASK, [], [], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: "/api/agents", query: { workspace_id: requiredWorkspace(invocation) } });
      renderResource(invocation, response.data, ["agents"]);
    }, [legacyAlias(["multiremi", "agent", "list"], "remi agent list")]),
    spec("agent.get", ["agent", "get"], "Get an agent", "read", HUMAN_TASK, [ref("agent")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      const response = await client.request({ method: "GET", path: `/api/agents/${encodePath(String(agent.id))}` });
      renderResource(invocation, response.data);
    }, [legacyAlias(["multiremi", "agent", "get"], "remi agent get")]),
    spec("agent.create", ["agent", "create"], "Create an agent", "write", HUMAN, [], [...INPUT_OPTIONS, ...AGENT_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({
        method: "POST",
        path: "/api/agents",
        body: await requestBody(invocation, agentBody(invocation, true)),
      });
      renderResource(invocation, response.data);
    }),
    spec("agent.update", ["agent", "update"], "Update an agent", "write", HUMAN, [ref("agent")], [...INPUT_OPTIONS, ...AGENT_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      const response = await client.request({ method: "PUT", path: `/api/agents/${encodePath(String(agent.id))}`, body: await requestBody(invocation, agentBody(invocation, false)) });
      renderResource(invocation, response.data);
    }, [
      { path: ["agent", "edit"], deprecatedSince: DEPRECATED_SINCE, replacement: "remi agent update" },
      legacyAlias(["multiremi", "agent", "edit"], "remi agent update"),
      legacyAlias(["multiremi", "agent", "update"], "remi agent update"),
    ]),
    spec("agent.supervisor.set", ["agent", "supervisor", "set"], "Grant or revoke supervisor authority", "write", HUMAN, [ref("agent")], [
      { name: "enabled", type: "boolean", description: "Grant supervisor authority", conflictsWith: ["disabled"] },
      { name: "disabled", type: "boolean", description: "Revoke supervisor authority", conflictsWith: ["enabled"] },
    ], async (invocation) => {
      const { client, id } = await agentTarget(invocation);
      const enabled = invocation.options.enabled === true
        ? true
        : invocation.options.disabled === true
          ? false
          : null;
      if (enabled === null) throw new CliError("usage", "agent supervisor set requires --enabled or --disabled");
      const response = await client.request({ method: "PUT", path: `/api/agents/${encodePath(id)}/supervisor`, body: { enabled } });
      renderResource(invocation, response.data);
    }),
    spec("agent.archive", ["agent", "archive"], "Archive an agent", "destructive", HUMAN, [ref("agent")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/agents/${encodePath(String(agent.id))}/archive`, body: {} })).data);
    }),
    spec("agent.restore", ["agent", "restore"], "Restore an agent", "write", HUMAN, [ref("agent")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"), true);
      const response = await client.request({ method: "POST", path: `/api/agents/${encodePath(String(agent.id))}/restore`, body: {} });
      renderResource(invocation, response.data);
    }),
    spec("agent.default", ["agent", "default"], "Create or get the current user's default agent", "write", HUMAN, [], [
      { name: "provider", type: "string", valueName: "claude|codex", description: "Agent provider" },
      { name: "runtime", type: "string", valueName: "runtime-id", description: "Legacy runtime provider source" },
    ], async (invocation) => {
      if (invocation.alias?.path[0] === "seed") {
        const { runMultiremi } = await import("../multiremi.js");
        await runMultiremi(["seed", ...invocation.rawArgs], { programName: "remi multiremi" });
        return;
      }
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: "/api/multiremi/agents/default", body: {
        provider: stringOption(invocation, "provider") ?? "claude",
        runtime_id: stringOption(invocation, "runtime") ?? undefined,
        workspace_id: requiredWorkspace(invocation),
      } });
      renderResource(invocation, response.data);
    }, [
      { path: ["seed"], deprecatedSince: DEPRECATED_SINCE, replacement: "remi agent default" },
      legacyAlias(["multiremi", "seed"], "remi agent default", true),
    ]),
    spec("agent.cancel-tasks", ["agent", "cancel-tasks"], "Cancel all active tasks for an agent", "destructive", HUMAN, [ref("agent")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/agents/${encodePath(String(agent.id))}/cancel-tasks`, body: {} })).data);
    }),
    spec("agent.template.list", ["agent", "template", "list"], "List agent templates", "read", HUMAN, [], [], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "GET", path: "/api/agent-templates" })).data, ["templates"]);
    }),
    spec("agent.template.get", ["agent", "template", "get"], "Get an agent template", "read", HUMAN, [ref("template")], [], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "GET", path: `/api/agent-templates/${encodePath(positional(invocation, 0, "template"))}` })).data);
    }),
    spec("agent.template.create", ["agent", "template", "create"], "Create an agent from a template", "write", HUMAN, [ref("template")], [...INPUT_OPTIONS, ...AGENT_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: "/api/agents/from-template", body: await requestBody(invocation, {
        ...agentBody(invocation, true),
        template_slug: positional(invocation, 0, "template"),
      }) });
      renderResource(invocation, response.data);
    }),
    agentChildRead("agent.skill.list", ["agent", "skill", "list"], "List an agent's skills", "skills", "skills"),
    spec("agent.skill.set", ["agent", "skill", "set"], "Replace an agent's skills", "write", HUMAN, [ref("agent")], [
      { name: "skill", type: "string", valueName: "skill-id", repeatable: true, description: "Skill ID" },
    ], async (invocation) => {
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      renderResource(invocation, (await client.request({ method: "PUT", path: `/api/agents/${encodePath(String(agent.id))}/skills`, body: { skill_ids: stringOptions(invocation, "skill") } })).data, ["skills"]);
    }),
    spec("agent.skill.add", ["agent", "skill", "add"], "Add skills to an agent", "write", HUMAN, [ref("agent")], [
      { name: "skill", type: "string", valueName: "skill-id", repeatable: true, description: "Skill ID" },
    ], async (invocation) => {
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/agents/${encodePath(String(agent.id))}/skills/add`, body: { skill_ids: stringOptions(invocation, "skill") } })).data, ["skills"]);
    }),
    agentChildRead("agent.task.list", ["agent", "task", "list"], "List an agent's tasks", "tasks", "tasks"),
    spec("agent.env.get", ["agent", "env", "get"], "Get agent environment variables", "read", HUMAN, [ref("agent")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/agents/${encodePath(String(agent.id))}/env` })).data);
    }),
    spec("agent.env.update", ["agent", "env", "update"], "Replace agent environment variables", "write", HUMAN, [ref("agent")], INPUT_OPTIONS, async (invocation) => {
      const client = await clientFor(invocation);
      const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
      renderResource(invocation, (await client.request({ method: "PUT", path: `/api/agents/${encodePath(String(agent.id))}/env`, body: await requestBody(invocation) })).data);
    }),
    agentPluginSpecs(),
  ].flat();
}

function squadSpecs(): CommandSpec[] {
  return [
    group("squad", "Manage squads and squad membership"),
    spec("squad.list", ["squad", "list"], "List squads", "read", HUMAN_TASK, [], [], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "GET", path: "/api/squads", query: { workspace_id: requiredWorkspace(invocation) } })).data, ["squads"]);
    }),
    spec("squad.get", ["squad", "get"], "Get a squad", "read", HUMAN_TASK, [ref("squad")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const squad = await resolveSquad(client, invocation, positional(invocation, 0, "squad"));
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/squads/${encodePath(String(squad.id))}` })).data);
    }),
    spec("squad.create", ["squad", "create"], "Create a squad", "write", HUMAN, [], [...INPUT_OPTIONS, ...SQUAD_FIELDS], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "POST", path: "/api/squads", body: await requestBody(invocation, squadBody(invocation, true)) })).data);
    }),
    spec("squad.update", ["squad", "update"], "Update a squad", "write", HUMAN, [ref("squad")], [...INPUT_OPTIONS, ...SQUAD_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const squad = await resolveSquad(client, invocation, positional(invocation, 0, "squad"));
      renderResource(invocation, (await client.request({ method: "PUT", path: `/api/squads/${encodePath(String(squad.id))}`, body: await requestBody(invocation, squadBody(invocation, false)) })).data);
    }),
    spec("squad.archive", ["squad", "archive"], "Archive a squad", "destructive", HUMAN, [ref("squad")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const squad = await resolveSquad(client, invocation, positional(invocation, 0, "squad"));
      renderResource(invocation, (await client.request({ method: "DELETE", path: `/api/squads/${encodePath(String(squad.id))}` })).data);
    }, [{ path: ["squad", "delete"], deprecatedSince: DEPRECATED_SINCE, replacement: "remi squad archive" }]),
    spec("squad.member.list", ["squad", "member", "list"], "List squad members", "read", HUMAN_TASK, [ref("squad")], [], async (invocation) => {
      const { client, id } = await squadTarget(invocation);
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/squads/${encodePath(id)}/members` })).data, ["members"]);
    }),
    spec("squad.member.status", ["squad", "member", "status"], "List squad member status", "read", HUMAN_TASK, [ref("squad")], [], async (invocation) => {
      const { client, id } = await squadTarget(invocation);
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/squads/${encodePath(id)}/members/status` })).data, ["members"]);
    }),
    spec("squad.member.add", ["squad", "member", "add"], "Add a squad member", "write", HUMAN, [ref("squad"), ref("member")], memberOptions(), async (invocation) => {
      const { client, id } = await squadTarget(invocation);
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/squads/${encodePath(id)}/members`, body: squadMemberBody(invocation) })).data);
    }),
    spec("squad.member.update", ["squad", "member", "update"], "Update a squad member role", "write", HUMAN, [ref("squad"), ref("member")], memberOptions(), async (invocation) => {
      const { client, id } = await squadTarget(invocation);
      renderResource(invocation, (await client.request({ method: "PATCH", path: `/api/squads/${encodePath(id)}/members/role`, body: squadMemberBody(invocation) })).data);
    }),
    spec("squad.member.remove", ["squad", "member", "remove"], "Remove a squad member", "destructive", HUMAN, [ref("squad"), ref("member")], [...memberOptions(), YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const { client, id } = await squadTarget(invocation);
      renderResource(invocation, (await client.request({ method: "DELETE", path: `/api/squads/${encodePath(id)}/members`, body: squadMemberBody(invocation) })).data);
    }),
  ];
}

function skillSpecs(): CommandSpec[] {
  return [
    group("skill", "Manage workspace skills and skill files"),
    spec("skill.list", ["skill", "list"], "List skills", "read", HUMAN_TASK, [], [
      { name: "include-files", type: "boolean", description: "Include skill files" },
    ], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "GET", path: "/api/skills", query: { workspace_id: requiredWorkspace(invocation), include_files: booleanOption(invocation, "include-files") } })).data, ["skills"]);
    }),
    spec("skill.search", ["skill", "search"], "Search skills", "read", HUMAN_TASK, [], [], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "GET", path: "/api/skills/search", query: queryOptions(invocation, { workspace_id: requiredWorkspace(invocation) }) })).data, ["skills"]);
    }),
    spec("skill.get", ["skill", "get"], "Get a skill", "read", HUMAN_TASK, [ref("skill")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const skill = await resolveSkill(client, invocation, positional(invocation, 0, "skill"));
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/skills/${encodePath(String(skill.id))}`, query: { workspace_id: requiredWorkspace(invocation) } })).data);
    }),
    spec("skill.create", ["skill", "create"], "Create a skill", "write", HUMAN, [], [...INPUT_OPTIONS, ...SKILL_FIELDS], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "POST", path: "/api/skills", body: await requestBody(invocation, skillBody(invocation)) })).data);
    }),
    spec("skill.update", ["skill", "update"], "Update a skill", "write", HUMAN, [ref("skill")], [...INPUT_OPTIONS, ...SKILL_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const skill = await resolveSkill(client, invocation, positional(invocation, 0, "skill"));
      renderResource(invocation, (await client.request({ method: "PUT", path: `/api/skills/${encodePath(String(skill.id))}`, body: await requestBody(invocation, skillBody(invocation)) })).data);
    }),
    spec("skill.archive", ["skill", "archive"], "Archive a skill", "destructive", HUMAN, [ref("skill")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const skill = await resolveSkill(client, invocation, positional(invocation, 0, "skill"));
      renderResource(invocation, (await client.request({ method: "DELETE", path: `/api/skills/${encodePath(String(skill.id))}` })).data);
    }, [{ path: ["skill", "delete"], deprecatedSince: DEPRECATED_SINCE, replacement: "remi skill archive" }]),
    spec("skill.import", ["skill", "import"], "Import a skill", "write", HUMAN, [], [...INPUT_OPTIONS, {
      name: "url", type: "string", valueName: "url", description: "Skill source URL",
    }, ...SKILL_FIELDS.slice(0, 2)], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "POST", path: "/api/skills/import", body: await requestBody(invocation, {
        source_url: stringOption(invocation, "url") ?? undefined,
        name: stringOption(invocation, "name") ?? undefined,
        description: stringOption(invocation, "description") ?? undefined,
        workspace_id: requiredWorkspace(invocation),
      }) })).data);
    }),
    spec("skill.file.list", ["skill", "file", "list"], "List skill files", "read", HUMAN_TASK, [ref("skill")], [], async (invocation) => {
      const { client, id } = await skillTarget(invocation);
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/skills/${encodePath(id)}/files`, query: { workspace_id: requiredWorkspace(invocation) } })).data, ["files"]);
    }),
    spec("skill.file.update", ["skill", "file", "update"], "Create or update a skill file", "write", HUMAN, [ref("skill")], [...INPUT_OPTIONS, {
      name: "path", type: "string", valueName: "path", description: "Relative file path",
    }, { name: "content", type: "string", valueName: "text", description: "File content" }], async (invocation) => {
      const { client, id } = await skillTarget(invocation);
      renderResource(invocation, (await client.request({ method: "PUT", path: `/api/skills/${encodePath(id)}/files`, body: await requestBody(invocation, {
        path: stringOption(invocation, "path") ?? undefined,
        content: stringOption(invocation, "content") ?? undefined,
      }) })).data);
    }),
    spec("skill.file.delete", ["skill", "file", "delete"], "Delete a skill file", "destructive", HUMAN, [ref("skill"), ref("file")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const { client, id } = await skillTarget(invocation);
      renderResource(invocation, (await client.request({ method: "DELETE", path: `/api/skills/${encodePath(id)}/files/${encodePath(positional(invocation, 1, "file"))}` })).data);
    }),
  ];
}

function pluginSpecs(): CommandSpec[] {
  return [
    group("plugin", "Manage provider-native Agent Plugins"),
    spec("plugin.list", ["plugin", "list"], "List Agent Plugins", "read", HUMAN, [], [
      { name: "provider", type: "string", valueName: "claude|codex", description: "Provider filter" },
      { name: "include-archived", type: "boolean", description: "Include archived plugins" },
    ], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "GET", path: "/api/multiremi/agent-plugins", query: {
        workspace_id: requiredWorkspace(invocation),
        provider: stringOption(invocation, "provider"),
        include_archived: booleanOption(invocation, "include-archived"),
      } })).data, ["plugins"]);
    }),
    spec("plugin.get", ["plugin", "get"], "Get an Agent Plugin", "read", HUMAN, [ref("plugin")], [], async (invocation) => {
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/multiremi/agent-plugins/${encodePath(id)}` })).data);
    }),
    spec("plugin.update", ["plugin", "update"], "Update an Agent Plugin", "write", HUMAN, [ref("plugin")], [...INPUT_OPTIONS, ...pluginFields()], async (invocation) => {
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "PATCH", path: `/api/multiremi/agent-plugins/${encodePath(id)}`, body: await requestBody(invocation, pluginBody(invocation)) })).data);
    }),
    spec("plugin.archive", ["plugin", "archive"], "Archive an Agent Plugin", "destructive", HUMAN, [ref("plugin")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "DELETE", path: `/api/multiremi/agent-plugins/${encodePath(id)}` })).data);
    }, [{ path: ["plugin", "delete"], deprecatedSince: DEPRECATED_SINCE, replacement: "remi plugin archive" }]),
    spec("plugin.restore", ["plugin", "restore"], "Restore an Agent Plugin", "write", HUMAN, [ref("plugin")], [], async (invocation) => {
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/multiremi/agent-plugins/${encodePath(id)}/restore`, body: {} })).data);
    }),
    spec("plugin.inspect", ["plugin", "inspect"], "Inspect an Agent Plugin Git source", "write", HUMAN, [], [...INPUT_OPTIONS, ...sourceOptions()], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "POST", path: "/api/multiremi/agent-plugins/inspect", body: await requestBody(invocation, sourceBody(invocation)) })).data);
    }),
    spec("plugin.import", ["plugin", "import"], "Import an Agent Plugin", "write", HUMAN, [], [...INPUT_OPTIONS, ...sourceOptions(), ...pluginFields(), {
      name: "activate", type: "boolean", description: "Activate imported version",
    }], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "POST", path: "/api/multiremi/agent-plugins/import", body: await requestBody(invocation, {
        mode: stringOption(invocation, "source-url") ? "git" : undefined,
        ...sourceBody(invocation),
        ...pluginBody(invocation),
        activate: booleanOption(invocation, "activate") ?? undefined,
      }) })).data);
    }),
    spec("plugin.version.list", ["plugin", "version", "list"], "List Agent Plugin versions", "read", HUMAN, [ref("plugin")], [], async (invocation) => {
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/multiremi/agent-plugins/${encodePath(id)}/versions` })).data, ["versions"]);
    }),
    spec("plugin.version.create", ["plugin", "version", "create"], "Create an Agent Plugin version", "write", HUMAN, [ref("plugin")], [...INPUT_OPTIONS, {
      name: "version", type: "string", valueName: "version", description: "Provider-native version",
    }], async (invocation) => {
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/multiremi/agent-plugins/${encodePath(id)}/versions`, body: await requestBody(invocation, { version: stringOption(invocation, "version") ?? undefined }) })).data);
    }),
    pluginAction("plugin.activate", "activate", "Activate an Agent Plugin version", true),
    pluginAction("plugin.rollback", "rollback", "Roll back an Agent Plugin version", false),
    spec("plugin.runtime.list", ["plugin", "runtime", "list"], "List Agent Plugin Runtime state", "read", HUMAN, [ref("plugin")], [
      { name: "include-historical", type: "boolean", description: "Include historical Runtime state" },
    ], async (invocation) => {
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/multiremi/agent-plugins/${encodePath(id)}/runtimes`, query: { include_historical: booleanOption(invocation, "include-historical") } })).data, ["states"]);
    }),
    spec("plugin.runtime.retry", ["plugin", "runtime", "retry"], "Retry Agent Plugin Runtime convergence", "write", HUMAN, [ref("plugin")], [
      { name: "runtime", type: "string", valueName: "runtime-id", description: "Runtime filter" },
      { name: "version", type: "string", valueName: "version-id", description: "Version filter" },
    ], async (invocation) => {
      const { client, id } = await pluginTarget(invocation);
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/multiremi/agent-plugins/${encodePath(id)}/runtimes/retry`, body: {
        runtime_id: stringOption(invocation, "runtime") ?? undefined,
        version_id: stringOption(invocation, "version") ?? undefined,
      } })).data, ["states"]);
    }),
    spec("plugin.runtime.get", ["plugin", "runtime", "get"], "List Agent Plugins observed on a Runtime", "read", HUMAN, [ref("runtime")], [
      { name: "include-historical", type: "boolean", description: "Include historical Runtime state" },
    ], async (invocation) => {
      renderResource(invocation, (await (await clientFor(invocation)).request({ method: "GET", path: `/api/multiremi/runtimes/${encodePath(positional(invocation, 0, "runtime"))}/agent-plugins`, query: { include_historical: booleanOption(invocation, "include-historical") } })).data, ["states"]);
    }),
  ];
}

function agentPluginSpecs(): CommandSpec[] {
  return [
    spec("agent.plugin.list", ["agent", "plugin", "list"], "List an agent's Plugin bindings", "read", HUMAN, [ref("agent")], [], async (invocation) => {
      const { client, id } = await agentTarget(invocation);
      renderResource(invocation, (await client.request({ method: "GET", path: `/api/multiremi/agents/${encodePath(id)}/plugins` })).data, ["bindings"]);
    }),
    spec("agent.plugin.bind", ["agent", "plugin", "bind"], "Bind an Agent Plugin", "write", HUMAN, [ref("agent"), ref("plugin")], [
      { name: "version-policy", type: "string", valueName: "follow_active|pinned", description: "Version policy" },
      { name: "version", type: "string", valueName: "version-id", description: "Pinned version" },
      { name: "disabled", type: "boolean", description: "Create the binding disabled" },
    ], async (invocation) => {
      const { client, id } = await agentTarget(invocation);
      const plugin = await resolvePlugin(client, invocation, positional(invocation, 1, "plugin"));
      renderResource(invocation, (await client.request({ method: "POST", path: `/api/multiremi/agents/${encodePath(id)}/plugins`, body: {
        plugin_id: String(plugin.id),
        version_policy: stringOption(invocation, "version-policy") ?? "follow_active",
        plugin_version_id: stringOption(invocation, "version") ?? undefined,
        enabled: booleanOption(invocation, "disabled") === true ? false : true,
      } })).data);
    }),
    spec("agent.plugin.update", ["agent", "plugin", "update"], "Update an Agent Plugin binding", "write", HUMAN, [ref("agent"), ref("binding")], [...INPUT_OPTIONS, {
      name: "version-policy", type: "string", valueName: "follow_active|pinned", description: "Version policy",
    }, { name: "version", type: "string", valueName: "version-id", description: "Pinned version" }], async (invocation) => {
      const { client, id } = await agentTarget(invocation);
      renderResource(invocation, (await client.request({ method: "PATCH", path: `/api/multiremi/agents/${encodePath(id)}/plugins/${encodePath(positional(invocation, 1, "binding"))}`, body: await requestBody(invocation, {
        version_policy: stringOption(invocation, "version-policy") ?? undefined,
        plugin_version_id: stringOption(invocation, "version") ?? undefined,
      }) })).data);
    }),
    spec("agent.plugin.unbind", ["agent", "plugin", "unbind"], "Remove an Agent Plugin binding", "destructive", HUMAN, [ref("agent"), ref("binding")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const { client, id } = await agentTarget(invocation);
      renderResource(invocation, (await client.request({ method: "DELETE", path: `/api/multiremi/agents/${encodePath(id)}/plugins/${encodePath(positional(invocation, 1, "binding"))}` })).data);
    }),
  ];
}

function agentChildRead(id: string, path: string[], description: string, tail: string, key: string): CommandSpec {
  return spec(id, path, description, "read", HUMAN, [ref("agent")], [], async (invocation) => {
    const { client, id: agentId } = await agentTarget(invocation);
    renderResource(invocation, (await client.request({ method: "GET", path: `/api/agents/${encodePath(agentId)}/${tail}` })).data, [key]);
  });
}

function pluginAction(id: string, action: string, description: string, requireVersion: boolean): CommandSpec {
  return spec(id, ["plugin", action], description, "write", HUMAN, [ref("plugin")], [{
    name: "version", type: "string", valueName: "version-id", description: "Version ID",
  }], async (invocation) => {
    const { client, id: pluginId } = await pluginTarget(invocation);
    const version = stringOption(invocation, "version");
    if (requireVersion && !version) throw new CliError("usage", `--version is required for plugin ${action}`);
    renderResource(invocation, (await client.request({ method: "POST", path: `/api/multiremi/agent-plugins/${encodePath(pluginId)}/${action}`, body: { version_id: version ?? undefined } })).data);
  });
}

function spec(
  id: string,
  path: string[],
  description: string,
  mutation: CliMutation,
  auth: readonly CliIdentity[],
  positionals: CommandSpec["positionals"],
  options: readonly CliOptionSpec[],
  run: CommandSpec["run"],
  aliases: readonly CommandAlias[] = [],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth,
    mutation,
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []),
    aliases,
    run,
  };
}

function group(id: string, description: string): CommandSpec {
  return { id, path: [id], description, parse: "passthrough", run: async () => { throw new CliError("usage", `usage: remi ${id} <command>`); } };
}

function legacyAlias(path: string[], replacement: string, hidden = false): CommandAlias {
  return { path, deprecatedSince: DEPRECATED_SINCE, replacement, hidden, dispatch: false };
}

function ref(name: string) { return { name, required: true } as const; }

function agentBody(invocation: CommandInvocation, creating: boolean): Record<string, unknown> {
  return {
    name: stringOption(invocation, "name") ?? undefined,
    description: stringOption(invocation, "description") ?? undefined,
    instructions: stringOption(invocation, "instructions") ?? undefined,
    avatar_url: stringOption(invocation, "avatar-url") ?? undefined,
    provider: stringOption(invocation, "provider") ?? (creating ? "claude" : undefined),
    model: stringOption(invocation, "model") ?? undefined,
    thinking_level: stringOption(invocation, "thinking-level") ?? undefined,
    visibility: stringOption(invocation, "visibility") ?? undefined,
    max_concurrent_tasks: integerOption(invocation, "max-concurrent-tasks") ?? undefined,
    issue_creation_requires_proposal: booleanOption(invocation, "issue-creation-requires-proposal") ?? undefined,
    workspace_id: creating ? requiredWorkspace(invocation) : undefined,
  };
}

function squadBody(invocation: CommandInvocation, creating: boolean): Record<string, unknown> {
  return {
    name: stringOption(invocation, "name") ?? undefined,
    description: stringOption(invocation, "description") ?? undefined,
    instructions: stringOption(invocation, "instructions") ?? undefined,
    avatar_url: stringOption(invocation, "avatar-url") ?? undefined,
    leader_id: stringOption(invocation, "leader") ?? undefined,
    workspace_id: creating ? requiredWorkspace(invocation) : undefined,
  };
}

function skillBody(invocation: CommandInvocation): Record<string, unknown> {
  return {
    name: stringOption(invocation, "name") ?? undefined,
    description: stringOption(invocation, "description") ?? undefined,
    content: stringOption(invocation, "content") ?? undefined,
    workspace_id: requiredWorkspace(invocation),
  };
}

function memberOptions(): CliOptionSpec[] {
  return [
    { name: "type", type: "string", valueName: "agent|member", description: "Squad member type" },
    { name: "role", type: "string", valueName: "role", description: "Squad role" },
  ];
}

function squadMemberBody(invocation: CommandInvocation): Record<string, unknown> {
  return {
    member_type: stringOption(invocation, "type") ?? "agent",
    member_id: positional(invocation, 1, "member"),
    role: stringOption(invocation, "role") ?? undefined,
  };
}

function sourceOptions(): CliOptionSpec[] {
  return [
    { name: "source-url", type: "string", valueName: "url", description: "Git source URL" },
    { name: "source-ref", type: "string", valueName: "branch|sha", description: "Git ref" },
    { name: "source-subdir", type: "string", valueName: "path", description: "Plugin directory in the repository" },
    { name: "provider", type: "string", valueName: "claude|codex", description: "Provider filter" },
  ];
}

function sourceBody(invocation: CommandInvocation): Record<string, unknown> {
  return {
    source_url: stringOption(invocation, "source-url") ?? undefined,
    source_ref: stringOption(invocation, "source-ref") ?? undefined,
    source_subdir: stringOption(invocation, "source-subdir") ?? undefined,
    provider: stringOption(invocation, "provider") ?? undefined,
    workspace_id: requiredWorkspace(invocation),
  };
}

function pluginFields(): CliOptionSpec[] {
  return [
    { name: "name", type: "string", valueName: "name", description: "Plugin name" },
    { name: "description", type: "string", valueName: "text", description: "Plugin description" },
  ];
}

function pluginBody(invocation: CommandInvocation): Record<string, unknown> {
  return {
    name: stringOption(invocation, "name") ?? undefined,
    description: stringOption(invocation, "description") ?? undefined,
  };
}

async function agentTarget(invocation: CommandInvocation): Promise<{ client: CliApiClient; id: string }> {
  const client = await clientFor(invocation);
  const agent = await resolveAgent(client, invocation, positional(invocation, 0, "agent"));
  return { client, id: String(agent.id) };
}

async function squadTarget(invocation: CommandInvocation): Promise<{ client: CliApiClient; id: string }> {
  const client = await clientFor(invocation);
  const squad = await resolveSquad(client, invocation, positional(invocation, 0, "squad"));
  return { client, id: String(squad.id) };
}

async function skillTarget(invocation: CommandInvocation): Promise<{ client: CliApiClient; id: string }> {
  const client = await clientFor(invocation);
  const skill = await resolveSkill(client, invocation, positional(invocation, 0, "skill"));
  return { client, id: String(skill.id) };
}

async function pluginTarget(invocation: CommandInvocation): Promise<{ client: CliApiClient; id: string }> {
  const client = await clientFor(invocation);
  const plugin = await resolvePlugin(client, invocation, positional(invocation, 0, "plugin"));
  return { client, id: String(plugin.id) };
}

async function resolveAgent(client: CliApiClient, invocation: CommandInvocation, value: string, includeArchived = false): Promise<Record<string, unknown>> {
  return resolveListed(client, invocation, value, "agent", "/api/agents", ["agents"], {
    workspace_id: requiredWorkspace(invocation),
    include_archived: includeArchived || undefined,
  });
}

async function resolveSquad(client: CliApiClient, invocation: CommandInvocation, value: string): Promise<Record<string, unknown>> {
  return resolveListed(client, invocation, value, "squad", "/api/squads", ["squads"], { workspace_id: requiredWorkspace(invocation) });
}

async function resolveSkill(client: CliApiClient, invocation: CommandInvocation, value: string): Promise<Record<string, unknown>> {
  return resolveListed(client, invocation, value, "skill", "/api/skills", ["skills"], { workspace_id: requiredWorkspace(invocation) });
}

async function resolvePlugin(client: CliApiClient, invocation: CommandInvocation, value: string): Promise<Record<string, unknown>> {
  return resolveListed(client, invocation, value, "plugin", "/api/multiremi/agent-plugins", ["plugins"], { workspace_id: requiredWorkspace(invocation), include_archived: true });
}

async function resolveListed(
  client: CliApiClient,
  invocation: CommandInvocation,
  value: string,
  kind: string,
  path: string,
  keys: string[],
  query: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const list = async () => extractRecords((await client.request({ method: "GET", path, query: queryOptions(invocation, query) })).data, keys);
  return new ResourceResolver<Record<string, unknown>>({
    kind,
    getById: async (id) => (await list()).find((entry) => entry.id === id) ?? null,
    search: list,
    id: (entry) => String(entry.id ?? ""),
    name: (entry) => typeof entry.name === "string" ? entry.name : typeof entry.title === "string" ? entry.title : null,
  }).resolve(value);
}
