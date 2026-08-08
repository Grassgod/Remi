// Outbound integrations: the self-hosted release mirror (version discovery + file resolution),
// the GitHub App (state signing, connect/setup responses, webhook handling) and Feishu/Lark SSO
// (authorize URL, code exchange, user info).
import { createHmac } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiGitHubPullRequest, MultiremiGitHubPullRequestState } from "@multiremi/contracts/types.js";
import { stringOrDefault } from "./common.js";

export const MULTIREMI_RELEASE_REPO = process.env.MULTIREMI_RELEASE_REPO ?? "Grassgod/remi";

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

export type NormalizedGitHubPullRequestBody = {
  workspaceId: string | null;
  issueId: string | null;
  repoOwner: string;
  repoName: string;
  number: number;
  title: string;
  state?: MultiremiGitHubPullRequestState | string;
  htmlUrl: string | null;
  branch: string | null;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  prCreatedAt: string | null;
  prUpdatedAt: string | null;
  mergeableState: string | null;
  checksConclusion: string | null;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
  additions: number;
  deletions: number;
  changedFiles: number;
};

export function githubAppSlug(): string {
  return (process.env.GITHUB_APP_SLUG ?? "").trim();
}

export function githubWebhookSecret(): string {
  return (process.env.GITHUB_WEBHOOK_SECRET ?? process.env.MULTIREMI_WEBHOOK_SECRET ?? "").trim();
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(githubAppSlug() && githubWebhookSecret());
}

export function signGitHubState(workspaceId: string): string {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const payload = `${workspaceId}.${nonce}`;
  const sig = createHmac("sha256", githubWebhookSecret()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function githubConnectResponse(workspaceId: string): { configured: boolean; url?: string } {
  if (!isGitHubAppConfigured()) return { configured: false };
  const state = signGitHubState(workspaceId);
  return {
    configured: true,
    url: `https://github.com/apps/${encodeURIComponent(githubAppSlug())}/installations/new?state=${encodeURIComponent(state)}`,
  };
}

export function githubSetupResponse(installationId?: string, state?: string): {
  configured: boolean;
  installation_id?: string;
  state?: string;
  error?: string;
} {
  if (!isGitHubAppConfigured()) return { configured: false, error: "github app is not configured" };
  if (!installationId || !state) return { configured: true, error: "missing_params" };
  return { configured: true, installation_id: installationId, state };
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

export function handleGitHubWebhook(store: MultiremiStore, body: any): { ok: string } | { ok: true; ignored: true } | { pullRequest: MultiremiGitHubPullRequest } {
  if (body.zen) return { ok: "pong" };
  const pr = body.pull_request;
  const repo = body.repository;
  if (!pr || !repo) return { ok: true, ignored: true };
  const pullRequest = store.upsertGitHubPullRequest(normalizeGitHubPullRequestBody({
    workspaceId: body.workspaceId ?? body.workspace_id ?? "local",
    repoOwner: repo.owner?.login,
    repoName: repo.name,
    number: pr.number,
    title: pr.title,
    state: pr.merged ? "merged" : pr.draft ? "draft" : pr.state,
    htmlUrl: pr.html_url,
    branch: pr.head?.ref,
    authorLogin: pr.user?.login,
    authorAvatarUrl: pr.user?.avatar_url,
    mergedAt: pr.merged_at,
    closedAt: pr.closed_at,
    prCreatedAt: pr.created_at,
    prUpdatedAt: pr.updated_at,
    mergeableState: pr.mergeable_state,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
  }));
  return { pullRequest };
}

export function normalizeGitHubPullRequestBody(body: any): NormalizedGitHubPullRequestBody {
  return {
    workspaceId: stringOrDefault(body.workspaceId ?? body.workspace_id, "local"),
    issueId: body.issueId ?? body.issue_id ?? null,
    repoOwner: stringOrDefault(body.repoOwner ?? body.repo_owner ?? body.owner, ""),
    repoName: stringOrDefault(body.repoName ?? body.repo_name ?? body.repository, ""),
    number: Number(body.number),
    title: String(body.title ?? ""),
    state: body.state,
    htmlUrl: body.htmlUrl ?? body.html_url ?? null,
    branch: body.branch ?? null,
    authorLogin: body.authorLogin ?? body.author_login ?? null,
    authorAvatarUrl: body.authorAvatarUrl ?? body.author_avatar_url ?? null,
    mergedAt: body.mergedAt ?? body.merged_at ?? null,
    closedAt: body.closedAt ?? body.closed_at ?? null,
    prCreatedAt: body.prCreatedAt ?? body.pr_created_at ?? null,
    prUpdatedAt: body.prUpdatedAt ?? body.pr_updated_at ?? null,
    mergeableState: body.mergeableState ?? body.mergeable_state ?? null,
    checksConclusion: body.checksConclusion ?? body.checks_conclusion ?? null,
    checksPassed: Number(body.checksPassed ?? body.checks_passed ?? 0),
    checksFailed: Number(body.checksFailed ?? body.checks_failed ?? 0),
    checksPending: Number(body.checksPending ?? body.checks_pending ?? 0),
    additions: Number(body.additions ?? 0),
    deletions: Number(body.deletions ?? 0),
    changedFiles: Number(body.changedFiles ?? body.changed_files ?? 0),
  };
}
