import { loadMultiremiConfig, saveMultiremiConfig } from "@multiremi/config.js";
import { CliError, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
import {
  INPUT_OPTIONS,
  clientFor,
  commandOptions,
  isRecord,
  renderResource,
  requestBody,
  stringOption,
} from "./resource-common.js";

// Passwords travel in a file/stdin body, never in a dedicated argv option.
export const PASSWORD_INPUT_OPTIONS: readonly CliOptionSpec[] = INPUT_OPTIONS
  .filter((option) => option.name === "file")
  .map(({ conflictsWith: _conflictsWith, ...option }) => ({ ...option, required: true }));

export async function passwordAuthBody(
  invocation: CommandInvocation,
  explicit: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  try {
    const body = await requestBody(invocation, explicit);
    // Password account APIs use the camelCase field, not the resource API alias.
    if ("workspace_id" in body) {
      body.workspaceId = body.workspace_id;
      delete body.workspace_id;
    }
    return body;
  } catch {
    // JSON parser errors may quote the input, including a password fragment.
    throw new CliError("usage", "Read email/password JSON from a readable --file path or --file - (stdin)");
  }
}

export function withValidatedPasswordInput(spec: CommandSpec): CommandSpec {
  return {
    ...spec,
    run: async (invocation) => {
      // clientFor also reads input to resolve workspace context. Validate inside
      // the redaction boundary first; the invocation cache avoids rereading stdin.
      await passwordAuthBody(invocation);
      await spec.run(invocation);
    },
  };
}

export function passwordLoginCommandSpec(): CommandSpec {
  return withValidatedPasswordInput({
    id: "context.auth.password",
    path: ["context", "auth", "password"],
    description: "Sign in with email/password JSON from --file path|- and save the CLI session",
    capability: "context.auth.password",
    auth: ["human"],
    mutation: "write",
    outputs: ["table", "json", "jsonl"],
    options: commandOptions(PASSWORD_INPUT_OPTIONS),
    run: async (invocation) => {
      // Login is public: a first session cannot negotiate authenticated capabilities.
      const client = await clientFor(invocation, { skipCapability: true });
      const response = await client.request<unknown>({
        method: "POST",
        path: "/auth/password",
        body: await passwordAuthBody(invocation),
      });
      if (!isRecord(response.data)
        || typeof response.data.token !== "string" || !response.data.token.trim()
        || !isRecord(response.data.user)
        || typeof response.data.user.id !== "string" || !response.data.user.id.trim()
        || typeof response.data.user.email !== "string" || !response.data.user.email.trim()) {
        throw new CliError("server", "Password login returned an invalid session response");
      }
      const config = loadMultiremiConfig();
      const serverUrl = stringOption(invocation, "server")
        ?? process.env.MULTIREMI_SERVER_URL?.trim()
        ?? config.server_url
        ?? "http://127.0.0.1:6120";
      saveMultiremiConfig({
        ...config,
        server_url: serverUrl.trim().replace(/\/+$/, ""),
        workspace_id: stringOption(invocation, "workspace")
          ?? process.env.MULTIREMI_WORKSPACE_ID?.trim()
          ?? config.workspace_id,
        token: response.data.token,
      });
      const user = response.data.user;
      renderResource(invocation, {
        id: user.id,
        ...(typeof user.name === "string" ? { name: user.name } : {}),
        ...(typeof user.email === "string" ? { email: user.email } : {}),
        status: "authenticated",
      });
    },
  });
}
