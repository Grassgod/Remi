import type {
  MultiremiScmConnection,
  MultiremiScmConnectionCredential,
  MultiremiScmRepositoryBinding,
  MultiremiScmVerificationResult,
  MultiremiScmVerificationStatus,
} from "@multiremi/contracts/types.js";
import { codebaseAuthHeaders } from "./access-token.js";

export interface VerifyScmConnectionInput {
  connection: MultiremiScmConnection;
  credential: MultiremiScmConnectionCredential;
  bindings: MultiremiScmRepositoryBinding[];
}

export type ScmConnectionVerifier = (
  input: VerifyScmConnectionInput,
) => Promise<MultiremiScmVerificationResult>;

export function createScmConnectionVerifier(fetchImpl: typeof fetch = fetch): ScmConnectionVerifier {
  return async (input) => verifyScmConnection(input, fetchImpl);
}

async function verifyScmConnection(
  input: VerifyScmConnectionInput,
  fetchImpl: typeof fetch,
): Promise<MultiremiScmVerificationResult> {
  const verifiedAt = new Date().toISOString();
  const repositoryTotal = input.bindings.length;
  const token = input.credential.accessToken?.trim();
  if (!token) {
    return failure("invalid", verifiedAt, repositoryTotal, "missing_access_token", "Access Token 未配置");
  }

  try {
    const identity = input.connection.provider === "github"
      ? await verifyGitHubIdentity(input.connection, token, fetchImpl)
      : await verifyCodebaseIdentity(input.connection, token, fetchImpl);
    let repositoryCount = 0;
    let firstRepositoryError: VerificationProbeError | null = null;
    for (const binding of input.bindings) {
      try {
        if (input.connection.provider === "github") {
          await verifyGitHubRepository(input.connection, binding, token, fetchImpl);
        } else {
          await verifyCodebaseRepository(input.connection, binding, token, fetchImpl);
        }
        repositoryCount += 1;
      } catch (error) {
        const probeError = toProbeError(error);
        firstRepositoryError ??= probeError;
        if (probeError.status === "rate_limited" || probeError.status === "unreachable") throw probeError;
      }
    }
    if (repositoryCount < repositoryTotal) {
      return {
        status: "partial",
        verifiedAt,
        identity,
        repositoryCount,
        repositoryTotal,
        errorCode: firstRepositoryError?.code ?? "repository_access_failed",
        error: firstRepositoryError?.publicMessage ?? "Token 有效，但部分仓库不可访问",
      };
    }
    return {
      status: "valid",
      verifiedAt,
      identity,
      repositoryCount,
      repositoryTotal,
      errorCode: null,
      error: null,
    };
  } catch (error) {
    const probeError = toProbeError(error);
    return failure(
      probeError.status,
      verifiedAt,
      repositoryTotal,
      probeError.code,
      probeError.publicMessage,
    );
  }
}

async function verifyGitHubIdentity(
  connection: MultiremiScmConnection,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const data = await requestJson(fetchImpl, `${trimSlash(connection.apiBaseUrl)}/user`, {
    method: "GET",
    headers: githubHeaders(token),
  });
  const user = record(data);
  return stringValue(user.login) || stringValue(user.name) || nullableIdentity(user.id);
}

async function verifyGitHubRepository(
  connection: MultiremiScmConnection,
  binding: MultiremiScmRepositoryBinding,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (!binding.owner?.trim() || !binding.name.trim()) {
    throw new VerificationProbeError("partial", "repository_coordinates_missing", "仓库缺少 owner 或 name");
  }
  const path = `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}`;
  await requestJson(fetchImpl, `${trimSlash(connection.apiBaseUrl)}${path}`, {
    method: "GET",
    headers: githubHeaders(token),
  });
}

async function verifyCodebaseIdentity(
  connection: MultiremiScmConnection,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const result = await codebaseAction(fetchImpl, connection.apiBaseUrl, token, "GetCurrentUser", {});
  const user = recordValue(result, "User", "user", "CurrentUser", "current_user");
  return stringValue(user.Username)
    || stringValue(user.username)
    || stringValue(user.Name)
    || stringValue(user.name)
    || nullableIdentity(user.Id ?? user.id);
}

