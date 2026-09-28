"use client";

import { useState } from "react";
import { useUpdateIssue } from "@multiremi/core/issues/mutations";
import { useAuthStore } from "@multiremi/core/auth";
import type { IssueStatus } from "@multiremi/core/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multiremi/ui/components/ui/alert-dialog";
import { useT } from "../i18n";

export function ForceIssueStatusModal({ onClose, data }: { onClose: () => void; data: Record<string, unknown> | null }) {
  const { t } = useT("issues");
  const member = useAuthStore((state) => state.user);
  const updateIssue = useUpdateIssue();
  const [error, setError] = useState("");
  const issueId = typeof data?.issueId === "string" ? data.issueId : "";
  const identifier = typeof data?.identifier === "string" ? data.identifier : "";
  const status = data?.status as IssueStatus | undefined;
  const openChildren = typeof data?.openChildren === "number" ? data.openChildren : 0;
  const finalSummaryMissing = data?.reason === "final_summary_missing";
  const confirm = async () => {
    if (!member || !issueId || !status) return;
    setError("");
    try {
      await updateIssue.mutateAsync({ id: issueId, status, force: true });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(($) => $.detail.update_failed));
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-w-[390px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => status === "done" ? $.detail.force_done_title : $.detail.force_review_title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.detail.force_status_body, { key: identifier, count: openChildren })}
            {finalSummaryMissing && ` ${t(($) => $.detail.force_summary_missing)}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={updateIssue.isPending}>{t(($) => $.detail.force_cancel)}</AlertDialogCancel>
          {member && <AlertDialogAction variant="destructive" disabled={updateIssue.isPending} onClick={(event) => { event.preventDefault(); void confirm(); }}>
            {updateIssue.isPending ? t(($) => $.detail.force_pending) : t(($) => status === "done" ? $.detail.force_done_action : $.detail.force_review_action)}
          </AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
