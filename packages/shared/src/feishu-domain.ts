/**
 * Feishu/Lark domain → open-apis base URL.
 *
 * Lives in shared because both packages/auth (token exchange) and
 * packages/connectors (card/message APIs) need it, and auth must not depend on
 * connectors.
 */

/**
 * `"feishu"` (or unset) -> the Feishu cloud, `"lark"` -> the international
 * cloud, `"bytedance"` -> ByteDance's internal Feishu cloud, and an http(s)
 * URL -> a self-hosted deployment.
 */
export function resolveApiOrigin(domain?: string): string {
  if (domain === "lark") return "https://open.larksuite.com";
  if (domain === "bytedance") return "https://fsopen.bytedance.net";
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return domain.replace(/\/+$/, "");
  }
  return "https://open.feishu.cn";
}

export function resolveApiBase(domain?: string): string {
  return `${resolveApiOrigin(domain)}/open-apis`;
}