async function verifyCodebaseRepository(
  connection: MultiremiScmConnection,
  binding: MultiremiScmRepositoryBinding,
  token: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const path = [binding.owner, binding.name].filter(Boolean).join("/");
  if (!binding.externalId?.trim() && !path) {
    throw new VerificationProbeError("partial", "repository_coordinates_missing", "仓库缺少路径或外部 ID");
  }
  const result = await codebaseAction(fetchImpl, connection.apiBaseUrl, token, "GetRepository", {
    ...(binding.externalId?.trim() ? { Id: binding.externalId.trim() } : { Path: path }),
    Selector: { PushedAt: true },
  });
  if (!Object.keys(recordValue(result, "Repository", "repository")).length) {
    throw new VerificationProbeError("partial", "repository_not_found", "Token 有效，但仓库不可访问");
  }
}

async function codebaseAction(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${trimSlash(apiBaseUrl)}/`);
  url.searchParams.set("Action", action);
  const data = await requestJson(fetchImpl, url.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "multiremi-scm-verifier",
      ...codebaseAuthHeaders(token),
    },
    body: JSON.stringify(body),
  });
  const response = record(data);
  const metadata = recordValue(response, "ResponseMetadata", "response_metadata");
  const providerError = recordValue(metadata, "Error", "error");
  if (Object.keys(providerError).length) {
    const code = stringValue(providerError.Code) || stringValue(providerError.code) || "provider_error";
    throw classifyProviderError(400, code);
  }
  return recordValue(response, "Result", "result");
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new VerificationProbeError("unreachable", "provider_unreachable", "无法连接代码托管服务");
  }
  if (!response.ok) throw classifyProviderError(response.status);
  try {
    return await response.json();
  } catch {
    throw new VerificationProbeError("unreachable", "invalid_provider_response", "代码托管服务返回了无效响应");
  }
}

function classifyProviderError(status: number, providerCode = ""): VerificationProbeError {
  const normalizedCode = providerCode.toLowerCase();
  if (status === 401 || status === 403 || /auth|token|permission|unauthor/iu.test(normalizedCode)) {
    return new VerificationProbeError("invalid", "authentication_failed", "Token 无效或权限不足");
  }
  if (status === 429 || /rate|quota|limit/iu.test(normalizedCode)) {
    return new VerificationProbeError("rate_limited", "rate_limited", "代码托管服务请求频率受限，请稍后重试");
  }
  if (status >= 500) {
    return new VerificationProbeError("unreachable", "provider_unavailable", "代码托管服务暂时不可用");
  }
  if (status === 404) {
    return new VerificationProbeError("partial", "repository_not_found", "Token 有效，但仓库不可访问");
  }
  return new VerificationProbeError("partial", "provider_request_failed", "代码托管服务拒绝了仓库访问请求");
}

class VerificationProbeError extends Error {
  constructor(
    readonly status: Exclude<MultiremiScmVerificationStatus, "unverified" | "verifying" | "valid">,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

function toProbeError(error: unknown): VerificationProbeError {
  return error instanceof VerificationProbeError
    ? error
    : new VerificationProbeError("unreachable", "verification_failed", "验证请求失败，请稍后重试");
}

function failure(
  status: VerificationProbeError["status"],
  verifiedAt: string,
  repositoryTotal: number,
  errorCode: string,
  error: string,
): MultiremiScmVerificationResult {
  return {
    status,
    verifiedAt,
    identity: null,
    repositoryCount: 0,
    repositoryTotal,
    errorCode,
    error,
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "multiremi-scm-verifier",
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordValue(value: unknown, ...keys: string[]): Record<string, unknown> {
  const source = record(value);
  for (const key of keys) {
    const candidate = record(source[key]);
    if (Object.keys(candidate).length) return candidate;
  }
  return {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableIdentity(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  return null;
}
