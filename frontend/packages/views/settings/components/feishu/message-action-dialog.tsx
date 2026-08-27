"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  useDraftFeishuMessageReply,
  useNotifyFeishuMessage,
  useProposeFeishuMessageIssue,
  useResolveFeishuMessage,
  type FeishuMessage,
} from "@multiremi/core/feishu";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { useT } from "../../../i18n";

/**
 * Every action a human can take on an ingested message. `ignore` and `process`
 * both hit `resolve` — the API accepts only `ignored` / `dismissed` there and
 * requires a reason for either, which is why both ask for free text rather than
 * firing on a single click.
 *
 * Notably absent: sending a reply to Feishu. `draft` writes an Inbox draft and
 * stops; the outbound path stays human-operated and outside this feature.
 */
export type MessageActionKind = "ignore" | "process" | "notify" | "draft" | "propose";

interface MessageActionDialogProps {
  action: MessageActionKind | null;
  message: FeishuMessage | null;
  workspaceId: string;
  onClose: () => void;
}

export function MessageActionDialog({ action, message, workspaceId, onClose }: MessageActionDialogProps) {
  const { t } = useT("settings");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const resolve = useResolveFeishuMessage(workspaceId);
  const notify = useNotifyFeishuMessage(workspaceId);
  const draft = useDraftFeishuMessageReply(workspaceId);
  const propose = useProposeFeishuMessageIssue(workspaceId);
  const pending = resolve.isPending || notify.isPending || draft.isPending || propose.isPending;

  useEffect(() => {
    if (action === null) return;
    setError(null);
    setText("");
    // Seed the Issue title from the message so the common case is one click
    // plus a glance, not retyping what is already on screen.
    setTitle(action === "propose" ? (message?.searchableText ?? "").slice(0, 80) : "");
  }, [action, message?.messageId, message?.searchableText]);

  if (action === null || message === null) return null;

  const messageId = message.messageId;
  const needsTitle = action === "propose";
  const textRequired = action !== "propose";
  const onError = (cause: unknown) => {
    setError(cause instanceof Error ? cause.message : t(($) => $.feishu.messages.action_failed));
  };
  const onSuccess = () => {
    toast.success(t(($) => $.feishu.messages.action_done));
    onClose();
  };

  const handleSubmit = () => {
    setError(null);
    const value = text.trim();
    if (textRequired && value === "") {
      setError(t(($) => $.feishu.messages.reason_required));
      return;
    }
    switch (action) {
      case "ignore":
        resolve.mutate({ messageId, outcome: "ignored", reason: value }, { onSuccess, onError });
        return;
      case "process":
        resolve.mutate({ messageId, outcome: "dismissed", reason: value }, { onSuccess, onError });
        return;
      case "notify":
        notify.mutate({ messageId, summary: value }, { onSuccess, onError });
        return;
      case "draft":
        draft.mutate({ messageId, draftText: value }, { onSuccess, onError });
        return;
      case "propose": {
        const trimmedTitle = title.trim();
        if (trimmedTitle === "") {
          setError(t(($) => $.feishu.messages.title_required));
          return;
        }
        propose.mutate(
          { messageId, input: { title: trimmedTitle, description: value === "" ? null : value } },
          { onSuccess, onError },
        );
        return;
      }
      default:
        return;
    }
  };

  const copy = {
    ignore: {
      title: t(($) => $.feishu.messages.dialog.ignore_title),
      description: t(($) => $.feishu.messages.dialog.ignore_description),
      label: t(($) => $.feishu.messages.dialog.reason_label),
    },
    process: {
      title: t(($) => $.feishu.messages.dialog.process_title),
      description: t(($) => $.feishu.messages.dialog.process_description),
      label: t(($) => $.feishu.messages.dialog.reason_label),
    },
    notify: {
      title: t(($) => $.feishu.messages.dialog.notify_title),
      description: t(($) => $.feishu.messages.dialog.notify_description),
      label: t(($) => $.feishu.messages.dialog.summary_label),
    },
    draft: {
      title: t(($) => $.feishu.messages.dialog.draft_title),
      description: t(($) => $.feishu.messages.dialog.draft_description),
      label: t(($) => $.feishu.messages.dialog.draft_label),
    },
    propose: {
      title: t(($) => $.feishu.messages.dialog.propose_title),
      description: t(($) => $.feishu.messages.dialog.propose_description),
      label: t(($) => $.feishu.messages.dialog.description_label),
    },
  }[action];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        {error !== null && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <blockquote className="max-h-24 overflow-y-auto rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {message.searchableText || t(($) => $.feishu.messages.no_text)}
        </blockquote>

        <div className="space-y-4">
          {needsTitle && (
            <div className="space-y-1.5">
              <Label htmlFor="feishu-action-title">{t(($) => $.feishu.messages.dialog.title_label)}</Label>
              <Input
                id="feishu-action-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="feishu-action-text">{copy.label}</Label>
            <Textarea
              id="feishu-action-text"
              rows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t(($) => $.feishu.sources.dialog.cancel)}
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending
              ? t(($) => $.feishu.messages.dialog.submitting)
              : t(($) => $.feishu.messages.dialog.submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
