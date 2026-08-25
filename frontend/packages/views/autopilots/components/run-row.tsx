"use client";

import {
  Ban, CheckCircle2, Clock, Loader2, XCircle,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { autopilotRunOptions } from "@multiremi/core/autopilots/queries";
import { getAutopilotRunHref } from "@multiremi/core/autopilots";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { cn } from "@multiremi/ui/lib/utils";
import type {
  AutopilotRun,
  AutopilotRunSource,
  AutopilotRunTriggerSummary,
} from "@multiremi/core/types";
import type { AgentTask } from "@multiremi/core/types/agent";
import { AppLink } from "../../navigation";
import { TranscriptButton } from "../../common/task-transcript";
import { WebhookPayloadPreview } from "./webhook-payload-preview";
import { useT } from "../../i18n";

export function formatDate(date: string): string {
  return new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type RunStatus = "issue_created" | "running" | "skipped" | "completed" | "failed";

const RUN_VISUAL: Record<RunStatus, { color: string; icon: typeof CheckCircle2; spin?: boolean }> = {
  issue_created: { color: "text-blue-500", icon: Clock },
  running: { color: "text-blue-500", icon: Loader2, spin: true },
  // `skipped` (admission check found the assignee runtime offline,
  // MUL-1899) is muted so it doesn't read as a failure-ratio inflator.
  // The row still shows failure_reason which carries the skip context.
  skipped: { color: "text-muted-foreground", icon: Ban },
  completed: { color: "text-emerald-500", icon: CheckCircle2 },
  failed: { color: "text-destructive", icon: XCircle },
};

// WebhookPayloadSlot lazy-fetches the full run (incl. trigger_payload) once
// the parent dialog actually mounts this slot. The list endpoint omits
// trigger_payload to keep responses small (worst case 256 KiB × N runs),
// so the detail-on-demand fetch lives here.
function WebhookPayloadSlot({ autopilotId, runId }: { autopilotId: string; runId: string }) {
  const wsId = useWorkspaceId();
  const { data, isLoading } = useQuery(
    autopilotRunOptions(wsId, autopilotId, runId),
  );
  if (isLoading) {
    return <Skeleton className="h-9 w-full" />;
  }
  if (!data || data.trigger_payload == null) {
    return null;
  }
  return <WebhookPayloadPreview payload={data.trigger_payload} />;
}

// Human-readable pieces describing an SCM-triggered run: repository, PR/MR
// number + title, target branch, short SHA. Joined with a middot; every
// field is optional so a partial summary still renders something useful.
export function formatTriggerSummaryDetail(
  summary: AutopilotRunTriggerSummary,
): string {
  const pieces: string[] = [];
  if (summary.repository_name) pieces.push(summary.repository_name);
  if (summary.change_number != null) {
    pieces.push(
      summary.change_title
        ? `#${summary.change_number} ${summary.change_title}`
        : `#${summary.change_number}`,
    );
  } else if (summary.change_title) {
    pieces.push(summary.change_title);
  }
  if (summary.target_branch) pieces.push(summary.target_branch);
  if (summary.source_revision) pieces.push(summary.source_revision.slice(0, 7));
  return pieces.join(" · ");
}

export function RunRow({ run, agentId, agentName }: { run: AutopilotRun; agentId: string; agentName: string }) {
  const { t } = useT("autopilots");
  const wsPaths = useWorkspacePaths();
  const status = (RUN_VISUAL[run.status as RunStatus] ? (run.status as RunStatus) : "issue_created");
  const visual = RUN_VISUAL[status];
  const StatusIcon = visual.icon;
  const summary = run.trigger_summary ?? null;

  // Source label priority: explicit wiki build > specific SCM event kind >
  // generic per-source label. Runs from older servers have no
  // trigger_summary and keep the existing generic labels.
  const sourceLabel = (() => {
    if (summary?.wiki_build === true) return t(($) => $.run_source.wiki_build);
    if (run.source === "scm_event") {
      switch (summary?.event_type) {
        case "change.merged":
          return t(($) => $.run_source.change_merged);
        case "default_branch.updated":
          return t(($) => $.run_source.default_branch_updated);
        default:
          return t(($) => $.run_source.scm_event);
      }
    }
    return t(($) => $.run_source[run.source as AutopilotRunSource]) ?? run.source;
  })();

  const summaryDetail = summary ? formatTriggerSummaryDetail(summary) : "";

  // For runs with a task_id (run_only mode), build a minimal AgentTask so
  // TranscriptButton can lazy-load the execution transcript.
  const syntheticTask: AgentTask | null = run.task_id
    ? {
        id: run.task_id,
        agent_id: agentId,
        runtime_id: "",
        issue_id: "",
        status:
          run.status === "running" ? "running" :
          run.status === "completed" ? "completed" :
          run.status === "failed" ? "failed" :
          "queued",
        priority: 0,
        dispatched_at: null,
        started_at: run.triggered_at || null,
        completed_at: run.completed_at || null,
        result: null,
        error: run.failure_reason || null,
        created_at: run.created_at,
      }
    : null;

  const content = (
    <>
      <StatusIcon className={cn("h-4 w-4 shrink-0", visual.color, visual.spin && "animate-spin")} />
      <span className={cn("w-24 shrink-0 text-xs font-medium", visual.color)}>
        {t(($) => $.run_status[status])}
      </span>
      <span className="w-28 shrink-0 text-xs text-muted-foreground truncate" title={sourceLabel}>
        {sourceLabel}
      </span>
      <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
        {run.issue_id ? (
          run.issue_session_id
            ? t(($) => $.run.session_linked)
            : t(($) => $.run.issue_linked)
        ) : run.failure_reason ? (
          // Concise, truncated summary here — the full reason lives in the
          // execution transcript / hover title.
          <span className="text-destructive" title={run.failure_reason}>{run.failure_reason}</span>
        ) : summaryDetail ? (
          <span title={summaryDetail}>{summaryDetail}</span>
        ) : null}
      </span>
      <span className="w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {formatDate(summary?.occurred_at || run.triggered_at || run.created_at)}
      </span>
      {syntheticTask && !run.issue_id && (
        <TranscriptButton
          task={syntheticTask}
          agentName={agentName}
          isLive={run.status === "running"}
          title={t(($) => $.run.view_log)}
          headerSlot={
            run.source === "webhook" ? (
              <WebhookPayloadSlot autopilotId={run.autopilot_id} runId={run.id} />
            ) : undefined
          }
        />
      )}
    </>
  );

  const rowClass = "flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/30 transition-colors";

  if (run.issue_id) {
    const href = getAutopilotRunHref(wsPaths, run)!;
    return (
      <AppLink href={href} className={cn(rowClass, "cursor-pointer")}>
        {content}
      </AppLink>
    );
  }

  return <div className={rowClass}>{content}</div>;
}
