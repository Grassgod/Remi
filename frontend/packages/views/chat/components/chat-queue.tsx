"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useAuthStore } from "@multiremi/core/auth";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { api, ApiError } from "@multiremi/core/api";
import {
  useRemoveChatQueuedTask,
  useUpdateChatQueuedTask,
} from "@multiremi/core/chat/mutations";
import { useT } from "../../i18n";

export function ChatQueue({
  sessionId,
  agentId,
}: {
  sessionId: string;
  agentId: string;
}) {
  const { t } = useT("chat");
  const { t: tm } = useT("messages");
  const wsId = useWorkspaceId();
  const userId = useAuthStore(s => s.user?.id);
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const memberId = userId ? members.find(member => member.user_id === userId)?.id : undefined;
  const query = useInfiniteQuery({
    queryKey: ["chat-unread", wsId, sessionId, agentId],
    queryFn: ({ pageParam }) => api.listMessages(sessionId, { unread_by: agentId, cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor ?? undefined,
    refetchInterval: 10_000, refetchIntervalInBackground: false,
    enabled: !!agentId,
  });
  const tasks = query.data?.pages.flatMap(page => page.messages).filter(message => message.sender_type === "member" && !message.deleted_at) ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<"consumed" | "failed" | null>(null);
  const update = useUpdateChatQueuedTask();
  const remove = useRemoveChatQueuedTask();
  const busy =
    update.isPending ||
    remove.isPending;
  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof ApiError && error.status === 409 ? "consumed" : "failed");
    }
  };
  const editingRemoved = editingId && !tasks.some(task => task.id === editingId);
  if (!tasks.length && !query.isError && !editingId) return null;
  return (
    <section
      aria-label={tm($ => $.queue)}
      className="mx-5 mb-3 max-h-56 shrink-0 overflow-y-auto rounded-lg border bg-card text-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="font-medium">
          {tm($ => $.queue)} ({tasks.length})
        </span>

      </div>
      {tasks.map((task) => (
        <div key={task.id} className="border-b px-3 py-2 last:border-b-0">
          {editingId === task.id ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await update.mutateAsync({
                    sessionId,
                    messageId: task.id,
                    content: draft.trim(),
                  });
                  setEditingId(null);
                });
              }}
            >
              <textarea
                aria-label={t(($) => $.queue.edit)}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="max-h-32 min-h-16 w-full rounded border bg-background p-2"
              />
              <div className="mt-1 flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={() => setEditingId(null)}
                >
                  {t(($) => $.queue.cancel)}
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  disabled={busy || !draft.trim()}
                >
                  {t(($) => $.queue.save)}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words line-clamp-3">
                {task.body_md}
              </p>
              {memberId && task.sender_id === memberId && <div className="flex shrink-0 gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(($) => $.queue.edit)}
                  title={t(($) => $.queue.edit)}
                  disabled={busy}
                  onClick={() => {
                    setEditingId(task.id);
                    setDraft(task.body_md);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(($) => $.queue.remove)}
                  title={t(($) => $.queue.remove)}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      remove.mutateAsync({ sessionId, messageId: task.id }),
                    )
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>}
            </div>
          )}
        </div>
      ))}
      {query.hasNextPage && <Button size="sm" variant="ghost" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{tm($ => $.load_more)}</Button>}
      {editingRemoved && <div className="px-3 py-2">
        <textarea aria-label={t($ => $.queue.edit)} value={draft} onChange={event => setDraft(event.target.value)} className="max-h-32 min-h-16 w-full rounded border bg-background p-2" />
        <p className="text-xs text-muted-foreground">{tm($ => $.consumed_draft)}</p>
        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>{t($ => $.queue.cancel)}</Button>
      </div>}
      {(error || query.isError) && (
        <p role="alert" className="px-3 py-2 text-destructive">
          {error === "consumed" ? tm($ => $.consumed_message) : t(($) => $.queue.failed)}
        </p>
      )}
    </section>
  );
}
