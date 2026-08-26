import type { MultiremiIssue } from "@multiremi/contracts/types.js";
import { extractBaseUrl, validateGatewayUrl } from "@multiremi/relay/fragment.js";
import {
  publicRelayHttpRequest,
  type RelayHttpRequest,
} from "@multiremi/relay/http.js";
import type { MultiremiStore, RelayEngine } from "@multiremi/store/store.js";
import { buildIssueTitlePrompt } from "./prompt.js";
import { resolveIssueAutoTitleSettings } from "./settings.js";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_TITLE_CHARS = 40;

export class IssueTitleGatewayUnconfiguredError extends Error {
  constructor() {
    super("workspace model gateway is not configured");
    this.name = "IssueTitleGatewayUnconfiguredError";
  }
}

export interface GeneratedIssueTitle {
  title: string;
  keep: boolean;
  model: string;
}

export interface GenerateIssueTitleInput {
  issue: MultiremiIssue;
  projectName?: string | null;
  httpRequest?: RelayHttpRequest;
}

interface GatewayCandidate {
  engine: RelayEngine;
  baseUrl: string;
  authToken: string;
}

export async function generateIssueTitle(
  store: Pick<MultiremiStore, "getRelayConfigForDaemon" | "getWorkspace">,
  input: GenerateIssueTitleInput,
): Promise<GeneratedIssueTitle> {
  const gateway = resolveGateway(store, input.issue.workspaceId);
  if (!gateway) throw new IssueTitleGatewayUnconfiguredError();
  const model = resolveIssueAutoTitleSettings(store.getWorkspace(input.issue.workspaceId)?.settings).model;
  const prompt = buildIssueTitlePrompt({
    identifier: input.issue.key,
    currentTitle: input.issue.title,
    description: input.issue.description,
    projectName: input.projectName ?? null,
  });
  const urlCheck = validateGatewayUrl(gateway.baseUrl);
  if (!urlCheck.ok) throw new Error(urlCheck.error);

  const response = await (input.httpRequest ?? publicRelayHttpRequest)(
    gatewayEndpoint(gateway),
    {
      method: "POST",
      headers: gatewayHeaders(gateway),
      body: JSON.stringify(gatewayBody(gateway, model, prompt)),
    },
    { timeoutMs: REQUEST_TIMEOUT_MS, maxBodyBytes: MAX_RESPONSE_BYTES },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`gateway HTTP ${response.status}`);
  }
  const responseText = extractGatewayText(gateway.engine, response.text);
  return { ...parseIssueTitleResponse(responseText), model };
}

export function parseIssueTitleResponse(raw: string): { title: string; keep: boolean } {
  let candidate = raw.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1]!.trim();
  if (!candidate.startsWith("{")) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) candidate = candidate.slice(start, end + 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("model returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model returned invalid result");
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.keep !== "boolean" || typeof value.title !== "string") {
    throw new Error("model returned invalid result");
  }
  if (/\r|\n/.test(value.title)) throw new Error("model returned a multiline title");
  const title = stripWrappingQuotes(value.title.trim()).trim();
  const length = [...title].length;
  if (!title || length > MAX_TITLE_CHARS) throw new Error("model returned an invalid title length");
  return { title, keep: value.keep };
}

function resolveGateway(
  store: Pick<MultiremiStore, "getRelayConfigForDaemon">,
  workspaceId: string,
): GatewayCandidate | null {
  const config = store.getRelayConfigForDaemon(workspaceId);
  for (const engine of ["codex", "claude"] as const) {
    const relay = config[engine];
    if (!relay?.authToken) continue;
    const baseUrl = extractBaseUrl(engine, relay.fragment);
    if (baseUrl) return { engine, baseUrl, authToken: relay.authToken };
  }
  return null;
}

function gatewayEndpoint(gateway: GatewayCandidate): string {
  const base = gateway.baseUrl.replace(/\/+$/, "");
  if (gateway.engine === "claude") return `${base}/v1/messages`;
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function gatewayHeaders(gateway: GatewayCandidate): Record<string, string> {
  return {
    Authorization: `Bearer ${gateway.authToken}`,
    "Content-Type": "application/json",
    ...(gateway.engine === "claude" ? { "anthropic-version": "2023-06-01" } : {}),
  };
}

function gatewayBody(
  gateway: GatewayCandidate,
  model: string,
  prompt: ReturnType<typeof buildIssueTitlePrompt>,
): Record<string, unknown> {
  if (gateway.engine === "claude") {
    return {
      model,
      max_tokens: 160,
      temperature: 0.2,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    };
  }
  return {
    model,
    max_tokens: 160,
    temperature: 0.2,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  };
}

function extractGatewayText(engine: RelayEngine, raw: string): string {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("gateway returned invalid JSON");
  }
  if (engine === "claude") {
    const content = Array.isArray(body.content) ? body.content : [];
    const text = content
      .map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).text : null)
      .find((item): item is string => typeof item === "string");
    if (text) return text;
  } else {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0];
    const message = first && typeof first === "object" ? (first as Record<string, unknown>).message : null;
    const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : null;
    if (typeof content === "string") return content;
  }
  throw new Error("gateway response did not contain model text");
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"]];
  for (const [left, right] of pairs) {
    if (value.startsWith(left) && value.endsWith(right) && value.length >= 2) {
      return value.slice(left.length, -right.length);
    }
  }
  return value;
}
