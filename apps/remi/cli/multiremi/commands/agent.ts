/**
 * Multiremi CLI — `agent` command handlers.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { type CliOptions, hasOption, integerOption, rawStringOption } from "../options.js";
import { multiremiApiConnection, multiremiApiRequest } from "../http.js";
import { printAgentCollection, printJson } from "../output.js";
import { SUPPORTED_DAEMON_PROVIDERS, isSupportedDaemonProvider } from "../daemon-health.js";
import { addStringBodyField, readOptionalTextBody } from "./fields.js";

export async function agent(positional: string[], options: CliOptions): Promise<void> {
  const action = positional[0] ?? "";
  if (action === "list") {
    const workspaceId = multiremiApiConnection(options).workspaceId;
    const query = workspaceId
      ? `?${new URLSearchParams({ workspace_id: workspaceId }).toString()}`
      : "";
    const response = await multiremiApiRequest("GET", `/api/agents${query}`, undefined, options);
    printAgentCollection(response, options);
    return;
  }
  if (action === "get") {
    const agentId = positional[1]?.trim();
    if (!agentId) throw new Error("usage: multiremi agent get <agent-id> [--output json]");
    printJson(await multiremiApiRequest("GET", `/api/agents/${encodeURIComponent(agentId)}`, undefined, options));
    return;
  }
  if (action === "edit" || action === "update") {
    const agentId = positional[1]?.trim();
    if (!agentId) {
      throw new Error(
        "usage: multiremi agent edit <agent-id> [--name <name>] [--description <text>] [--instructions <text>] [--avatar-url <url>] [--provider claude|codex] [--model <model>] [--thinking-level <level>] [--visibility private|workspace] [--max-concurrent-tasks <n>]",
      );
    }
    await agentEdit(agentId, options);
    return;
  }
  throw new Error("usage: multiremi agent list|get|edit|update ...");
}

export async function agentEdit(agentId: string, options: CliOptions): Promise<void> {
  const body: Record<string, unknown> = {};

  addStringBodyField(body, options, "name", "name");

  const description = await readOptionalTextBody(options, "description");
  if (description.set) body.description = description.value;

  const instructions = await readOptionalTextBody(options, "instructions");
  if (instructions.set) body.instructions = instructions.value;

  addStringBodyField(body, options, "avatar_url", "avatar-url");
  addStringBodyField(body, options, "model", "model");
  addStringBodyField(body, options, "thinking_level", "thinking-level");

  if (hasOption(options, "provider")) {
    const provider = rawStringOption(options, "provider");
    if (!provider || !isSupportedDaemonProvider(provider)) {
      throw new Error(`--provider must be one of: ${SUPPORTED_DAEMON_PROVIDERS.join(", ")}`);
    }
    body.provider = provider;
  }

  if (hasOption(options, "visibility")) {
    const visibility = rawStringOption(options, "visibility");
    if (visibility !== "private" && visibility !== "workspace") {
      throw new Error("--visibility must be private or workspace");
    }
    body.visibility = visibility;
  }

  const maxConcurrentTasks = integerOption(options, "max-concurrent-tasks");
  if (maxConcurrentTasks !== null) {
    if (maxConcurrentTasks < 1 || maxConcurrentTasks > 50) {
      throw new Error("--max-concurrent-tasks must be an integer between 1 and 50");
    }
    body.max_concurrent_tasks = maxConcurrentTasks;
  }

  if (Object.keys(body).length === 0) {
    throw new Error(
      "no fields to edit; pass --name, --description, --instructions, --avatar-url, --provider, --model, --thinking-level, --visibility, or --max-concurrent-tasks",
    );
  }

  printJson(
    await multiremiApiRequest(
      "PUT",
      `/api/agents/${encodeURIComponent(agentId)}`,
      body,
      options,
    ),
  );
}
