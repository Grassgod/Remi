import { ChatPage } from "@multiremi/views/chat";
import { readChatLogBootstrap } from "../../../../features/chat/server-log";

export default async function ChatRoute({ params, searchParams }: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { workspaceSlug } = await params;
  const query = await searchParams;
  const sessionId = typeof query.session === "string" ? query.session : undefined;
  const initialLog = sessionId ? await readChatLogBootstrap(workspaceSlug, sessionId) : null;
  return <ChatPage initialSessionId={sessionId} initialLog={initialLog ?? undefined} />;
}
