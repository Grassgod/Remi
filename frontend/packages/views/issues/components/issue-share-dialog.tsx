"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import { paths } from "@multiremi/core/paths";
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
import { copyText } from "@multiremi/ui/lib/clipboard";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

interface IssueShareDialogProps {
  issueId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IssueShareDialog({ issueId, open, onOpenChange }: IssueShareDialogProps) {
  const { t } = useT("issues");
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const queryKey = ["issue-share", issueId] as const;
  const shareQuery = useQuery({
    queryKey,
    queryFn: () => api.getIssueShare(issueId),
    enabled: open,
    retry: false,
  });
  const setShare = (share: Awaited<ReturnType<typeof api.getIssueShare>>) => {
    queryClient.setQueryData(queryKey, share);
  };
  const createShare = useMutation({
    mutationFn: () => api.createIssueShare(issueId),
    onSuccess: setShare,
    onError: () => toast.error(t(($) => $.share.failed)),
  });
  const extendShare = useMutation({
    mutationFn: () => api.extendIssueShare(issueId),
    onSuccess: setShare,
    onError: () => toast.error(t(($) => $.share.failed)),
  });
  const revokeShare = useMutation({
    mutationFn: () => api.revokeIssueShare(issueId),
    onSuccess: () => {
      setShare(null);
      onOpenChange(false);
    },
    onError: () => toast.error(t(($) => $.share.failed)),
  });

  const share = shareQuery.data ?? null;
  const shareUrl = useMemo(
    () => share ? navigation.getShareableUrl(paths.share(share.token)) : "",
    [navigation, share],
  );
  const copyShareUrl = async () => {
    if (!shareUrl) return;
    if (await copyText(shareUrl)) toast.success(t(($) => $.share.copied));
    else toast.error(t(($) => $.share.copy_failed));
  };
  const expiresAt = share?.expires_at
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(share.expires_at))
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.share.dialog_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.share.dialog_description)}</DialogDescription>
        </DialogHeader>

        {shareQuery.isPending ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            {t(($) => $.share.loading)}
          </div>
        ) : shareQuery.isError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {t(($) => $.share.failed)}
          </div>
        ) : share ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input value={shareUrl} readOnly aria-label={t(($) => $.share.dialog_title)} />
              <Button variant="outline" onClick={() => void copyShareUrl()}>
                <Copy data-icon="inline-start" />
                {t(($) => $.share.copy)}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Check className="size-3.5 text-emerald-600" />
                {t(($) => $.share.scope)}
              </span>
              <span>{t(($) => $.share.expires, { date: expiresAt })}</span>
            </div>
          </div>
        ) : (
          <div className="flex min-h-28 flex-col items-center justify-center gap-3 border-y py-5 text-center">
            <Link2 className="size-5 text-muted-foreground" />
            <p className="max-w-xs text-sm text-muted-foreground">{t(($) => $.share.scope)}</p>
            <Button
              onClick={() => createShare.mutate()}
              disabled={createShare.isPending}
            >
              <Link2 data-icon="inline-start" />
              {createShare.isPending ? t(($) => $.share.creating) : t(($) => $.share.create)}
            </Button>
          </div>
        )}

        {share && (
          <DialogFooter className="justify-between sm:justify-between">
            <Button
              variant="destructive"
              onClick={() => revokeShare.mutate()}
              disabled={revokeShare.isPending}
            >
              <Trash2 data-icon="inline-start" />
              {revokeShare.isPending ? t(($) => $.share.stopping) : t(($) => $.share.stop)}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => extendShare.mutate()}
                disabled={extendShare.isPending}
              >
                <RefreshCw data-icon="inline-start" />
                {extendShare.isPending ? t(($) => $.share.extending) : t(($) => $.share.extend)}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{t(($) => $.share.done)}</Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
