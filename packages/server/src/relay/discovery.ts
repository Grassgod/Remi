import { lookup as dnsLookup } from "node:dns/promises";
import { createLogger } from "@shared/logger.js";
import type { MultiremiStore, RelayEngine } from "@multiremi/store/store.js";
import { extractBaseUrl, validateGatewayUrl } from "@multiremi/relay/fragment.js";

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

/** True if the (possibly IPv4-mapped-IPv6) address is loopback/private/link-local/metadata. */
function isPrivateIp(ip: string): boolean {
  let addr = ip.toLowerCase();
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) addr = mapped[1];
  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT / shared
  }
  // fe80::/10 spans fe80–febf, and unique-local is fc00::/7 (fc/fd).
  return addr === "::1" || addr === "::" || /^fe[89ab]/.test(addr) || addr.startsWith("fc") || addr.startsWith("fd");
}

/** Resolve the host and reject if any address is internal (SSRF: no private targets). */
async function assertPublicHost(hostname: string): Promise<void> {
  const results = await dnsLookup(hostname, { all: true });
  if (results.length === 0) throw new Error("gateway host did not resolve");
  for (const { address } of results) {
    if (isPrivateIp(address)) throw new Error("gateway host resolves to a private address");
  }
}

/** Read the response with a hard size cap applied WHILE streaming (never buffer a huge body). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new Error("gateway response too large");
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error("gateway response too large"); }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(merged);
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
  const u = new URL(url);
  await assertPublicHost(u.hostname);
  const res = await fetch(u, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, text: await readCapped(res, MAX_BODY) };
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
