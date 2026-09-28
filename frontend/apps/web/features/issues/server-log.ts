import { cache } from "react";
import { cookies } from "next/headers";
import { z, type ZodType } from "zod";
import { resolveRemoteApiUrl } from "../../config/runtime-urls";
import { SessionLogWindowSchema, type IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import { ChildIssuesResponseSchema, IssueDetailSchema } from "@multiremi/core/api/schemas/issues";
import { IssueSessionListSchema } from "@multiremi/core/api/schemas/comments";
import { UserSchema } from "@multiremi/core/api/schemas/users";
import type { Issue, IssueSession, MemberWithUser, User, Workspace } from "@multiremi/core/types";

export const SSR_LOG_TIMEOUT_MS = 800;

/** Request-local GET reader. Credentials and upstream error bodies never escape it. */
export async function readWithSessionCookie<T>(input: {
  cookie: string | undefined; slug: string; path: string; schema: ZodType;
  signal?: AbortSignal; fetcher?: typeof fetch; apiUrl?: string;
}): Promise<T | null> {
  if (!input.cookie) return null;
  try {
    const response = await (input.fetcher ?? fetch)(`${input.apiUrl ?? resolveRemoteApiUrl(process.env)}${input.path}`, {
      headers: { Cookie: `multimira_auth=${encodeURIComponent(input.cookie)}`, "X-Workspace-Slug": input.slug },
      signal: input.signal ?? AbortSignal.timeout(SSR_LOG_TIMEOUT_MS), cache: "no-store", redirect: "error",
    });
    if (!response.ok) return null;
    const parsed = input.schema.safeParse(await response.json());
    return parsed.success ? parsed.data as T : null;
  } catch {
    return null;
  }
}

const WorkspaceListSchema = z.array(z.object({
  id: z.string(), slug: z.string(), name: z.string(), description: z.string().nullable(),
  context: z.string().nullable().optional(), settings: z.record(z.string(), z.unknown()).default({}),
  repos: z.array(z.unknown()).default([]), created_at: z.string(), updated_at: z.string(),
}).loose());
const MemberListSchema = z.array(z.object({
  id: z.string(), workspace_id: z.string(), user_id: z.string(),
  role: z.enum(["owner", "admin", "member"]), created_at: z.string(),
  name: z.string(), email: z.string().optional(), avatar_url: z.string().nullable(),
}).strip());

export const readSSRWorkspace = cache(async (slug: string): Promise<{ user: User; workspaces: Workspace[] } | null> => {
  const cookie = (await cookies()).get("multimira_auth")?.value;
  const signal = AbortSignal.timeout(SSR_LOG_TIMEOUT_MS);
  const [user, workspaces] = await Promise.all([
    readWithSessionCookie<User>({ cookie, slug, signal, path: "/api/me", schema: UserSchema }),
    readWithSessionCookie<Workspace[]>({ cookie, slug, signal, path: "/api/workspaces", schema: WorkspaceListSchema }),
  ]);
  return user && workspaces?.some(w => w.slug === slug) ? { user, workspaces } : null;
});

export async function readIssueLogBootstrap(slug: string, issueId: string, selectedSessionId?: string): Promise<{
  issue: Issue; parentIssue: Issue | null; sessions: IssueSession[];
  members: MemberWithUser[]; children: Issue[]; log: IssueLogBootstrap;
} | null> {
  const cookie = (await cookies()).get("multimira_auth")?.value;
  if (!cookie) return null;
  const signal = AbortSignal.timeout(SSR_LOG_TIMEOUT_MS);
  const prefix = `/api/issues/${encodeURIComponent(issueId)}`;
  const [issue, sessions] = await Promise.all([
    readWithSessionCookie<Issue>({ cookie, slug, signal, path: prefix, schema: IssueDetailSchema }),
    readWithSessionCookie<IssueSession[]>({ cookie, slug, signal, path: `${prefix}/sessions`, schema: IssueSessionListSchema }),
  ]);
  const session = selectedSessionId ? sessions?.find(s => s.id === selectedSessionId) : sessions?.find(s => s.is_default) ?? sessions?.[0];
  if (!issue || !sessions || !session) return null;
  const logPath = `/api/sessions/${encodeURIComponent(session.id)}/log`;
  const [window, headWindow, parentIssue, members, children] = await Promise.all([
    readWithSessionCookie<IssueLogBootstrap["window"]>({ cookie, slug, signal, path: `${logPath}?before=30`, schema: SessionLogWindowSchema }),
    readWithSessionCookie<IssueLogBootstrap["window"]>({ cookie, slug, signal, path: `${logPath}?anchor=0&before=1`, schema: SessionLogWindowSchema }),
    issue.parent_issue_id ? readWithSessionCookie<Issue>({ cookie, slug, signal, path: `/api/issues/${encodeURIComponent(issue.parent_issue_id)}`, schema: IssueDetailSchema }) : null,
    readWithSessionCookie<MemberWithUser[]>({ cookie, slug, signal, path: `/api/workspaces/${encodeURIComponent(issue.workspace_id)}/members`, schema: MemberListSchema }),
    readWithSessionCookie<{ issues: Issue[] }>({ cookie, slug, signal, path: `${prefix}/children`, schema: ChildIssuesResponseSchema }),
  ]);
  return window && headWindow && members && children
    ? { issue, parentIssue, sessions, members, children: children.issues,
        log: { sessionId: session.id, window, head: headWindow.entries.find(e => e.seq === 0) ?? null } }
    : null;
}
