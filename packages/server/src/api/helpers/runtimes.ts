// Runtime and daemon request plumbing: provider validation, the ownership-scoped runtime loaders,
// the daemon install instructions, and the registration/deregistration paths the daemon calls.
import type { Context } from "hono";
import { MultiremiStore, daemonRuntimeId } from "@multiremi/store/store.js";
import {
  DaemonIdentityOwnerConflictError,
  DaemonRetiredError,
} from "@multiremi/store/repos/daemon-retirement-repo.js";
import { RuntimeRegistrationIdentityConflictError } from "@multiremi/store/repos/runtimes-repo.js";
import {
  MULTIREMI_DAEMON_PROVIDERS,
  cleanString,
  currentAccessToken,
  currentRequestUserId,
  daemonRuntimeResponse,
  runtimeCompatibilityResponse,
  runtimeWorkspaceId,
  workspaceReposResponse,
} from "../wire/index.js";
import type { WorkspaceRepoData } from "../wire/index.js";
import type {
  MultiremiRuntime,
  ReportRuntimeLocalSkillImportInput,
  ReportRuntimeLocalSkillListInput,
} from "@multiremi/contracts/types.js";
import { MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION } from "@multiremi/contracts/types.js";
import {
  currentJwtUserId,
  currentWorkspaceRole,
  denyCurrentUserRuntimeWorkspaceAccess,
  denyCurrentUserWorkspaceAccess,
  denyDaemonTokenRuntimeIdentity,
  denyDaemonTokenWorkspace,
  hasJwtWorkspaceAccess,
} from "./auth-guards.js";
import { MultiremiApiError, requestOrigin, shellArg, uniqueStrings } from "./common.js";
import { MULTIREMI_INSTALL_SCRIPT, MULTIREMI_RELEASE_REPO } from "./integrations.js";

export type DaemonRegisterRequestBody = {
  workspace_id?: string;
  daemon_id?: string;
  legacy_daemon_ids?: string[];
  device_name?: string;
  cli_version?: string;
  launched_by?: string;
  capabilities?: {
    agent_plugins?: number;
  };
  runtimes?: Array<{
    name?: string;
    type?: string;
    version?: string;
    status?: string;
    maxConcurrency?: number;
    acpVersion?: string | null;
    agentVersion?: string | null;
  }>;
};

export function buildDaemonInstallInstructions(input: {
  requestUrl: string;
  serverUrl?: string | null;
  workspaceId?: string | null;
  token?: string | null;
  tokenId?: string | null;
  daemonId?: string | null;
  provider?: string | null;
  version?: string | null;
}) {
  const workspaceId = cleanString(input.workspaceId) ?? "local";
  const serverUrl = cleanString(input.serverUrl)
    ?? cleanString(process.env.MULTIREMI_PUBLIC_URL)
    ?? requestOrigin(input.requestUrl);
  const provider = cleanString(input.provider);
  const daemonId = cleanString(input.daemonId);
  if (provider && !MULTIREMI_DAEMON_PROVIDERS.has(provider)) {
    throw new MultiremiApiError(`Unsupported Multiremi runtime provider: ${provider}`, 400);
  }
  const version = cleanString(input.version);
  const releasePath = version ? `download/${version}` : "latest/download";
  const installScriptUrl = `https://github.com/${MULTIREMI_RELEASE_REPO}/releases/${releasePath}/${MULTIREMI_INSTALL_SCRIPT}`;
  const installCommand = `curl -fsSL ${shellArg(installScriptUrl)} | bash`;
  const setupParts = [
    "multiremi",
    "setup",
    "--server",
    shellArg(serverUrl),
    "--workspace",
    shellArg(workspaceId),
    "--token",
    input.token ? shellArg(input.token) : "<YOUR_TOKEN>",
  ];
  if (provider) setupParts.push("--provider", provider);
  if (daemonId) setupParts.push("--daemon-id", shellArg(daemonId));
  const setupCommand = setupParts.join(" ");
  const daemonCommand = "multiremi daemon";
  const daemonStartCommand = "multiremi daemon start";
  return {
    product: "multiremi",
    title: "Add computer",
    serverUrl,
    workspaceId,
    provider: provider ?? "auto",
    token: input.token ?? null,
    tokenId: input.tokenId ?? null,
    daemonId: daemonId ?? null,
    installScriptUrl,
    releaseArtifactPattern: "multiremi-${version}-${os}-${arch}.tar.gz",
    installCommand,
    setupCommand,
    daemonCommand,
    daemonStartCommand,
    commands: [
      { key: "install", label: "Install Multiremi CLI", command: installCommand },
      { key: "setup", label: "Configure this computer", command: setupCommand },
      { key: "daemon", label: "Start daemon", command: daemonCommand },
    ],
  };
}

