"use client";

import { useState } from "react";
import { ArrowUp, Pencil, Trash2 } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import type { ChatPendingTask } from "@multiremi/core/types";
import {
  useClearChatQueue,
  usePrioritizeChatQueuedTask,
  useRemoveChatQueuedTask,
  useUpdateChatQueuedTask,
} from "@multiremi/core/chat/mutations";
import { useT } from "../../i18n";

export function ChatQueue({
  sessionId,
  tasks,
}: {
  sessionId: string;
  tasks: NonNullable<ChatPendingTask["queued_tasks"]>;
}) {
  const { t } = useT("chat");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);
  const update = useUpdateChatQueuedTask();
  const remove = useRemoveChatQueuedTask();
  const clear = useClearChatQueue();
  const prioritize = usePrioritizeChatQueuedTask();
  const busy =
    update.isPending ||
    remove.isPending ||
    clear.isPending ||
    prioritize.isPending;
  const act = async (action: () => Promise<unknown>) => {
    setError(false);
    try {
      await action();
    } catch {
      setError(true);
    }
  };
  if (!tasks.length) return null;
  return (
    <section
      aria-label={t(($) => $.queue.title)}
      className="mx-5 mb-3 max-h-56 shrink-0 overflow-y-auto rounded-lg border bg-card text-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="font-medium">
          {t(($) => $.queue.title)} ({tasks.length})
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void act(() => clear.mutateAsync(sessionId))}
        >
          {t(($) => $.queue.clear)}
        </Button>
      </div>
      {tasks.map((task) => (
        <div key={task.task_id} className="border-b px-3 py-2 last:border-b-0">
          {editingId === task.task_id ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await update.mutateAsync({
                    sessionId,
                    taskId: task.task_id,
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
                {task.content}
              </p>
              <div className="flex shrink-0 gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(($) => $.queue.edit)}
                  title={t(($) => $.queue.edit)}
                  disabled={busy}
                  onClick={() => {
                    setEditingId(task.task_id);
                    setDraft(task.content);
                  }}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(($) => $.queue.prioritize)}
                  title={t(($) => $.queue.prioritize)}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      prioritize.mutateAsync({
                        sessionId,
                        taskId: task.task_id,
                      }),
                    )
                  }
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(($) => $.queue.remove)}
                  title={t(($) => $.queue.remove)}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      remove.mutateAsync({ sessionId, taskId: task.task_id }),
                    )
                  }
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="px-3 py-2 text-destructive">
          {t(($) => $.queue.failed)}
        </p>
      )}
    </section>
  );
}
