import { createLogger } from "@shared/logger.js";
import type { GatewayModelsSnapshot, MultiremiStore, RelayEngine } from "@multiremi/store/store.js";
import type { MultiremiRuntimeModelThinking } from "@multiremi/contracts/types.js";
import { extractBaseUrl, validateGatewayUrl } from "@multiremi/relay/fragment.js";
import { publicRelayHttpRequest } from "@multiremi/relay/http.js";

const log = createLogger("relay-discovery");

const MODEL_PATH: Record<RelayEngine, string> = { claude: "/v1/models", codex: "/models" };
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h: GET /api/models refreshes a snapshot older than this
const MAX_BODY = 1_000_000;
const TIMEOUT_MS = 10_000;

export interface HttpResponse {
  status: number;
  text: string;
}
/** Injectable so tests don't touch the network. The default implementation resolves
 *  the host and rejects private targets before fetching (see defaultHttpGet). */
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/**
 * Default transport: fetch with a pre-flight resolve check (reject private IPs),
 * no redirect following, timeout, and a streamed size cap.
 *
 * NOTE: Bun's `node:https` custom-`lookup` (IP pinning) does not connect reliably,
 * so we cannot fully close the resolve→connect DNS-rebinding window here. The
 * residual requires a malicious owner/admin (who can already reveal the token) to
 * run rebinding infra against the server's network — accepted for this deployment.
 */
const defaultHttpGet: HttpGet = async (url, headers) => {
  return publicRelayHttpRequest(url, { headers }, { timeoutMs: TIMEOUT_MS, maxBodyBytes: MAX_BODY });
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseBody(text: string): Record<string, unknown> {
  // JSON parser errors can contain response content. Do not persist or log it.
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("gateway returned invalid JSON"); }
  const body = object(value);
  if (!body) throw new Error("gateway returned an invalid model catalog");
  return body;
}

function discoveryError(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (token ? message.replaceAll(token, "[redacted]") : message).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

/** A missing declaration is unknown; an explicit empty set is authoritative. */
function codexThinking(model: Record<string, unknown>): MultiremiRuntimeModelThinking {
  const levels = model.supported_reasoning_levels;
  if (levels === undefined) return { status: "unknown", supportedLevels: [] };
  const invalid = (): MultiremiRuntimeModelThinking => ({
    status: "error", supportedLevels: [], error: "gateway returned invalid reasoning metadata",
  });
  if (!Array.isArray(levels)) return invalid();
  if (!levels.length) return { status: "unsupported", supportedLevels: [] };
  const supportedLevels: MultiremiRuntimeModelThinking["supportedLevels"] = [];
  const seen = new Set<string>();
  for (const candidate of levels) {
    const level = object(candidate);
    if (!level || typeof level.effort !== "string" || !level.effort.trim()
      || (level.description !== undefined && typeof level.description !== "string")) return invalid();
    if (seen.has(level.effort)) continue;
    seen.add(level.effort);
    supportedLevels.push({
      value: level.effort,
      label: level.effort,
      ...(level.description ? { description: level.description } : {}),
    });
  }
  const defaultLevel = model.default_reasoning_level;
  if (defaultLevel !== undefined && (typeof defaultLevel !== "string" || !seen.has(defaultLevel))) return invalid();
  return {
    status: "supported", supportedLevels,
    ...(typeof defaultLevel === "string" ? { defaultLevel } : {}),
  };
}

async function fetchGatewayModels(
  engine: RelayEngine,
  base: string,
  token: string,
  httpGet: HttpGet,
): Promise<{ models: GatewayModelsSnapshot["models"]; nativeCatalogStatus?: GatewayModelsSnapshot["nativeCatalogStatus"]; error?: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (engine === "claude") headers["anthropic-version"] = "2023-06-01";
  const res = await httpGet(joinUrl(base, MODEL_PATH[engine]), headers);
  if (res.status < 200 || res.status >= 300) throw new Error(`gateway HTTP ${res.status}`);
  const body = parseBody(res.text);
  if (!Array.isArray(body.data)) throw new Error("gateway returned an invalid model list");
  const out: GatewayModelsSnapshot["models"] = [];
  const seen = new Set<string>();
  for (const candidate of body.data) {
    const m = object(candidate);
    if (!m) continue;
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: typeof m.display_name === "string" && m.display_name ? m.display_name : id });
  }
  if (engine !== "codex") return { models: out };
  try {
    // This is an origin-relative Codex API, not a child of the /v1 base URL.
    const catalog = await httpGet(new URL("/backend-api/codex/models", base).href, headers);
    if (catalog.status < 200 || catalog.status >= 300) throw new Error(`gateway capability catalog HTTP ${catalog.status}`);
    const parsed = parseBody(catalog.text);
    if (!Array.isArray(parsed.models) || !parsed.models.length) throw new Error("gateway returned an invalid capability catalog");
    const inventory = new Map(out.map(model => [model.id, model]));
    const models: GatewayModelsSnapshot["models"] = [];
    const nativeIds = new Set<string>();
    for (const candidate of parsed.models) {
      const model = object(candidate);
      if (!model || typeof model.slug !== "string" || !model.slug.trim()) throw new Error("gateway returned an invalid capability catalog");
      if (nativeIds.has(model.slug)) continue;
      nativeIds.add(model.slug);
      // The loaded native catalog replaces Codex's bundled catalog. Its selector
      // is authoritative for membership, including native-only models; ordinary
      // /models entries absent here cannot be selected by the execution engine.
      if (model.visibility === "hide" || model.supported_in_api === false) continue;
      models.push({
        id: model.slug,
        label: inventory.get(model.slug)?.label
          ?? (typeof model.display_name === "string" && model.display_name ? model.display_name : model.slug),
        thinking: codexThinking(model),
      });
    }
    return { models, nativeCatalogStatus: "ready" };
  } catch (err) {
    // Preserve model availability, but do not present stale or guessed effort options.
    const error = discoveryError(err, token);
    return { models: out.map((model) => ({ ...model, thinking: { status: "error", supportedLevels: [], error } })), nativeCatalogStatus: "error", error };
  }
}

