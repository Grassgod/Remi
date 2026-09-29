import { cookies } from "next/headers";
import { SessionLogWindowSchema, type IssueLogBootstrap, type SessionLogWindow } from "@multiremi/core/api/schemas/session-log";
import { readWithSessionCookie } from "../issues/server-log";

export async function readChatLogBootstrap(slug: string, sessionId: string): Promise<IssueLogBootstrap | null> {
  const cookie = (await cookies()).get("multimira_auth")?.value;
  const window = await readWithSessionCookie<SessionLogWindow>({
    cookie, slug, path: `/api/sessions/${encodeURIComponent(sessionId)}/log?before=30`,
    schema: SessionLogWindowSchema,
  });
  return window ? { sessionId, window, head: null } : null;
}
