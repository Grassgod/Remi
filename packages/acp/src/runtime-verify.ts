import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "./client.js";
import { AcpProvider, resolveAcpExecutableForAgent } from "./provider.js";
import { ANTIGRAVITY_PIN, type AntigravityPin, type RuntimeProvider } from "./runtime-versions.js";
import { resolveAntigravityServer } from "./antigravity-install.js";
import { buildAntigravityEnv, seedAntigravityHome } from "./access/antigravity.js";
import type { GatewayShimHost } from "./access/gateway-shim-types.js";

export async function verifyAcpRuntime(provider: RuntimeProvider, bridge: string): Promise<void> {
  const executable = provider === "codex"
    ? process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE || join(bridge, "dist", "index.js")
    : resolveAcpExecutableForAgent(provider, null, "claude-agent-acp");
  const env = provider === "claude" ? { REMI_CLAUDE_AGENT_ACP_DIR: bridge } : undefined;
  if (provider === "codex" && !existsSync(executable)) throw new Error("Codex ACP executable missing");
  if (provider === "codex") verifyCodexRequestUsageProtocol(bridge);
  const checker = new AcpProvider({ agentType: provider, executable, env });
  try {
    if (!await checker.healthCheck()) throw new Error(`${provider} ACP health check failed after runtime preparation`);
  } finally { await checker.close(); }
  const client = new AcpClient({ agentType: provider, executable, env, inheritProcessGroup: true, log: () => {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => { await client.start(); await client.initialize(); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${provider} ACP initialization timed out`)), 15_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.stop();
  }
}

/** The single model the contract check's fake upstream lists. */
export const ANTIGRAVITY_CONTRACT_MODEL = "remi-contract-check";
const CONTRACT_KEY = "remi-contract-check-key";

export interface AntigravityVerifyOptions {
  /** Defaults to the pinned install. */
  server?: { executable: string; args: string[] };
  pin?: AntigravityPin;
  /**
   * Put the daemon's gateway shim in front of the fake upstream. Without it the
   * fake upstream stands in for the shim and sees the server's own headers.
   */
  shim?: (upstream: { baseUrl: string; apiKey: string }) => Promise<{ host: GatewayShimHost; close(): void | Promise<void> }>;
  initializeTimeoutMs?: number;
  contractTimeoutMs?: number;
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The full Antigravity check (§1.4), run by `runtime prepare` and CI. It needs
 * no credentials and sends no prompt:
 * 1. `initialize` only: the pinned server identifies itself and can load sessions.
 * 2. Gateway contract: `session/new` against a fake upstream that lists one
 *    model. The model must reach `configOptions`, and the upstream must see
 *    Bearer auth (the shim's key, and no `x-goog-api-key`, when a shim is given).
 *    This proves the env gate, `settings.json`, the URL shape and the header policy.
 */
export async function verifyAntigravityRuntime(options: AntigravityVerifyOptions = {}): Promise<{ version: string; models: string[] }> {
  const pin = options.pin ?? ANTIGRAVITY_PIN;
  const server = options.server ?? resolveAntigravityServer({ pin });
  const root = mkdtempSync(join(tmpdir(), "remi-agy-verify-"));
  const home = join(root, "home"), cwd = join(root, "work");
  const requests: Array<{ path: string; authorization: string | null; googKey: boolean }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, authorization: request.headers.get("authorization"), googKey: request.headers.has("x-goog-api-key") });
      if (request.method === "GET" && /\/v1beta\/models\/?$/.test(url.pathname)) {
        return Response.json({ models: [{
          name: `models/${ANTIGRAVITY_CONTRACT_MODEL}`, displayName: "Remi contract check",
          supportedGenerationMethods: ["generateContent", "countTokens"], inputTokenLimit: 1_048_576,
        }] });
      }
      return new Response("not served by the contract check", { status: 404 });
    },
  });
  let shim: { host: GatewayShimHost; close(): void | Promise<void> } | null = null;
  try {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    seedAntigravityHome({ home, cwd });
    const upstreamUrl = `http://127.0.0.1:${upstream.port}/contract`;

    const client = new AcpClient({
      agentType: "antigravity", executable: server.executable, args: server.args, cwd, inheritProcessGroup: true, log: () => {},
      env: buildAntigravityEnv({ home, shimUrl: upstreamUrl, model: null, daemonEnv: process.env, launch: server }),
    });
    let version: string;
    try {
      const init = await withTimeout((async () => { await client.start(); return client.initialize(); })(),
        options.initializeTimeoutMs ?? 15_000, "Antigravity ACP initialization timed out");
      if (init.agentInfo?.name !== "antigravity-acp") throw new Error(`unexpected ACP agent ${init.agentInfo?.name ?? "unknown"}`);
      if (init.agentInfo.version !== pin.server) throw new Error(`Antigravity version mismatch: expected ${pin.server}, got ${init.agentInfo.version}`);
      if (init.agentCapabilities?.loadSession !== true) throw new Error("Antigravity no longer advertises loadSession");
      version = init.agentInfo.version;
    } finally {
      await client.stop();
    }

    shim = options.shim ? await options.shim({ baseUrl: upstreamUrl, apiKey: CONTRACT_KEY }) : null;
    const provider = new AcpProvider({
      agentType: "antigravity", executable: server.executable, args: server.args, cwd, providerHome: home, inheritProcessGroup: true,
      ...(shim ? { gatewayShim: shim.host } : { gatewayUrl: upstreamUrl }),
    });
    let models: string[];
    try {
      models = (await withTimeout(provider.discoverModelCapabilities(), options.contractTimeoutMs ?? 120_000,
        "Antigravity gateway contract check timed out")).map((model) => model.id);
    } finally {
      await provider.close();
    }
    if (!models.includes(ANTIGRAVITY_CONTRACT_MODEL)) {
      throw new Error(`Antigravity did not offer the gateway's models (got ${models.join(", ") || "none"}): gateway auth or URL contract changed`);
    }
    const listing = requests.filter((request) => request.path.includes("/models"));
    const bearer = `Bearer ${shim ? CONTRACT_KEY : "remi-shim"}`;
    if (!listing.length || listing.some((request) => request.authorization !== bearer)) {
      throw new Error("the gateway did not receive the expected Bearer authorization");
    }
    if (shim && listing.some((request) => request.googKey)) throw new Error("the gateway shim forwarded x-goog-api-key");
    return { version, models };
  } finally {
    await shim?.close();
    upstream.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Per-request usage rests on app-server facts that patch anchors cannot prove
 * (codex-usage-v6 matched every anchor while its hook never ran): thread/start
 * must still opt into rawResponse/completed, initialize must still drop the
 * raw item stream, and the notification must still name the request.
 */
export function verifyCodexRequestUsageProtocol(bridge: string): void {
  const codex = createRequire(join(bridge, "dist", "index.js")).resolve("@openai/codex/bin/codex.js");
  const out = mkdtempSync(join(tmpdir(), "remi-codex-protocol-"));
  try {
    const result = spawnSync(Bun.which("node") ?? "node", [codex, "app-server", "generate-json-schema", "--experimental", "--out", out], {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, CODEX_HOME: out },
    });
    if (result.status !== 0) throw new Error(`Codex app-server schema generation failed: ${result.stderr || result.error?.message || result.status}`);
    const schema = (file: string) => JSON.parse(readFileSync(join(out, file), "utf8"));
    const start = schema("v2/ThreadStartParams.json").properties ?? {};
    const raw = schema("v2/RawResponseCompletedNotification.json");
    const capabilities = schema("v1/InitializeParams.json").definitions?.InitializeCapabilities?.properties ?? {};
    const missing = [
      start.experimentalRawEvents?.type !== "boolean" && "thread/start experimentalRawEvents",
      !capabilities.optOutNotificationMethods && "initialize optOutNotificationMethods",
      !["threadId", "turnId", "responseId"].every(field => raw.required?.includes(field)) || !raw.properties?.usage
        ? "rawResponse/completed threadId/turnId/responseId/usage" : false,
    ].filter(Boolean);
    if (missing.length) throw new Error(`Codex request usage protocol changed: ${missing.join(", ")}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
