"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Settings2 } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import {
  feishuInboxActions,
  feishuInboxContext,
  useApproveFeishuProposal,
  useRejectFeishuProposal,
  useResolveFeishuMessage,
  type FeishuInboxContext,
  type FeishuMessageOutcome,
} from "@multiremi/core/feishu";
import type { InboxItem } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Label } from "@multiremi/ui/components/ui/label";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

/** `resolve` accepts only these two outcomes and requires a reason for both,
 *  so neither can be a single-click action. */
type ResolveKind = "ignore" | "process";

function createdIssueRef(outcomes: FeishuMessageOutcome[] | undefined): string | null {
  const created = (outcomes ?? []).find((outcome) => outcome.outcomeKind === "issue_created");
  return created?.ref !== null && created?.ref !== undefined && created.ref !== "" ? created.ref : null;
}

/**
 * The decision surface for an ingested Feishu message, rendered inside the
 * inbox detail pane. Settings owns configuration; this owns what a human does
 * about a single message, which is why approve/reject live here and not there.
 *
 * Sending a reply to Feishu is deliberately not offered: a draft stays a draft.
 */
export function FeishuInboxActions({ item, onArchive }: { item: InboxItem; onArchive: () => void }) {
  const { t } = useT("inbox");
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const { push } = useNavigation();
  const [resolving, setResolving] = useState<ResolveKind | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const approve = useApproveFeishuProposal(wsId);
  const reject = useRejectFeishuProposal(wsId);
  const resolve = useResolveFeishuMessage(wsId);
  const pending = approve.isPending || reject.isPending || resolve.isPending;

  const context = feishuInboxContext(item);
  if (context === null) return null;
  const actions = feishuInboxActions(context);

  const onError = (cause: unknown) => {
    setError(cause instanceof Error && cause.message ? cause.message : t(($) => $.feishu.action_failed));
  };

  const handleApprove = () => {
    if (context.proposalId === null) return;
    setError(null);
    approve.mutate(context.proposalId, {
      onSuccess: (result) => {
        const ref = createdIssueRef(result.outcomes);
        toast.success(
          ref === null
            ? t(($) => $.feishu.approved)
            : t(($) => $.feishu.approved_with_issue, { identifier: ref }),
        );
        // Land the user on the thing they just created rather than on a row
        // that is about to disappear from under them.
        if (ref !== null) push(wsPaths.issueDetail(ref));
        else onArchive();
      },
      onError,
    });
  };

  const handleReject = () => {
    if (context.proposalId === null) return;
    setError(null);
    reject.mutate(context.proposalId, {
      onSuccess: () => {
        toast.success(t(($) => $.feishu.rejected));
        onArchive();
      },
      onError,
    });
  };

  const handleResolve = () => {
    if (context.messageId === null || resolving === null) return;
    const value = reason.trim();
    if (value === "") {
      setError(t(($) => $.feishu.reason_required));
      return;
    }
    setError(null);
    resolve.mutate(
      {
        messageId: context.messageId,
        outcome: resolving === "ignore" ? "ignored" : "dismissed",
        reason: value,
      },
      {
        onSuccess: () => {
          toast.success(t(($) => $.feishu.resolved));
          setResolving(null);
          setReason("");
          onArchive();
        },
        onError,
      },
    );
  };

  const startResolve = (kind: ResolveKind) => {
    setResolving(kind);
    setReason("");
    setError(null);
  };

  return (
    <div className="mt-4 space-y-4">
      <FeishuInboxDetail context={context} />

      {error !== null && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {resolving !== null ? (
        <div className="space-y-2 rounded-md border p-3">
          <Label htmlFor="feishu-inbox-reason">
            {resolving === "ignore"
              ? t(($) => $.feishu.ignore_reason_label)
              : t(($) => $.feishu.process_reason_label)}
          </Label>
          <Textarea
            id="feishu-inbox-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleResolve} disabled={pending}>
              {t(($) => $.feishu.confirm)}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setResolving(null)} disabled={pending}>
              {t(($) => $.feishu.cancel)}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.canApprove && (
            <Button size="sm" onClick={handleApprove} disabled={pending}>
              {t(($) => $.feishu.approve)}
            </Button>
          )}
          {actions.canReject && (
            <Button size="sm" variant="outline" onClick={handleReject} disabled={pending}>
              {t(($) => $.feishu.reject)}
            </Button>
          )}
          {actions.canIgnore && (
            <Button size="sm" variant="outline" onClick={() => startResolve("ignore")} disabled={pending}>
              {t(($) => $.feishu.ignore)}
            </Button>
          )}
          {actions.canMarkProcessed && (
            <Button size="sm" variant="outline" onClick={() => startResolve("process")} disabled={pending}>
              {t(($) => $.feishu.mark_processed)}
            </Button>
          )}
          {context.appLink !== null && (
            <Button
              size="sm"
              variant="outline"
              render={<a href={context.appLink} target="_blank" rel="noreferrer noopener" />}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              {t(($) => $.feishu.open_in_feishu)}
            </Button>
          )}
          {context.kind === "feishu_ingest_connection_alert" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => push(`${wsPaths.settings()}?tab=feishu-messages`)}
            >
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              {t(($) => $.feishu.open_settings)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FeishuInboxDetail({ context }: { context: FeishuInboxContext }) {
  const { t } = useT("inbox");

  if (context.kind === "feishu_issue_proposal" && context.proposedTitle !== null) {
    return (
      <div className="rounded-md border bg-muted/40 p-3">
        <p className="text-xs font-medium text-muted-foreground">
          {t(($) => $.feishu.proposed_issue_title)}
        </p>
        <p className="mt-1 text-sm">{context.proposedTitle}</p>
      </div>
    );
  }

  if (context.kind === "feishu_reply_draft") {
    // Restating this at the point of action, not only in Settings: the whole
    // risk of a draft feature is someone assuming it already went out.
    return (
      <p className="text-xs text-muted-foreground">{t(($) => $.feishu.draft_not_sent)}</p>
    );
  }

  if (context.kind === "feishu_ingest_connection_alert" && context.errorCode !== null) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(($) => $.feishu.alert_error_code, { code: context.errorCode })}
      </p>
    );
  }

  return null;
}
