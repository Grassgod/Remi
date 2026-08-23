"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleDashed,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import {
  deriveChangeRequestProgressSegments,
  deriveChangeRequestRepositoryName,
  deriveChangeRequestStatusKind,
  issueChangeRequestsOptions,
  shouldShowChangeRequestStats,
  type ChangeRequestProgressSegment,
  type ChangeRequestStatusKind,
} from "@multiremi/core/scm";
import type {
  ScmChangeRequest,
  ScmChangeRequestChecksConclusion,
  ScmChangeRequestState,
} from "@multiremi/core/types";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";

type IssuesT = ReturnType<typeof useT<"issues">>["t"];

const CHANGE_LIMIT_BEFORE_COLLAPSE = 4;

const STATE_ICON: Record<
  ScmChangeRequestState,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  open: { icon: GitPullRequestArrow, className: "text-success" },
  draft: { icon: GitPullRequestDraft, className: "text-muted-foreground" },
  merged: { icon: GitMerge, className: "text-info" },
  closed: { icon: GitPullRequestClosed, className: "text-destructive" },
  unknown: { icon: GitPullRequest, className: "text-muted-foreground" },
};

const CHECKS_ICON: Record<
  ScmChangeRequestChecksConclusion,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  passed: { icon: CheckCircle2, className: "text-success" },
  failed: { icon: XCircle, className: "text-destructive" },
  pending: { icon: CircleDashed, className: "text-warning" },
};

export function ChangeRequestList({ issueId }: { issueId: string }) {
  const { t } = useT("issues");
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useQuery(issueChangeRequestsOptions(issueId));
  const changeRequests = data?.changeRequests ?? [];

  if (isLoading) {
    return <p className="px-2 text-xs text-muted-foreground">{t(($) => $.detail.change_requests_loading)}</p>;
  }
  if (changeRequests.length === 0) {
    return (
      <p className="px-2 text-xs text-muted-foreground">
        {t(($) => $.detail.change_requests_empty)}
      </p>
    );
  }

  const useCollapse = changeRequests.length >= CHANGE_LIMIT_BEFORE_COLLAPSE;
  const visible = useCollapse
    ? changeRequests.slice(0, CHANGE_LIMIT_BEFORE_COLLAPSE - 1)
    : changeRequests;
  const collapsed = useCollapse
    ? changeRequests.slice(CHANGE_LIMIT_BEFORE_COLLAPSE - 1)
    : [];

  return (
    <div className="space-y-1">
      {visible.map((changeRequest) => (
        <ChangeRequestRow key={changeRequest.id} changeRequest={changeRequest} />
      ))}
      {useCollapse && (
        <div className="space-y-1">
          {expanded && collapsed.map((changeRequest) => (
            <ChangeRequestRow key={changeRequest.id} changeRequest={changeRequest} />
          ))}
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {expanded
              ? t(($) => $.detail.change_request_show_less)
              : t(($) => $.detail.change_request_show_more, { count: collapsed.length })}
          </button>
        </div>
      )}
    </div>
  );
}

function ChangeRequestRow({ changeRequest }: { changeRequest: ScmChangeRequest }) {
  const { t } = useT("issues");
  const displayState = changeRequest.draft ? "draft" : changeRequest.state;
  const config = STATE_ICON[displayState] ?? STATE_ICON.unknown;
  const StateIcon = config.icon;
  const statusKind = deriveChangeRequestStatusKind({
    state: changeRequest.state,
    mergeableState: changeRequest.mergeableState,
    checksFailed: changeRequest.checksFailed,
    checksPending: changeRequest.checksPending,
    checksPassed: changeRequest.checksPassed,
  });
  const segments = deriveChangeRequestProgressSegments({
    state: changeRequest.state,
    checksFailed: changeRequest.checksFailed,
    checksPending: changeRequest.checksPending,
    checksPassed: changeRequest.checksPassed,
  });
  const showStats = shouldShowChangeRequestStats(changeRequest);
  const repositoryName = deriveChangeRequestRepositoryName(changeRequest);
  const row = (
    <>
      <StateIcon className={cn("mt-0.5 size-3.5 shrink-0", config.className)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium leading-snug group-hover:text-foreground">
          {changeRequest.title || t(($) => $.detail.change_request_untitled)}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {repositoryName ? `${repositoryName} · ` : null}
          {getChangeReference(changeRequest, t)} · {getStateLabel(displayState, t)}
          {changeRequest.author ? ` · @${changeRequest.author}` : null}
        </p>
        {(changeRequest.sourceBranch || changeRequest.targetBranch) && (
          <p className="truncate text-[11px] text-muted-foreground">
            {changeRequest.sourceBranch ?? "?"} → {changeRequest.targetBranch ?? "?"}
          </p>
        )}
        <ChangeRequestRowDetails
          changeRequest={changeRequest}
          segments={segments}
          showStats={showStats}
          statusKind={statusKind}
        />
      </div>
    </>
  );

  const className = cn(
    "group -mx-2 flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50",
    displayState === "draft" && "opacity-80",
  );
  return changeRequest.url ? (
    <a
      data-testid="change-request-row"
      href={changeRequest.url}
      target="_blank"
      rel="noreferrer noopener"
      className={className}
    >
      {row}
    </a>
  ) : (
    <div data-testid="change-request-row" className={className}>{row}</div>
  );
}

function ChangeRequestRowDetails({
  changeRequest,
  segments,
  showStats,
  statusKind,
}: {
  changeRequest: ScmChangeRequest;
  segments: ChangeRequestProgressSegment[] | null;
  showStats: boolean;
  statusKind: ChangeRequestStatusKind;
}) {
  const { t } = useT("issues");
  const checksBadge = getChecksBadge(changeRequest, t);
  const conflictsBadge = getConflictsBadge(changeRequest, t);
  const terminal = statusKind === "closed" || statusKind === "merged";
  const statusText = getStatusText(statusKind, t);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
      {showStats && <ChangeRequestStats changeRequest={changeRequest} />}
      <ChangeRequestProgressStrip segments={segments} />
      <span className="truncate">
        {changeRequest.draft || changeRequest.state === "draft"
          ? t(($) => $.detail.change_request_draft_prefix, { status: statusText })
          : statusText}
      </span>
      {!terminal && checksBadge && !statusKind.startsWith("checks_") && (
        <ChangeRequestBadge badge={checksBadge} />
      )}
      {!terminal && conflictsBadge && statusKind !== "conflicts" && statusKind !== "ready" && (
        <ChangeRequestBadge badge={conflictsBadge} />
      )}
    </div>
  );
}

