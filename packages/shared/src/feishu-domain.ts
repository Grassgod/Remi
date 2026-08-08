/**
 * Feishu/Lark domain → open-apis base URL.
 *
 * Lives in shared because both packages/auth (token exchange) and
 * packages/connectors (card/message APIs) need it, and auth must not depend on
 * connectors.
 */

/**
 * `"feishu"` (or unset) → the Feishu cloud, `"lark"` → the international cloud,
 * anything starting with `http` → a self-hosted deployment.
 */
export function resolveApiBase(domain?: string): string {
  if (domain === "lark") return "https://open.larksuite.com/open-apis";
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}