/** Query one engine's gateway using the stored relay config and cache the result (revision-fenced). */
export async function discoverGatewayModels(
  store: MultiremiStore,
  workspaceId: string,
  engine: RelayEngine,
  httpGet: HttpGet = defaultHttpGet,
): Promise<void> {
  const config = store.getRelayConfigForDaemon(workspaceId);
  const engineConfig = config[engine];
  if (!config.modelDiscovery || !engineConfig) return;
  if (!engineConfig.authToken) {
    // Token cleared → drop the cached catalog so the dropdown stops showing it.
    store.saveGatewayModels(workspaceId, engine, { models: [], sourceRevision: engineConfig.revision });
    return;
  }
  const base = extractBaseUrl(engine, engineConfig.fragment);
  if (!base) return;
  const urlCheck = validateGatewayUrl(base);
  if (!urlCheck.ok) {
    log.warn(`relay ${engine} discovery skipped: ${urlCheck.error}`);
    store.saveGatewayModels(workspaceId, engine, { sourceRevision: engineConfig.revision, error: urlCheck.error });
    return;
  }
  try {
    const { models, nativeCatalogStatus, error } = await fetchGatewayModels(engine, base, engineConfig.authToken, httpGet);
    store.saveGatewayModels(workspaceId, engine, { models, sourceRevision: engineConfig.revision, nativeCatalogStatus, error });
    if (error) log.warn(`relay ${engine} capability discovery failed: ${error}`);
    log.info(`relay ${engine} discovery: ${models.length} models for workspace ${workspaceId}`);
  } catch (err) {
    // Cap + sanitize the stored/logged error so a gateway can't smuggle bytes into the DB/logs.
    const message = discoveryError(err, engineConfig.authToken);
    store.saveGatewayModels(workspaceId, engine, { sourceRevision: engineConfig.revision,
      ...(engine === "codex" ? { nativeCatalogStatus: "error" } : {}), error: message });
    log.warn(`relay ${engine} discovery failed: ${message}`);
  }
}

/** Fire-and-forget discovery for both engines (used on config save / toggle). */
export function triggerGatewayDiscovery(store: MultiremiStore, workspaceId: string, engine?: RelayEngine): void {
  const engines: RelayEngine[] = engine ? [engine] : ["claude", "codex"];
  for (const e of engines) void discoverGatewayModels(store, workspaceId, e).catch(() => {});
}

// Per (workspace,engine) backoff so a persistently-failing gateway isn't hammered by
// every GET /api/models (singleflight-ish; the trigger is request-driven, not a loop).
const lastDiscoveryAttempt = new Map<string, number>();
const DISCOVERY_BACKOFF_MS = 30_000;

/** Lazily refresh a snapshot that is missing, stale, or was discovered for an OLD
 *  config revision (fire-and-forget); returns immediately. */
export function refreshStaleGatewayModels(store: MultiremiStore, workspaceId: string, httpGet: HttpGet = defaultHttpGet): void {
  if (!store.getRelayModelDiscovery(workspaceId)) return;
  const now = Date.now();
  const config = store.getRelayConfigForDaemon(workspaceId);
  for (const engine of ["claude", "codex"] as const) {
    const engineConfig = config[engine];
    if (!engineConfig) continue;
    const snap = store.getGatewayModels(workspaceId, engine);
    // Fresh = discovered for the CURRENT revision AND within the TTL. A revision bump
    // makes any older snapshot stale even if lastSuccessAt is recent.
    const fresh = snap
      && !snap.lastError
      // Pre-native snapshots contain ordinary inventory, whose membership is
      // not executable authority. Upgrade those immediately instead of waiting 1h.
      && (engine !== "codex" || snap.nativeCatalogStatus === "ready")
      && snap.sourceRevision === engineConfig.revision
      && !!snap.lastSuccessAt
      && now - Date.parse(snap.lastSuccessAt) < DISCOVERY_TTL_MS;
    if (fresh) continue;
    const key = `${workspaceId}:${engine}`;
    if (now - (lastDiscoveryAttempt.get(key) ?? 0) < DISCOVERY_BACKOFF_MS) continue;
    lastDiscoveryAttempt.set(key, now);
    void discoverGatewayModels(store, workspaceId, engine, httpGet).catch(() => {});
  }
}
