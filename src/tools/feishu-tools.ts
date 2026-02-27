/**
 * Feishu/Lark document reading tools.
 *
 * Provides read_feishu_doc tool for the AI agent to fetch content
 * from Feishu wiki pages, docx documents, etc.
 *
 * Supports:
 * - Wiki URLs (https://xxx.feishu.cn/wiki/{token})
 * - Docx URLs (https://xxx.feishu.cn/docx/{token})
 * - Raw tokens (auto-detected)
 *
 * Authentication: tenant_access_token (from app credentials) or
 * user_access_token (from config/env).
 */

import type { FeishuConfig } from "../config.js";
import { resolveApiBase } from "../connectors/feishu/client.js";

// ── Types ────────────────────────────────────────────────────

interface TokenInfo {
  token: string;
  type: "wiki" | "docx" | "doc" | "sheet" | "bitable" | "unknown";
}

interface WikiNode {
  objToken: string;
  objType: string;
  title: string;
}

interface TenantTokenCache {
  token: string;
  expiresAt: number;
}

// ── Token management ─────────────────────────────────────────

let tenantTokenCache: TenantTokenCache | null = null;

async function getTenantAccessToken(
  apiBase: string,
  appId: string,
  appSecret: string,
): Promise<string> {
  if (tenantTokenCache && Date.now() < tenantTokenCache.expiresAt) {
    return tenantTokenCache.token;
  }

  const resp = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = (await resp.json()) as {
    code: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Failed to get tenant_access_token: ${data.msg ?? `code ${data.code}`}`);
  }

  tenantTokenCache = {
    token: data.tenant_access_token,
    // Expire 5 minutes early to avoid edge cases
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000 - 5 * 60 * 1000,
  };

  return tenantTokenCache.token;
}

async function getAccessToken(
  apiBase: string,
  config: FeishuConfig & { userAccessToken?: string },
): Promise<string> {
  if (config.userAccessToken) {
    return config.userAccessToken;
  }
  return getTenantAccessToken(apiBase, config.appId, config.appSecret);
}

// ── URL parsing ──────────────────────────────────────────────

/**
 * Parse a Feishu URL or raw token into a structured TokenInfo.
 *
 * Supported URL patterns:
 * - https://xxx.feishu.cn/wiki/{token}
 * - https://xxx.larkoffice.com/wiki/{token}
 * - https://xxx.feishu.cn/docx/{token}
 * - https://xxx.feishu.cn/docs/{token}
 * - https://xxx.feishu.cn/sheets/{token}
 * - https://xxx.feishu.cn/base/{token}
 * - Raw token string
 */
function parseFeishuUrl(urlOrToken: string): TokenInfo {
  const trimmed = urlOrToken.trim();

  // Try to parse as URL
  try {
    const url = new URL(trimmed);
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (pathParts.length >= 2) {
      const docType = pathParts[0].toLowerCase();
      const token = pathParts[1];

      const typeMap: Record<string, TokenInfo["type"]> = {
        wiki: "wiki",
        docx: "docx",
        docs: "doc",
        sheets: "sheet",
        base: "bitable",
      };

      return {
        token,
        type: typeMap[docType] ?? "unknown",
      };
    }
  } catch {
    // Not a URL, treat as raw token
  }

  // Raw token — guess type based on length/pattern
  // Wiki tokens and docx tokens look similar, default to wiki
  return { token: trimmed, type: "wiki" };
}

// ── API calls ────────────────────────────────────────────────

async function apiGet(
  apiBase: string,
  path: string,
  token: string,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${apiBase}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const data = (await resp.json()) as { code: number; msg?: string; data?: Record<string, unknown> };

  if (data.code !== 0) {
    throw new Error(`Feishu API error (${path}): ${data.msg ?? `code ${data.code}`}`);
  }

  return data.data ?? {};
}

/**
 * Resolve a wiki token to the underlying document token and type.
 */
async function resolveWikiNode(
  apiBase: string,
  accessToken: string,
  wikiToken: string,
): Promise<WikiNode> {
  const data = await apiGet(
    apiBase,
    `/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`,
    accessToken,
  );

  const node = data.node as Record<string, unknown> | undefined;
  if (!node) {
    throw new Error(`Wiki node not found for token: ${wikiToken}`);
  }

  return {
    objToken: (node.obj_token as string) ?? "",
    objType: (node.obj_type as string) ?? "docx",
    title: (node.title as string) ?? "",
  };
}

/**
 * Get the raw text content of a docx document.
 */
async function getDocxRawContent(
  apiBase: string,
  accessToken: string,
  docToken: string,
): Promise<string> {
  const data = await apiGet(
    apiBase,
    `/docx/v1/documents/${encodeURIComponent(docToken)}/raw_content?lang=0`,
    accessToken,
  );

  return (data.content as string) ?? "";
}

/**
 * Get the content of an old-style doc (v1 docs).
 */
async function getDocContent(
  apiBase: string,
  accessToken: string,
  docToken: string,
): Promise<string> {
  const data = await apiGet(
    apiBase,
    `/doc/v2/${encodeURIComponent(docToken)}/raw_content`,
    accessToken,
  );

  return (data.content as string) ?? "";
}

// ── Main tool function ───────────────────────────────────────

async function readFeishuDoc(
  urlOrToken: string,
  apiBase: string,
  config: FeishuConfig & { userAccessToken?: string },
  tokenProvider?: () => Promise<string>,
): Promise<string> {
  if (!tokenProvider && (!config.appId || !config.appSecret)) {
    return "[错误] 飞书凭据未配置。请在 remi.toml 或环境变量中设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。";
  }

  const parsed = parseFeishuUrl(urlOrToken);
  const accessToken = tokenProvider
    ? await tokenProvider()
    : await getAccessToken(apiBase, config);

  let title = "";
  let content = "";

  if (parsed.type === "wiki") {
    // Wiki: resolve to underlying document, then fetch content
    const node = await resolveWikiNode(apiBase, accessToken, parsed.token);
    title = node.title;

    if (node.objType === "docx" || node.objType === "doc") {
      if (node.objType === "docx") {
        content = await getDocxRawContent(apiBase, accessToken, node.objToken);
      } else {
        content = await getDocContent(apiBase, accessToken, node.objToken);
      }
    } else {
      return `[Wiki] "${node.title}" 是 ${node.objType} 类型文档，当前仅支持读取 docx/doc 类型。`;
    }
  } else if (parsed.type === "docx") {
    content = await getDocxRawContent(apiBase, accessToken, parsed.token);
  } else if (parsed.type === "doc") {
    content = await getDocContent(apiBase, accessToken, parsed.token);
  } else {
    return `[错误] 不支持的文档类型: ${parsed.type}。当前支持: wiki, docx, doc。`;
  }

  // Format output
  const parts: string[] = [];
  if (title) parts.push(`# ${title}\n`);
  parts.push(content);

  const result = parts.join("\n").trim();
  if (!result) {
    return "[文档内容为空]";
  }

  // Truncate if too long (avoid blowing up context)
  const MAX_CHARS = 50000;
  if (result.length > MAX_CHARS) {
    return result.slice(0, MAX_CHARS) + `\n\n... [内容截断，共 ${result.length} 字符，已显示前 ${MAX_CHARS} 字符]`;
  }

  return result;
}

// ── Export ────────────────────────────────────────────────────

/**
 * Create Feishu document tools for AI agent use.
 */
export function getFeishuTools(
  config: FeishuConfig & { userAccessToken?: string },
  tokenProvider?: () => Promise<string>,
): Record<string, (...args: unknown[]) => Promise<string>> {
  const apiBase = resolveApiBase(config.domain as "feishu" | "lark" | undefined);

  async function read_feishu_doc(url: string): Promise<string> {
    try {
      return await readFeishuDoc(String(url), apiBase, config, tokenProvider);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `[读取飞书文档失败] ${msg}`;
    }
  }
  (read_feishu_doc as { __doc__?: string }).__doc__ =
    "读取飞书/Lark文档内容。支持 wiki 页面和 docx 文档。" +
    "参数为飞书文档 URL（如 https://xxx.feishu.cn/wiki/xxx）或文档 token。";

  return {
    read_feishu_doc: read_feishu_doc as (...args: unknown[]) => Promise<string>,
  };
}
