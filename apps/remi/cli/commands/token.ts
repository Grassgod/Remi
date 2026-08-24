import { CliError, ResourceResolver, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
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
  requiredWorkspace,
  stringOption,
} from "./resource-common.js";

const TOKEN_FIELDS: readonly CliOptionSpec[] = [
  { name: "name", type: "string", valueName: "name", description: "Token name" },
  { name: "purpose", type: "string", valueName: "personal|cli", description: "Token purpose" },
  { name: "expires-in-days", type: "integer", valueName: "days", description: "Expiry in days" },
];

export function tokenCommandSpecs(): CommandSpec[] {
  return [
    { id: "token", path: ["token"], description: "Manage personal access tokens", parse: "passthrough", run: async () => { throw new CliError("usage", "usage: remi token list|create|renew|delete ..."); } },
    spec("token.list", ["token", "list"], "List personal access tokens", "read", [], PAGE_OPTIONS, async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: "/api/tokens", query: { workspace_id: requiredWorkspace(invocation) } });
      renderResource(invocation, response.data, ["tokens"]);
    }),
    spec("token.create", ["token", "create"], "Create a personal access token", "write", [], [...INPUT_OPTIONS, ...TOKEN_FIELDS], async (invocation) => {
      const body = await requestBody(invocation, {
        workspace_id: requiredWorkspace(invocation),
        name: stringOption(invocation, "name") ?? undefined,
        purpose: stringOption(invocation, "purpose") ?? undefined,
        expires_in_days: integerOption(invocation, "expires-in-days") ?? undefined,
      });
      if (typeof body.name !== "string" || !body.name.trim()) throw new CliError("usage", "token name is required via --name or input JSON");
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: "/api/tokens", body });
      renderResource(invocation, response.data);
    }),
    spec("token.renew", ["token", "renew"], "Renew the current personal access token", "write", [], INPUT_OPTIONS, async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: "/api/tokens/current/renew", body: await requestBody(invocation) });
      renderResource(invocation, response.data);
    }),
    spec("token.delete", ["token", "delete"], "Revoke a personal access token", "destructive", [refPositional("token")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const token = await resolveToken(client, requiredWorkspace(invocation), positional(invocation, 0, "token"));
      const response = await client.request({ method: "DELETE", path: `/api/tokens/${encodePath(String(token.id))}` });
      renderResource(invocation, response.data);
    }),
  ];
}

async function resolveToken(
  client: Awaited<ReturnType<typeof clientFor>>,
  workspaceId: string,
  ref: string,
): Promise<Record<string, unknown>> {
  const list = async () => {
    const response = await client.request<unknown>({ method: "GET", path: "/api/tokens", query: { workspace_id: workspaceId } });
    return extractRecords(response.data, ["tokens"]);
  };
  return new ResourceResolver<Record<string, unknown>>({
    kind: "token",
    getById: async (id) => (await list()).find((token) => token.id === id) ?? null,
    search: list,
    id: (token) => String(token.id ?? ""),
    name: (token) => typeof token.name === "string" ? token.name : typeof token.token_prefix === "string" ? token.token_prefix : null,
  }).resolve(ref);
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