export function normalizeMultiremiRuntimeProvider(value: unknown): string {
  return String(value ?? "").trim() || "unknown";
}

export function validateMultiremiRuntimeProvider(value: unknown): { provider: string } | { error: string; status: 400 } {
  const provider = normalizeMultiremiRuntimeProvider(value);
  if (MULTIREMI_DAEMON_PROVIDERS.has(provider)) return { provider };
  return { error: `Unsupported Multiremi runtime provider: ${provider}`, status: 400 };
}

export function requestedRuntimeWorkspaceId(c: Context): string {
  return cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

export function runtimeOwnerId(runtime: MultiremiRuntime): string {
  return runtime.ownerId ?? "local";
}

export function listRuntimesForCurrentUser(c: Context, store: MultiremiStore): { runtimes: MultiremiRuntime[] } | Response {
  const workspaceId = requestedRuntimeWorkspaceId(c);
  const daemonToken = currentAccessToken(c)?.type === "daemon";
  const denied = daemonToken
    ? denyDaemonTokenWorkspace(c, workspaceId)
    : denyCurrentUserWorkspaceAccess(c, store, workspaceId);
  if (denied) return denied;
  const ownerFilter = c.req.query("owner") === "me" ? currentRequestUserId(c) : null;
  const runtimes = store.listRuntimes().filter((runtime) => {
    if (runtimeWorkspaceId(runtime) !== workspaceId) return false;
    const token = currentAccessToken(c);
    if (token?.type === "daemon" && (!token.daemonId || runtime.daemonId !== token.daemonId)) return false;
    return ownerFilter ? runtimeOwnerId(runtime) === ownerFilter : true;
  });
  return { runtimes };
}

export function loadRuntimeForCurrentUser(c: Context, store: MultiremiStore, runtimeId: string): { runtime: MultiremiRuntime } | Response {
  const runtime = store.getRuntime(runtimeId);
  if (!runtime) return c.json({ error: "runtime not found" }, 404);
  const daemonDenied = denyDaemonTokenRuntimeIdentity(c, store, runtimeId);
  if (daemonDenied) return daemonDenied;
  if (currentAccessToken(c)?.type === "daemon") return { runtime };
  const denied = denyCurrentUserRuntimeWorkspaceAccess(c, store, runtime);
  if (denied) return denied;
  return { runtime };
}

export function loadRuntimeForCurrentEditor(
  c: Context,
  store: MultiremiStore,
  runtimeId: string,
  action: "edit" | "delete",
): { runtime: MultiremiRuntime } | Response {
  const loaded = loadRuntimeForCurrentUser(c, store, runtimeId);
  if (loaded instanceof Response) return loaded;
  if (!canCurrentUserEditRuntime(c, store, loaded.runtime)) {
    const verb = action === "delete" ? "delete" : "edit";
    return c.json({ error: `you can only ${verb} your own runtimes` }, 403);
  }
  return loaded;
}

export function loadRuntimeForCurrentOwner(c: Context, store: MultiremiStore, runtimeId: string, feature = "local skills"): { runtime: MultiremiRuntime } | Response {
  const loaded = loadRuntimeForCurrentUser(c, store, runtimeId);
  if (loaded instanceof Response) return loaded;
  if (runtimeOwnerId(loaded.runtime) !== currentRequestUserId(c)) {
    return c.json({ error: `you can only access ${feature} from your own runtimes` }, 403);
  }
  return loaded;
}

export function canCurrentUserEditRuntime(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): boolean {
  const role = currentWorkspaceRole(c, store, runtimeWorkspaceId(runtime));
  if (role === "owner" || role === "admin") return true;
  return runtimeOwnerId(runtime) === currentRequestUserId(c);
}

export function canCurrentUserUseRuntime(c: Context, store: MultiremiStore, runtime: MultiremiRuntime): boolean {
  const workspaceId = runtime.workspaceId ?? "local";
  const role = currentWorkspaceRole(c, store, workspaceId);
  if (role === "owner" || role === "admin") return true;
  if (runtime.visibility === "public") return true;
  return runtime.ownerId === currentRequestUserId(c);
}

export function normalizeRuntimeIds(value: unknown): { runtimeIds: string[] } | { error: string; status: 400 } {
  if (!Array.isArray(value)) return { error: "runtime_ids is required", status: 400 };
  const runtimeIds = uniqueStrings(value);
  if (!runtimeIds.length) return { error: "runtime_ids is required", status: 400 };
  return { runtimeIds };
}

export function deregisterDaemonRuntimes(c: Context, store: MultiremiStore, runtimeIds: string[]): void {
  const token = currentAccessToken(c);
  for (const runtimeId of runtimeIds) {
    const runtime = store.getRuntime(runtimeId);
    if (!runtime) continue;
    if (
      token?.type === "daemon" && (
        (runtime.workspaceId ?? "local") !== token.workspaceId
        || !token.daemonId
        || !runtime.daemonId
        || runtime.daemonId !== token.daemonId
      )
    ) continue;
    const updated = store.setRuntimeOffline(runtimeId);
    if (!updated || runtime.status === updated.status) continue;
    store.emitWorkspaceEvent({
      type: "runtime:updated",
      workspaceId: runtimeWorkspaceId(updated),
      actorType: token?.type === "daemon" ? "daemon" : "member",
      actorId: token?.type === "daemon" ? token.daemonId ?? token.id : currentRequestUserId(c),
      payload: { runtime: runtimeCompatibilityResponse(updated), reason: "daemon_deregistered" },
    });
  }
}

export function isTerminalRuntimeRequestForDaemon(status: string): boolean {
  return status === "completed" || status === "failed" || status === "timeout";
}

export function isValidRuntimeUpdateReportStatus(status: unknown): status is "completed" | "failed" | "running" {
  return status === "completed" || status === "failed" || status === "running";
}

export function daemonLocalSkillListReportBody(input: ReportRuntimeLocalSkillListInput): ReportRuntimeLocalSkillListInput {
  const skills = Array.isArray(input.skills)
    ? input.skills.map((skill) => {
      const record = skill as unknown as Record<string, unknown>;
      const sourcePath = String(record.source_path ?? "");
      const fileCount = Number(record.file_count ?? 0);
      return {
        key: String(record.key ?? ""),
        name: String(record.name ?? ""),
        description: String(record.description ?? ""),
        sourcePath,
        source_path: sourcePath,
        provider: String(record.provider ?? ""),
        fileCount: Number.isFinite(fileCount) ? fileCount : 0,
        file_count: Number.isFinite(fileCount) ? fileCount : 0,
      };
    })
    : input.skills;
  return {
    status: input.status,
    skills,
    supported: input.supported,
    error: input.error,
  };
}

export function daemonLocalSkillImportReportBody(input: ReportRuntimeLocalSkillImportInput): ReportRuntimeLocalSkillImportInput {
  const record = input.skill && typeof input.skill === "object"
    ? input.skill as Record<string, unknown>
    : null;
  return {
    status: input.status,
    skill: record ? {
      name: typeof record.name === "string" ? record.name : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
      content: typeof record.content === "string" ? record.content : undefined,
      source_path: typeof record.source_path === "string" ? record.source_path : undefined,
      provider: typeof record.provider === "string" ? record.provider : undefined,
      files: Array.isArray(record.files) ? record.files as any[] : undefined,
    } : input.skill,
    error: input.error,
  };
}

export function registerDaemonRuntimes(
  store: MultiremiStore,
  body: DaemonRegisterRequestBody,
  auth: { ownerId: string | null } = { ownerId: null },
  includeRelay = false,
  options: { allowLegacyDaemonMigration?: boolean } = {},
):
  | {
    runtimes: ReturnType<typeof daemonRuntimeResponse>[];
    repos: WorkspaceRepoData[];
    repos_version: string;
    settings: Record<string, unknown>;
    relay: Record<string, unknown>;
  }
  | { error: string; status: 400 | 404 | 409 | 500 } {
  // Older self-host clients (e.g. the v0.2.0 `remi` release) omit workspace_id
  // in the register body and relied on the server deriving it. This is a
  // single-workspace local deployment, so default to "local" — matching the
  // `?? "local"` fallback used throughout the rest of the daemon path
  // (daemonRegisterOwnerContext, heartbeat, denyDaemonTokenWorkspace).
  const workspaceId = String(body.workspace_id ?? "").trim() || "local";
  const daemonId = String(body.daemon_id ?? "").trim();
  const runtimes = body.runtimes ?? [];
  if (!daemonId) return { error: "daemon_id is required", status: 400 };
  if (runtimes.length === 0) return { error: "at least one runtime is required", status: 400 };

  const deviceName = String(body.device_name ?? "").trim();
  const cliVersion = String(body.cli_version ?? "").trim();
  const launchedBy = String(body.launched_by ?? "").trim();
  const agentPluginProtocol = normalizeAgentPluginProtocol(body.capabilities?.agent_plugins);
  const legacyDaemonIds = options.allowLegacyDaemonMigration === false
    ? []
    : uniqueStrings(body.legacy_daemon_ids ?? []);
  const repos = workspaceReposResponse(store, workspaceId, includeRelay);
  if (!repos) return { error: "workspace not found", status: 404 };
  const registrations: Array<{
    provider: string;
    version: string;
    id: string;
    previousAgentPluginProtocol: number | null;
    input: Parameters<MultiremiStore["registerDaemonRuntimeBatch"]>[0][number];
  }> = [];
  for (const runtime of runtimes) {
    const providerResult = validateMultiremiRuntimeProvider(runtime.type);
    if ("error" in providerResult) return providerResult;
    const provider = providerResult.provider;
    const version = String(runtime.version ?? "").trim();
    const name = String(runtime.name ?? "").trim() || provider;
    const id = daemonRuntimeId(daemonId, provider);
    const existingRuntime = store.getRuntime(id);
    const deviceInfo = [deviceName, version].filter(Boolean).join(" · ");
    registrations.push({
      provider,
      version,
      id,
      previousAgentPluginProtocol: readAgentPluginProtocol(existingRuntime?.metadata),
      input: {
        id,
        name,
        provider,
        daemonId,
        runtimeMode: "local",
        deviceInfo,
        metadata: {
          version,
          cli_version: cliVersion,
          launched_by: launchedBy,
          agent_plugin_protocol: agentPluginProtocol,
          ...(typeof runtime.acpVersion === "string" && runtime.acpVersion ? { acp_version: runtime.acpVersion } : {}),
          ...(typeof runtime.agentVersion === "string" && runtime.agentVersion ? { agent_version: runtime.agentVersion } : {}),
        },
        workspaceId,
        ownerId: auth.ownerId,
        status: runtime.status === "offline" ? "offline" : "online",
        maxConcurrency: Number.isFinite(Number(runtime.maxConcurrency)) && Number(runtime.maxConcurrency) >= 1
          ? Math.floor(Number(runtime.maxConcurrency))
          : 1,
      },
    });
  }

  let savedRuntimes: ReturnType<MultiremiStore["registerDaemonRuntimeBatch"]>;
  try {
    savedRuntimes = store.registerDaemonRuntimeBatch(
      registrations.map((entry) => entry.input),
      { displayName: deviceName },
    );
  } catch (error) {
    if (
      error instanceof DaemonRetiredError
      || error instanceof DaemonIdentityOwnerConflictError
      || error instanceof RuntimeRegistrationIdentityConflictError
    ) throw error;
    const failed = registrations[0];
    store.recordRuntimeFailure({
      ownerId: auth.ownerId,
      workspaceId,
      daemonId,
      provider: failed?.provider ?? "other",
      failureReason: "registration_failed",
      errorType: "db_error",
      recoverable: true,
    });
    const message = error instanceof Error ? error.message : String(error);
    return { error: `failed to register runtime: ${message}`, status: 500 };
  }

  const registered: ReturnType<typeof daemonRuntimeResponse>[] = [];
  const capabilityChanges: Array<{ runtimeId: string; previous: number | null }> = [];
  for (const [index, registration] of registrations.entries()) {
    const saved = savedRuntimes[index];
    mergeLegacyDaemonRuntimes(store, saved, registration.provider, legacyDaemonIds);
    const current = store.getRuntime(saved.id) ?? saved;
    if (registration.previousAgentPluginProtocol !== agentPluginProtocol) {
      capabilityChanges.push({
        runtimeId: current.id,
        previous: registration.previousAgentPluginProtocol,
      });
    }
    registered.push(daemonRuntimeResponse(current, {
      daemonId,
      version: registration.version,
      cliVersion,
      launchedBy,
    }));
  }
  if (registered.length > 0) {
    for (const change of capabilityChanges) {
      store.emitWorkspaceEvent({
        type: "agent_plugin:runtime_capability",
        workspaceId,
        actorType: "daemon",
        actorId: daemonId,
        payload: {
          runtime_id: change.runtimeId,
          daemon_id: daemonId,
          previous_agent_plugin_protocol: change.previous,
          agent_plugin_protocol: agentPluginProtocol,
          supported: agentPluginProtocol >= MULTIREMI_AGENT_PLUGIN_PROTOCOL_VERSION,
        },
      });
    }
    // Let browsers (e.g. the "Add computer" dialog) auto-detect a daemon coming
    // online and jump to the new runtime. `runtime_id` targets the primary card.
    store.emitWorkspaceEvent({
      type: "daemon:register",
      workspaceId,
      actorType: "daemon",
      actorId: daemonId,
      payload: {
        daemon_id: daemonId,
        device_name: deviceName,
        runtime_id: registered[0].id,
        runtime_ids: registered.map((runtime) => runtime.id),
      },
    });
  }
  return {
    runtimes: registered,
    repos: repos.repos,
    repos_version: repos.repos_version,
    settings: repos.settings,
    relay: repos.relay,
  };
}

function normalizeAgentPluginProtocol(value: unknown): number {
  const protocol = Number(value);
  if (!Number.isSafeInteger(protocol) || protocol < 0) return 0;
  return protocol;
}

function readAgentPluginProtocol(metadata: Record<string, unknown> | null | undefined): number | null {
  if (!metadata || !("agent_plugin_protocol" in metadata || "agentPluginProtocol" in metadata)) return null;
  return normalizeAgentPluginProtocol(metadata.agent_plugin_protocol ?? metadata.agentPluginProtocol);
}

export function daemonRegisterOwnerContext(
  c: Context,
  store: MultiremiStore,
  workspaceId: string | null | undefined,
): { ownerId: string | null } | { error: string; status: 403 } {
  const token = currentAccessToken(c);
  const targetWorkspaceId = cleanString(workspaceId) ?? "local";
  if (!token) {
    const jwtUserId = currentJwtUserId(c);
    if (!jwtUserId) return { ownerId: null };
    if (!hasJwtWorkspaceAccess(store, jwtUserId, targetWorkspaceId)) {
      return { error: "forbidden for token workspace", status: 403 };
    }
    return { ownerId: jwtUserId };
  }
  // Daemon tokens are machine identities: runtimes they register are owned by the
  // user who created the token (during `remi setup`), not left ownerless.
  if (token.type === "daemon") {
    const ownerId = cleanString(token.userId);
    if (
      ownerId
      && ownerId !== "local"
      && !store.getUserRoleInWorkspace(ownerId, targetWorkspaceId)
    ) {
      return { error: "forbidden for token workspace", status: 403 };
    }
    return { ownerId };
  }
  if (token.workspaceId !== targetWorkspaceId) {
    return { error: "forbidden for token workspace", status: 403 };
  }
  const ownerId = cleanString(token.userId) ?? "local";
  if (
    ownerId !== "local"
    && !store.getUserRoleInWorkspace(ownerId, targetWorkspaceId)
  ) {
    return { error: "forbidden for token workspace", status: 403 };
  }
  return { ownerId };
}

export function mergeLegacyDaemonRuntimes(
  store: MultiremiStore,
  newRuntime: MultiremiRuntime,
  provider: string,
  legacyDaemonIds: string[],
): void {
  const mergedRuntimeIds = new Set<string>();
  for (const legacyDaemonId of legacyDaemonIds) {
    const key = legacyDaemonId.toLowerCase();
    const oldRuntimeId = daemonRuntimeId(legacyDaemonId, provider);
    const candidates = store.listRuntimes().filter((runtime) =>
      runtime.id !== newRuntime.id &&
      runtime.provider === provider &&
      runtime.workspaceId === newRuntime.workspaceId &&
      (runtime.id === oldRuntimeId || runtime.daemonId?.toLowerCase() === key)
    );
    for (const candidate of candidates) {
      if (mergedRuntimeIds.has(candidate.id)) continue;
      mergedRuntimeIds.add(candidate.id);
      const merged = store.mergeRuntimeInto(candidate.id, newRuntime.id);
      if (merged.deleted) {
        store.recordRuntimeLegacyDaemonId(newRuntime.id, legacyDaemonId, {
          oldRuntimeId: candidate.id,
          newRuntimeId: newRuntime.id,
          provider,
          agentsReassigned: merged.agentsReassigned,
          tasksReassigned: merged.tasksReassigned,
        });
      }
    }
  }
}

export function cloudRuntimeStatusResponse(c: Context, store: MultiremiStore, body: any, status: string) {
  const id = body.id ?? body.node_id ?? body.nodeId ?? "";
  const node = id ? store.setCloudRuntimeNodeStatus(id, status) : null;
  if (!node) return c.json({ error: "cloud runtime node not found" }, 404);
  return c.json(node);
}
