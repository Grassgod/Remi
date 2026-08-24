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
  positional,
  renderResource,
  requestBody,
  requireConfirmation,
  requiredWorkspace,
  stringOption,
} from "./resource-common.js";

const MEMBER_FIELDS: readonly CliOptionSpec[] = [
  { name: "name", type: "string", valueName: "name", description: "Member name" },
  { name: "email", type: "string", valueName: "email", description: "Member email" },
  { name: "role", type: "string", valueName: "owner|admin|member", description: "Workspace role" },
];

export function memberCommandSpecs(): CommandSpec[] {
  return [
    groupSpec(),
    spec("member.list", ["member", "list"], "List workspace members", "read", [], [], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/members` });
      renderResource(invocation, response.data, ["members"]);
    }),
    spec("member.get", ["member", "get"], "Get a member or the current user", "read", [refPositional("member")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const ref = positional(invocation, 0, "member");
      if (ref === "me") {
        const response = await client.request({ method: "GET", path: "/api/me" });
        renderResource(invocation, response.data);
        return;
      }
      renderResource(invocation, await resolveMember(client, requiredWorkspace(invocation), ref));
    }),
    spec("member.create", ["member", "create"], "Create a workspace member", "write", [], [...INPUT_OPTIONS, ...MEMBER_FIELDS], async (invocation) => {
      const body = await memberBody(invocation, { workspaceId: requiredWorkspace(invocation) });
      if (typeof body.name !== "string" || !body.name.trim()) throw new CliError("usage", "member name is required via --name or input JSON");
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: "/api/multiremi/members", body });
      renderResource(invocation, response.data);
    }),
    spec("member.update", ["member", "update"], "Update a member or the current user", "write", [refPositional("member")], [...INPUT_OPTIONS, ...MEMBER_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const ref = positional(invocation, 0, "member");
      const body = await memberBody(invocation);
      if (!Object.keys(body).length) throw new CliError("usage", "member update requires fields or input JSON");
      if (ref === "me") {
        const response = await client.request({ method: "PATCH", path: "/api/me", body });
        renderResource(invocation, response.data);
        return;
      }
      const member = await resolveMember(client, requiredWorkspace(invocation), ref);
      const response = await client.request({
        method: "PATCH",
        path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/members/${encodePath(String(member.id))}`,
        body,
      });
      renderResource(invocation, response.data);
    }),
    spec("member.delete", ["member", "delete"], "Remove a workspace member", "destructive", [refPositional("member")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const member = await resolveMember(client, requiredWorkspace(invocation), positional(invocation, 0, "member"));
      const response = await client.request({
        method: "DELETE",
        path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/members/${encodePath(String(member.id))}`,
      });
      renderResource(invocation, response.data);
    }),
    onboardingSpec("member.onboarding.update", ["member", "onboarding", "update"], "Update onboarding answers", "PATCH", "/api/me/onboarding"),
    onboardingSpec("member.onboarding.complete", ["member", "onboarding", "complete"], "Complete onboarding", "POST", "/api/me/onboarding/complete"),
    onboardingSpec("member.onboarding.cloud-waitlist", ["member", "onboarding", "cloud-waitlist"], "Join the cloud waitlist", "POST", "/api/me/onboarding/cloud-waitlist"),
    onboardingSpec("member.onboarding.runtime-bootstrap", ["member", "onboarding", "runtime-bootstrap"], "Start runtime bootstrap", "POST", "/api/me/onboarding/runtime-bootstrap"),
    onboardingSpec("member.onboarding.no-runtime-bootstrap", ["member", "onboarding", "no-runtime-bootstrap"], "Complete onboarding without a runtime", "POST", "/api/me/onboarding/no-runtime-bootstrap"),
  ];
}

export async function resolveMember(
  client: Awaited<ReturnType<typeof clientFor>>,
  workspaceId: string,
  ref: string,
): Promise<Record<string, unknown>> {
  const list = async () => {
    const response = await client.request<unknown>({ method: "GET", path: `/api/workspaces/${encodePath(workspaceId)}/members` });
    return extractRecords(response.data, ["members"]);
  };
  return new ResourceResolver<Record<string, unknown>>({
    kind: "member",
    getById: async (id) => (await list()).find((member) => member.id === id) ?? null,
    search: list,
    id: (member) => String(member.id ?? ""),
    name: (member) => typeof member.name === "string" ? member.name : typeof member.email === "string" ? member.email : null,
  }).resolve(ref);
}

function groupSpec(): CommandSpec {
  return {
    id: "member",
    path: ["member"],
    description: "Manage workspace members and the current user",
    parse: "passthrough",
    run: async () => { throw new CliError("usage", "usage: remi member list|get|create|update|delete|onboarding ..."); },
  };
}

function spec(
  id: string,
  path: string[],
  description: string,
  mutation: "read" | "write" | "destructive",
  positionals: CommandSpec["positionals"],
  options: readonly CliOptionSpec[],
  run: CommandSpec["run"],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth: ["human"],
    mutation,
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []),
    run,
  };
}

function onboardingSpec(
  id: string,
  path: string[],
  description: string,
  method: "PATCH" | "POST",
  apiPath: string,
): CommandSpec {
  return spec(id, path, description, "write", [], INPUT_OPTIONS, async (invocation) => {
    const client = await clientFor(invocation);
    const response = await client.request({ method, path: apiPath, body: await requestBody(invocation) });
    renderResource(invocation, response.data);
  });
}

async function memberBody(invocation: CommandInvocation, extra: Record<string, unknown> = {}) {
  return requestBody(invocation, {
    ...extra,
    name: stringOption(invocation, "name") ?? undefined,
    email: stringOption(invocation, "email") ?? undefined,
    role: stringOption(invocation, "role") ?? undefined,
  });
}

function refPositional(name: string) {
  return { name, required: true } as const;
}
