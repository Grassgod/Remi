import { cache } from "react";
import { cookies, headers } from "next/headers";
import { navigationRequestKind } from "../../lib/navigation-request";
import { z, type ZodType } from "zod";
import { resolveRemoteApiUrl } from "../../config/runtime-urls";
import { SessionLogLocationSchema, SessionLogWindowSchema, type IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import { ChildIssuesResponseSchema, IssueDetailSchema } from "@multiremi/core/api/schemas/issues";
import { IssueSessionListSchema } from "@multiremi/core/api/schemas/comments";
import { UserSchema } from "@multiremi/core/api/schemas/users";
import type { Issue, IssueSession, MemberWithUser, User, Workspace } from "@multiremi/core/types";
import type { AgentTask } from "@multiremi/core/types/agent";

export const SSR_LOG_TIMEOUT_MS = 800;

export type IssueSsrSeedStatus = "ok" | "soft-nav" | "no-cookie" | "timeout" | "upstream-error" | "not-found" | "invalid";
type ReadFailure = Exclude<IssueSsrSeedStatus, "ok" | "soft-nav">;
export interface IssuePageBootstrap {
  issue: Issue; parentIssue: Issue | null; sessions: IssueSession[];
  members: MemberWithUser[]; children: Issue[]; tasks: AgentTask[]; log: IssueLogBootstrap;
}
export type IssueSsrSeedResult = { status: "ok"; initial: IssuePageBootstrap }
  | { status: Exclude<IssueSsrSeedStatus, "ok">; initial: null };

async function isSoftNavigation(): Promise<boolean> {
  return navigationRequestKind(await headers()) === "soft-nav";
}

/** Request-local GET reader. Credentials and upstream error bodies never escape it. */
export async function readWithSessionCookie<T>(input: {
  cookie: string | undefined; slug: string; path: string; schema: ZodType;
  signal?: AbortSignal; fetcher?: typeof fetch; apiUrl?: string;
  onNotFound?: () => void;
  onFailure?: (reason: ReadFailure) => void;
}): Promise<T | null> {
  if (!input.cookie) return null;
  const signal = input.signal ?? AbortSignal.timeout(SSR_LOG_TIMEOUT_MS);
  try {
    const response = await (input.fetcher ?? fetch)(`${input.apiUrl ?? resolveRemoteApiUrl(process.env)}${input.path}`, {
      headers: { Cookie: `multimira_auth=${encodeURIComponent(input.cookie)}`, "X-Workspace-Slug": input.slug },
      signal, cache: "no-store", redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 404) input.onNotFound?.();
      input.onFailure?.(response.status === 404 ? "not-found" : "upstream-error");
      return null;
    }
    let body: unknown;
    try { body = await response.json(); } catch (error) {
      input.onFailure?.(signal.aborted ? "timeout" : error instanceof SyntaxError ? "invalid" : "upstream-error");
      return null;
    }
    const parsed = input.schema.safeParse(body);
    if (!parsed.success) input.onFailure?.("invalid");
    return parsed.success ? parsed.data as T : null;
  } catch {
    input.onFailure?.(signal.aborted ? "timeout" : "upstream-error");
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
  if (await isSoftNavigation()) return null;
  const cookie = (await cookies()).get("multimira_auth")?.value;
  const signal = AbortSignal.timeout(SSR_LOG_TIMEOUT_MS);
  const [user, workspaces] = await Promise.all([
    readWithSessionCookie<User>({ cookie, slug, signal, path: "/api/me", schema: UserSchema }),
    readWithSessionCookie<Workspace[]>({ cookie, slug, signal, path: "/api/workspaces", schema: WorkspaceListSchema }),
  ]);
  return user && workspaces?.some(w => w.slug === slug) ? { user, workspaces } : null;
});

export async function readIssuePageBootstrap(slug: string, issueId: string, selectedSessionId?: string, commentId?: string): Promise<IssueSsrSeedResult> {
  if (await isSoftNavigation()) return { status: "soft-nav", initial: null };
  return readIssueLogBootstrapResult(slug, issueId, selectedSessionId, commentId);
}

export async function readIssueLogBootstrap(slug: string, issueId: string, selectedSessionId?: string, commentId?: string): Promise<IssuePageBootstrap | null> {
  return (await readIssueLogBootstrapResult(slug, issueId, selectedSessionId, commentId)).initial;
}

export async function readIssueLogBootstrapResult(slug: string, issueId: string, selectedSessionId?: string, commentId?: string): Promise<IssueSsrSeedResult> {
  const cookie = (await cookies()).get("multimira_auth")?.value;
  if (!cookie) return { status: "no-cookie", initial: null };
  const signal = AbortSignal.timeout(SSR_LOG_TIMEOUT_MS);
  let failure: ReadFailure | undefined;
  const onFailure = (reason: ReadFailure) => { failure ??= reason; };
  const failed = (): IssueSsrSeedResult => ({ status: signal.aborted ? "timeout" : failure ?? "invalid", initial: null });
  const read = <T,>(input: { path: string; schema: ZodType }) => readWithSessionCookie<T>({ cookie, slug, signal, onFailure, ...input });
  const prefix = `/api/issues/${encodeURIComponent(issueId)}`;
  const [issue, sessions] = await Promise.all([
    read<Issue>({ path: prefix, schema: IssueDetailSchema }),
    read<IssueSession[]>({ path: `${prefix}/sessions`, schema: IssueSessionListSchema }),
  ]);
  let session = selectedSessionId ? sessions?.find(s => s.id === selectedSessionId) : sessions?.find(s => s.is_default) ?? sessions?.[0];
  if (!issue || !sessions || !session) return failed();
  let targetSeq: number | undefined;
  if (commentId) {
    const candidates = selectedSessionId ? [session] : sessions;
    const located = await Promise.all(candidates.map(async candidate => {
      let missing = false;
      const location = await readWithSessionCookie<{ id: string; seq: number; head_seq: number }>({ cookie, slug, signal,
        path: `/api/sessions/${encodeURIComponent(candidate.id)}/log/locate?id=${encodeURIComponent(commentId)}`,
        schema: SessionLogLocationSchema, onNotFound: () => { missing = true; },
        onFailure: reason => { if (reason !== "not-found") onFailure(reason); } });
      return { candidate, location, missing };
    }));
    const found = located.find(result => result.location?.id === commentId);
    if (found) {
      session = found.candidate;
      targetSeq = found.location!.seq;
    } else if (!located.every(result => result.missing)) return failed();
  }
  const logPath = `/api/sessions/${encodeURIComponent(session.id)}/log`;
  const [window, headWindow, parentIssue, members, children, tasks] = await Promise.all([
    read<IssueLogBootstrap["window"]>({
      path: (targetSeq === undefined ? `${logPath}?before=30` : `${logPath}?anchor=${targetSeq}&before=15&after=15`)
        + (session.is_default ? "&with_activity=1" : ""),
      schema: SessionLogWindowSchema }),
    read<IssueLogBootstrap["window"]>({ path: `${logPath}?anchor=0&before=1`, schema: SessionLogWindowSchema }),
    issue.parent_issue_id ? read<Issue>({ path: `/api/issues/${encodeURIComponent(issue.parent_issue_id)}`, schema: IssueDetailSchema }) : null,
    read<MemberWithUser[]>({ path: `/api/workspaces/${encodeURIComponent(issue.workspace_id)}/members`, schema: MemberListSchema }),
    read<{ issues: Issue[] }>({ path: `${prefix}/children`, schema: ChildIssuesResponseSchema }),
    read<AgentTask[]>({ path: `${prefix}/task-runs`, schema: z.array(z.object({ id: z.string(), issue_id: z.string(), status: z.string() }).loose()) }),
  ]);
  return window && headWindow && members && children && tasks && (!issue.parent_issue_id || parentIssue)
    ? { status: "ok", initial: { issue, parentIssue, sessions, members, children: children.issues, tasks,
        log: { sessionId: session.id, window, head: headWindow.entries.find(e => e.seq === 0) ?? null,
          targetCommentId: targetSeq === undefined ? undefined : commentId,
          missingCommentId: targetSeq === undefined ? commentId : undefined } } }
    : failed();
}
