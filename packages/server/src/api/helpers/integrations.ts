// Outbound integrations: the self-hosted release mirror (version discovery + file resolution),
// and Feishu/Lark SSO
// (authorize URL, code exchange, user info).
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function multiremiReleaseRepository(): string {
  return process.env.MULTIREMI_RELEASE_REPO?.trim()
    || process.env.MULTIREMI_REPO?.trim()
    || "Grassgod/remi";
}

export const MULTIREMI_RELEASE_REPO = multiremiReleaseRepository();

export const MULTIREMI_INSTALL_SCRIPT = "install-remi.sh";

// Self-host release mirror. Intranet machines that can't reach GitHub's asset
// CDN install via MULTIREMI_BASE_URL=<this server>; install-remi.sh then pulls
// the version + tarball from /api/remi/releases/* below. Tarballs come from
// MULTIREMI_RELEASE_DIR (default <repo>/dist), scripts from <repo>/scripts.
// Five levels up from packages/server/src/api/helpers/ — keep in step with this file's depth.
export const MULTIREMI_REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

export const MULTIREMI_RELEASE_TARBALL_RE = /^(?:multiremi|remi)-(\d+\.\d+\.\d+)-(?:linux|darwin)-(?:x64|arm64)\.tar\.gz$/;

export function multiremiReleaseDir(): string {
  return process.env.MULTIREMI_RELEASE_DIR ?? join(MULTIREMI_REPO_ROOT, "dist");
}

export function multiremiScriptsDir(): string {
  return process.env.MULTIREMI_SCRIPTS_DIR ?? join(MULTIREMI_REPO_ROOT, "scripts");
}

export function compareMultiremiVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export function latestMirrorReleaseVersion(): string | null {
  let entries: string[];
  try {
    entries = readdirSync(multiremiReleaseDir());
  } catch {
    return null;
  }
  const versions = entries
    .map((f) => f.match(MULTIREMI_RELEASE_TARBALL_RE)?.[1])
    .filter((v): v is string => Boolean(v));
  if (versions.length === 0) return null;
  return versions.sort(compareMultiremiVersions)[versions.length - 1];
}

export function resolveMirrorReleaseFile(filename: string | undefined): string | null {
  if (!filename || filename.includes("/") || filename.includes("..") || filename.includes("\\")) return null;
  if (/^(multiremi|remi)-v?\d[\w.\-]*\.tar\.gz$/.test(filename)) {
    const p = join(multiremiReleaseDir(), filename);
    return existsSync(p) ? p : null;
  }
  if (/^install[\w.\-]*\.sh$/.test(filename)) {
    const p = join(multiremiScriptsDir(), filename);
    return existsSync(p) ? p : null;
  }
  return null;
}

// ── Feishu (Lark) SSO ──────────────────────────────────────────────
// Credentials come from env (MULTIREMI_LARK_APP_ID / _APP_SECRET / _DOMAIN).
// Reuses the same authen/v1 + authen/v2 OAuth flow as src/auth/oauth-cli.ts.
export interface LarkSsoConfig {
  appId: string;
  appSecret: string;
  apiBase: string;
}

export function loadLarkSsoConfig(): LarkSsoConfig | null {
  const appId = process.env.MULTIREMI_LARK_APP_ID?.trim();
  const appSecret = process.env.MULTIREMI_LARK_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  const domain = process.env.MULTIREMI_LARK_DOMAIN?.trim();
  const apiBase =
    domain === "lark" || domain === "larksuite"
      ? "https://open.larksuite.com/open-apis"
      : domain && domain.startsWith("http")
        ? `${domain.replace(/\/+$/, "")}/open-apis`
        : "https://open.feishu.cn/open-apis";
  return { appId, appSecret, apiBase };
}

export function buildLarkAuthorizeUrl(cfg: LarkSsoConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${cfg.apiBase}/authen/v1/authorize?${params.toString()}`;
}

export async function larkExchangeCode(cfg: LarkSsoConfig, code: string, redirectUri: string): Promise<string> {
  const resp = await fetch(`${cfg.apiBase}/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      redirect_uri: redirectUri,
    }),
  });
  const result = (await resp.json()) as {
    code?: number;
    error?: string;
    error_description?: string;
    access_token?: string;
  };
  if (result.error) throw new Error(`Feishu token exchange failed: ${result.error_description ?? result.error}`);
  if (result.code && result.code !== 0) throw new Error(`Feishu token exchange failed: code ${result.code}`);
  if (!result.access_token) throw new Error("Feishu token exchange failed: no access_token returned");
  return result.access_token;
}

export async function larkFetchUserInfo(cfg: LarkSsoConfig, userAccessToken: string): Promise<{ name: string; email: string | null; openId: string | null }> {
  const resp = await fetch(`${cfg.apiBase}/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  const result = (await resp.json()) as {
    code?: number;
    msg?: string;
    data?: { name?: string; email?: string; enterprise_email?: string; open_id?: string };
  };
  if (result.code && result.code !== 0) throw new Error(`Feishu user_info failed: ${result.msg ?? result.code}`);
  const data = result.data ?? {};
  return {
    name: data.name?.trim() || "Feishu User",
    email: (data.enterprise_email || data.email || "").trim() || null,
    openId: data.open_id ?? null,
  };
}