function ChangeRequestStats({ changeRequest }: { changeRequest: ScmChangeRequest }) {
  const { t } = useT("issues");
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span className="text-success">+{changeRequest.additions}</span>
      <span className="text-destructive">−{changeRequest.deletions}</span>
      <span aria-hidden="true">·</span>
      <span>{t(($) => $.detail.change_request_files_count, { count: changeRequest.changedFiles })}</span>
    </span>
  );
}

function ChangeRequestProgressStrip({ segments }: { segments: ChangeRequestProgressSegment[] | null }) {
  if (!segments) return null;
  return (
    <span className="flex h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      {segments.map((segment) => (
        <span
          key={segment.kind}
          className={cn(
            "block h-full",
            segment.kind === "failed" && "bg-destructive",
            segment.kind === "pending" && "bg-warning",
            segment.kind === "passed" && "bg-success",
          )}
          style={{ width: `${segment.ratio * 100}%` }}
        />
      ))}
    </span>
  );
}

interface ChangeRequestBadgeConfig {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  className: string;
}

function ChangeRequestBadge({ badge }: { badge: ChangeRequestBadgeConfig }) {
  const Icon = badge.icon;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className={cn("size-3", badge.className)} />
      {badge.label}
    </span>
  );
}

function getConflictsBadge(changeRequest: ScmChangeRequest, t: IssuesT): ChangeRequestBadgeConfig | null {
  if (changeRequest.mergeableState === "dirty") {
    return {
      icon: TriangleAlert,
      label: t(($) => $.detail.change_request_conflicts_dirty),
      className: "text-destructive",
    };
  }
  if (changeRequest.mergeableState === "clean") {
    return {
      icon: CheckCircle2,
      label: t(($) => $.detail.change_request_conflicts_clean),
      className: "text-success",
    };
  }
  return null;
}

function getChecksBadge(changeRequest: ScmChangeRequest, t: IssuesT): ChangeRequestBadgeConfig | null {
  const checks = changeRequest.checksConclusion;
  if (!checks) return null;
  const config = CHECKS_ICON[checks];
  if (!config) return null;
  return {
    icon: config.icon,
    className: config.className,
    label: checks === "passed"
      ? t(($) => $.detail.change_request_checks_passed)
      : checks === "failed"
        ? t(($) => $.detail.change_request_checks_failed)
        : t(($) => $.detail.change_request_checks_pending),
  };
}

function getChangeReference(changeRequest: ScmChangeRequest, t: IssuesT): string {
  const number = changeRequest.number ?? (changeRequest.externalId || "?");
  if (changeRequest.provider === "github") {
    return t(($) => $.detail.change_request_github_reference, { number });
  }
  if (changeRequest.provider === "codebase") {
    return t(($) => $.detail.change_request_codebase_reference, { number });
  }
  return t(($) => $.detail.change_request_generic_reference, { number });
}

function getStateLabel(state: ScmChangeRequestState, t: IssuesT): string {
  switch (state) {
    case "open":
      return t(($) => $.detail.change_request_state_open);
    case "draft":
      return t(($) => $.detail.change_request_state_draft);
    case "merged":
      return t(($) => $.detail.change_request_state_merged);
    case "closed":
      return t(($) => $.detail.change_request_state_closed);
    case "unknown":
    default:
      return t(($) => $.detail.change_request_state_unknown);
  }
}

function getStatusText(kind: ChangeRequestStatusKind, t: IssuesT): string {
  switch (kind) {
    case "closed":
      return t(($) => $.detail.change_request_status_closed);
    case "merged":
      return t(($) => $.detail.change_request_status_merged);
    case "conflicts":
      return t(($) => $.detail.change_request_status_conflicts);
    case "checks_failed":
      return t(($) => $.detail.change_request_status_checks_failed);
    case "checks_pending":
      return t(($) => $.detail.change_request_status_checks_pending);
    case "checks_passed":
      return t(($) => $.detail.change_request_status_checks_passed);
    case "ready":
      return t(($) => $.detail.change_request_status_ready);
    case "unknown":
    default:
      return t(($) => $.detail.change_request_status_unknown);
  }
}
