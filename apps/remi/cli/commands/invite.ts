import { CliError, ResourceResolver, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  booleanOption,
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

const INVITE_FIELDS: readonly CliOptionSpec[] = [
  { name: "email", type: "string", valueName: "email", description: "Invitee email" },
  { name: "role", type: "string", valueName: "admin|member", description: "Workspace role" },
];

export function inviteCommandSpecs(): CommandSpec[] {
  return [
    groupSpec(),
    spec("invite.list", ["invite", "list"], "List workspace or incoming invitations", "read", [], [
      { name: "incoming", type: "boolean", description: "List invitations for the current user" },
    ], async (invocation) => {
      const client = await clientFor(invocation);
      const path = booleanOption(invocation, "incoming")
        ? "/api/invitations"
        : `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/invitations`;
      const response = await client.request({ method: "GET", path });
      renderResource(invocation, response.data, ["invitations"]);
    }),
    spec("invite.get", ["invite", "get"], "Get an invitation", "read", [refPositional("invitation")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const invitation = await resolveInvitation(client, requiredWorkspace(invocation), positional(invocation, 0, "invitation"));
      renderResource(invocation, invitation);
    }),
    spec("invite.create", ["invite", "create"], "Invite a workspace member", "write", [], [...INPUT_OPTIONS, ...INVITE_FIELDS], async (invocation) => {
      const body = await requestBody(invocation, {
        email: stringOption(invocation, "email") ?? undefined,
        role: stringOption(invocation, "role") ?? undefined,
      });
      if (typeof body.email !== "string" || !body.email.trim()) throw new CliError("usage", "invite email is required via --email or input JSON");
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/members`, body });
      renderResource(invocation, response.data);
    }),
    spec("invite.accept", ["invite", "accept"], "Accept an invitation", "write", [refPositional("invitation")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const invitation = await resolveInvitation(client, requiredWorkspace(invocation), positional(invocation, 0, "invitation"));
      const response = await client.request({ method: "POST", path: `/api/invitations/${encodePath(String(invitation.id))}/accept`, body: {} });
      renderResource(invocation, response.data);
    }),
    spec("invite.decline", ["invite", "decline"], "Decline an invitation", "destructive", [refPositional("invitation")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const invitation = await resolveInvitation(client, requiredWorkspace(invocation), positional(invocation, 0, "invitation"));
      const response = await client.request({ method: "POST", path: `/api/invitations/${encodePath(String(invitation.id))}/decline`, body: {} });
      renderResource(invocation, response.data);
    }),
    spec("invite.revoke", ["invite", "revoke"], "Revoke a workspace invitation", "destructive", [refPositional("invitation")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const invitation = await resolveInvitation(client, requiredWorkspace(invocation), positional(invocation, 0, "invitation"));
      const response = await client.request({
        method: "DELETE",
        path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/invitations/${encodePath(String(invitation.id))}`,
      });
      renderResource(invocation, response.data);
    }),
  ];
}

async function resolveInvitation(
  client: Awaited<ReturnType<typeof clientFor>>,
  workspaceId: string,
  ref: string,
): Promise<Record<string, unknown>> {
  const list = async () => {
    const incoming = await client.request<unknown>({ method: "GET", path: "/api/invitations" });
    let workspaceInvitations: Record<string, unknown>[] = [];
    try {
      const workspace = await client.request<unknown>({ method: "GET", path: `/api/workspaces/${encodePath(workspaceId)}/invitations` });
      workspaceInvitations = extractRecords(workspace.data, ["invitations"]);
    } catch (error) {
      if (!(error instanceof CliError) || (error.code !== "forbidden" && error.code !== "not_found")) throw error;
    }
    return [...extractRecords(incoming.data, ["invitations"]), ...workspaceInvitations];
  };
  return new ResourceResolver<Record<string, unknown>>({
    kind: "invitation",
    getById: async (id) => {
      try {
        const response = await client.request<Record<string, unknown>>({ method: "GET", path: `/api/invitations/${encodePath(id)}` });
        return response.data;
      } catch (error) {
        if (error instanceof CliError && error.code === "not_found") return null;
        throw error;
      }
    },
    search: list,
    id: (invitation) => String(invitation.id ?? ""),
    name: (invitation) => typeof invitation.invitee_email === "string" ? invitation.invitee_email : typeof invitation.inviteeEmail === "string" ? invitation.inviteeEmail : null,
  }).resolve(ref);
}

function groupSpec(): CommandSpec {
  return { id: "invite", path: ["invite"], description: "Manage workspace invitations", parse: "passthrough", run: async () => { throw new CliError("usage", "usage: remi invite list|get|create|accept|decline|revoke ..."); } };
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
  return { id, path, description, capability: id, auth: ["human"], mutation, outputs: ["table", "json", "jsonl"], positionals, options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []), run };
}

function refPositional(name: string) {
  return { name, required: true } as const;
}
