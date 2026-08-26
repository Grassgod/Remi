import { createLogger } from "@shared/logger.js";
import type { MultiremiStore, RelayEngine } from "@multiremi/store/store.js";
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

async function fetchGatewayModels(
  engine: RelayEngine,
  base: string,
  token: string,
  httpGet: HttpGet,
): Promise<Array<{ id: string; label: string }>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (engine === "claude") headers["anthropic-version"] = "2023-06-01";
  const res = await httpGet(joinUrl(base, MODEL_PATH[engine]), headers);
  if (res.status < 200 || res.status >= 300) throw new Error(`gateway HTTP ${res.status}`);
  const body = JSON.parse(res.text) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
  const out: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const m of body.data ?? []) {
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: typeof m.display_name === "string" && m.display_name ? m.display_name : id });
  }
  return out;
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
    const models = await fetchGatewayModels(engine, base, engineConfig.authToken, httpGet);
    store.saveGatewayModels(workspaceId, engine, { models, sourceRevision: engineConfig.revision });
    log.info(`relay ${engine} discovery: ${models.length} models for workspace ${workspaceId}`);
  } catch (err) {
    // Cap + sanitize the stored/logged error so a gateway can't smuggle bytes into the DB/logs.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    store.saveGatewayModels(workspaceId, engine, { sourceRevision: engineConfig.revision, error: message });
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
export function refreshStaleGatewayModels(store: MultiremiStore, workspaceId: string): void {
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
      && snap.sourceRevision === engineConfig.revision
      && !!snap.lastSuccessAt
      && now - Date.parse(snap.lastSuccessAt) < DISCOVERY_TTL_MS;
    if (fresh) continue;
    const key = `${workspaceId}:${engine}`;
    if (now - (lastDiscoveryAttempt.get(key) ?? 0) < DISCOVERY_BACKOFF_MS) continue;
    lastDiscoveryAttempt.set(key, now);
    void discoverGatewayModels(store, workspaceId, engine).catch(() => {});
  }
}
