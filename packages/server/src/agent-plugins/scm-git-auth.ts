import type { MultiremiScmConnection } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { scmGitCredentialPassword } from "@multiremi/scm/access-token.js";
import { resolveScmRepositoryRemote } from "@multiremi/scm/repository-url.js";
import {
  AgentPluginGitImportError,
  resolveAgentPluginGitSource,
  type AgentPluginGitSourceResolver,
  type ResolveAgentPluginGitSourceInput,
} from "./git-import.js";
import { createScmGitCredentialEnvironment } from "./scm-git-environment.js";

/**
 * Bind Plugin Git reads to the workspace's server-owned SCM credential.
 * Secrets stay in the Git process environment and never enter URLs, argv, or disk.
 */
export function createScmAuthenticatedAgentPluginGitSourceResolver(
  store: Pick<MultiremiStore, "listScmConnections" | "getScmConnectionCredential" | "findScmRepositoryBindingByUrl">,
  resolver: AgentPluginGitSourceResolver = resolveAgentPluginGitSource,
): AgentPluginGitSourceResolver {
  return async (input) => {
    const authenticated = resolveAuthenticatedInput(store, input);
    const resolved = await resolver(authenticated);
    return authenticated.sourceUrl === input.sourceUrl
      ? resolved
      : { ...resolved, sourceUrl: input.sourceUrl.trim() };
  };
}

function resolveAuthenticatedInput(
  store: Pick<MultiremiStore, "listScmConnections" | "getScmConnectionCredential" | "findScmRepositoryBindingByUrl">,
  input: ResolveAgentPluginGitSourceInput,
): ResolveAgentPluginGitSourceInput {
  const workspaceId = input.workspaceId?.trim() || "local";
  const connections = store.listScmConnections({ workspaceId, enabled: true })
    .filter((connection) => connection.accessTokenSet)
    .map((connection) => matchingRemote(connection, input.sourceUrl))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (connections.length === 0) return input;

  const binding = store.findScmRepositoryBindingByUrl(workspaceId, input.sourceUrl);
  const selected = (
    (binding
      ? connections.find((item) => item.connection.id === binding.connectionId)
      : null)
    ?? connections.find((item) => item.connection.isDefault)
    ?? (connections.length === 1 ? connections[0] : null)
  );
  if (!selected) {
    throw new AgentPluginGitImportError(
      "multiple SCM connections match this Plugin repository; bind the repository or configure one default connection",
      "plugin_git_scm_connection_ambiguous",
      409,
    );
  }

  const credential = store.getScmConnectionCredential(selected.connection.id);
  const password = credential?.accessToken
    ? scmGitCredentialPassword(selected.connection.provider, credential.accessToken)
    : "";
  if (!password || /[\r\n]/u.test(password)) {
    throw new AgentPluginGitImportError(
      "the matching SCM connection does not contain a valid access token",
      "plugin_git_scm_credential_invalid",
      409,
    );
  }

  return {
    ...input,
    sourceUrl: selected.cloneUrl,
    gitEnvironment: createScmGitCredentialEnvironment(
      selected.connection.provider === "github" ? "x-access-token" : "oauth2",
      password,
    ),
  };
}

function matchingRemote(connection: MultiremiScmConnection, sourceUrl: string): {
  connection: MultiremiScmConnection;
  cloneUrl: string;
} | null {
  try {
    return {
      connection,
      cloneUrl: resolveScmRepositoryRemote(sourceUrl, connection.baseUrl).cloneUrl,
    };
  } catch {
    return null;
  }
}
