import { CliError, ResourceResolver, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
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
  integerOption,
  requestBody,
  requireConfirmation,
  requiredWorkspace,
  stringOption,
} from "./resource-common.js";

const REPO_FIELDS: readonly CliOptionSpec[] = [
  { name: "url", type: "string", valueName: "url", description: "Git remote URL" },
  { name: "name", type: "string", valueName: "name", description: "Repository name" },
  { name: "description", type: "string", valueName: "text", description: "Repository description" },
  { name: "default-branch", type: "string", valueName: "branch", description: "Default branch" },
];

export function repoCommandSpecs(): CommandSpec[] {
  return [
    { id: "repo", path: ["repo"], description: "Manage and check out workspace repositories", parse: "passthrough", run: async () => { throw new CliError("usage", "usage: remi repo list|get|inspect|create|update|delete|checkout ..."); } },
    spec("repo.list", ["repo", "list"], "List imported repositories without contacting Git", "read", ["human", "task"], [], PAGE_OPTIONS, async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "GET", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repos` });
      renderResource(invocation, response.data, ["repositories"]);
    }),
    spec("repo.get", ["repo", "get"], "Get an imported repository", "read", ["human", "task"], [refPositional("repository")], [], async (invocation) => {
      const client = await clientFor(invocation);
      renderResource(invocation, await resolveRepository(client, requiredWorkspace(invocation), positional(invocation, 0, "repository")));
    }),
    spec("repo.inspect", ["repo", "inspect"], "Inspect a Git remote before importing it", "read", ["human"], [refPositional("url")], [], async (invocation) => {
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repos/inspect`, body: { url: positional(invocation, 0, "url") } });
      renderResource(invocation, response.data);
    }),
    spec("repo.create", ["repo", "create"], "Import a repository into the workspace", "write", ["human"], [], [...INPUT_OPTIONS, ...REPO_FIELDS], async (invocation) => {
      const body = await repoBody(invocation);
      if (typeof body.url !== "string" || !body.url.trim()) throw new CliError("usage", "repository URL is required via --url or input JSON");
      const client = await clientFor(invocation);
      const response = await client.request({ method: "POST", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repos`, body });
      renderResource(invocation, response.data);
    }, [{ path: ["repo", "import"], deprecatedSince: "0.3.0", replacement: "remi repo create" }]),
    spec("repo.update", ["repo", "update"], "Update an imported repository", "write", ["human"], [refPositional("repository")], [...INPUT_OPTIONS, ...REPO_FIELDS], async (invocation) => {
      const client = await clientFor(invocation);
      const repo = await resolveRepository(client, requiredWorkspace(invocation), positional(invocation, 0, "repository"));
      const body = await repoBody(invocation);
      delete body.url;
      delete body.name;
      if (!Object.keys(body).length) throw new CliError("usage", "repo update requires --description, --default-branch, or input JSON");
      const response = await client.request({ method: "PATCH", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repos/${encodePath(String(repo.id))}`, body });
      renderResource(invocation, response.data);
    }),
    spec("repo.delete", ["repo", "delete"], "Remove an imported repository", "destructive", ["human"], [refPositional("repository")], [YES_OPTION], async (invocation) => {
      requireConfirmation(invocation);
      const client = await clientFor(invocation);
      const repo = await resolveRepository(client, requiredWorkspace(invocation), positional(invocation, 0, "repository"));
      const response = await client.request({ method: "DELETE", path: `/api/workspaces/${encodePath(requiredWorkspace(invocation))}/repos/${encodePath(String(repo.id))}` });
      renderResource(invocation, response.data);
    }),
    spec("repo.checkout", ["repo", "checkout"], "Check out one repository; URLs are used directly, while IDs, short IDs, and names resolve from the database", "write", ["human", "task"], [refPositional("repository-or-url")], [
      { name: "ref", type: "string", valueName: "branch-or-sha", description: "Branch or commit to check out" },
      { name: "daemon-port", type: "integer", valueName: "port", description: "Local daemon helper port" },
      { name: "agent-name", type: "string", valueName: "name", description: "Requesting agent name" },
      { name: "task-id", type: "string", valueName: "id", description: "Requesting task ID" },
    ], checkoutRepository),
  ];
}

export async function resolveRepository(
  client: Awaited<ReturnType<typeof clientFor>>,
  workspaceId: string,
  ref: string,
): Promise<Record<string, unknown>> {
  const list = async () => {
    const response = await client.request<unknown>({ method: "GET", path: `/api/workspaces/${encodePath(workspaceId)}/repos` });
    return extractRecords(response.data, ["repositories"]);
  };
  return new ResourceResolver<Record<string, unknown>>({
    kind: "repository",
    getById: async (id) => (await list()).find((repo) => repo.id === id) ?? null,
    search: list,
    id: (repo) => String(repo.id ?? ""),
    name: (repo) => typeof repo.name === "string" ? repo.name : null,
    describe: (repo) => ({ id: repo.id, name: repo.name, url: repo.url }),
  }).resolve(ref);
}

async function checkoutRepository(invocation: CommandInvocation): Promise<void> {
  const client = await clientFor(invocation);
  const input = positional(invocation, 0, "repository-or-url");
  const directUrl = looksLikeGitUrl(input);
  const repository = directUrl ? null : await resolveRepository(client, requiredWorkspace(invocation), input);
  const url = directUrl ? input : String(repository?.url ?? "");
  const port = invocation.options["daemon-port"];
  const daemonPort = typeof port === "number" ? String(port) : process.env.MULTIREMI_DAEMON_PORT?.trim();
  if (!daemonPort) throw new CliError("usage", "--daemon-port or MULTIREMI_DAEMON_PORT is required for repo checkout");
  const timeoutMs = integerOption(invocation, "timeout") ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${daemonPort}/repo/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        url,
        workspace_id: requiredWorkspace(invocation),
        workdir: process.cwd(),
        ref: stringOption(invocation, "ref") ?? "",
        agent_name: stringOption(invocation, "agent-name") ?? process.env.MULTIREMI_AGENT_NAME?.trim() ?? "",
        task_id: stringOption(invocation, "task-id") ?? process.env.MULTIREMI_TASK_ID?.trim() ?? "",
      }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CliError("timeout", `checkout timed out after ${timeoutMs}ms`, { retryable: true });
    }
    throw new CliError("server", `checkout failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) throw new CliError("server", `checkout failed: ${text}`, { status: response.status });
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CliError("server", "checkout failed: daemon returned invalid JSON");
  }
  if (typeof result.path !== "string" || !result.path) throw new CliError("server", "checkout failed: daemon response has no path");
  renderResource(invocation, { ...result, id: repository?.id ?? null, name: repository?.name ?? input, url });
  console.error(`Checked out ${directUrl ? "URL" : `repository ${String(repository?.id)}`} -> ${result.path}`);
}

async function repoBody(invocation: CommandInvocation) {
  return requestBody(invocation, {
    url: stringOption(invocation, "url") ?? undefined,
    name: stringOption(invocation, "name") ?? undefined,
    description: stringOption(invocation, "description") ?? undefined,
    default_branch: stringOption(invocation, "default-branch") ?? undefined,
  });
}

function looksLikeGitUrl(value: string): boolean {
  return /^(?:https?|ssh|git):\/\//i.test(value) || /^[^@\s]+@[^:\s]+:.+/.test(value);
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

function refPositional(name: string) { return { name, required: true } as const; }
