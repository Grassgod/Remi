"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { autopilotRunOptions } from "@multiremi/core/autopilots/queries";
import { getAutopilotRunHref } from "@multiremi/core/autopilots";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type { AutopilotRun, AutopilotRunOutcome, InboxItem } from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multiremi/ui/components/ui/collapsible";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  ListTree,
  RefreshCw,
  Search,
} from "lucide-react";
import { AppLink } from "../../navigation";
import { Markdown } from "../../common/markdown";
import { useT } from "../../i18n";
import { InboxDetailLabel, useAutopilotOutcomePresentation, useInboxTitle } from "./inbox-detail-label";
import {
  autopilotDurationParts,
  getAutopilotRunOutcome,
  getAutopilotTriggerObject,
  getAutopilotTriggerObjectLabel,
} from "./inbox-display";

const LARGE_OUTPUT_THRESHOLD = 100_000;

export function autopilotRunOutput(
  run: Pick<AutopilotRun, "result" | "failure_reason">,
): string | null {
  if (typeof run.result === "string" && run.result.trim()) return run.result;
  if (run.result && typeof run.result === "object" && !Array.isArray(run.result)) {
    const result = run.result as Record<string, unknown>;
    if (typeof result.output === "string" && result.output.trim()) return result.output;
    if (typeof result.error === "string" && result.error.trim()) return result.error;
  }
  return run.failure_reason?.trim() || null;
}

export function autopilotOutcomeSupportingText(outcome: AutopilotRunOutcome): string | null {
  if (!outcome.text) return null;
  const references = [outcome.headline, ...outcome.risks]
    .map(comparableOutcomeText)
    .filter(Boolean);
  const remaining = outcome.text
    .split(/(?<=[.!?。！？])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => {
      const key = comparableOutcomeText(sentence);
      return key && !references.some((reference) =>
        key === reference || key.includes(reference) || reference.includes(key)
      );
    });
  return remaining.length > 0 ? remaining.join(" ") : null;
}

function comparableOutcomeText(value: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function isMissingRunError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return /(?:\b404\b|not found|已删除)/iu.test(message);
}

function formatRunTime(value: string, locale: string | undefined): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function RunOutput({
  autopilotId,
  runId,
  open,
}: {
  autopilotId: string;
  runId: string;
  open: boolean;
}) {
  const { t } = useT("inbox");
  const wsId = useWorkspaceId();
  const [mode, setMode] = useState<"markdown" | "plain">("markdown");
  const query = useQuery(autopilotRunOptions(wsId, autopilotId, runId, {
    enabled: open && Boolean(autopilotId && runId),
  }));

  useEffect(() => setMode("markdown"), [runId]);

  if (!open) return null;
  if (!autopilotId || !runId) {
    return <p className="text-sm text-muted-foreground">{t(($) => $.autopilot.report.raw_unavailable)}</p>;
  }
  if (query.isLoading) {
    return (
      <div aria-label={t(($) => $.autopilot.report.raw_loading)} className="space-y-2">
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  if (query.isError) {
    const missing = isMissingRunError(query.error);
    return (
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>
          {missing
            ? t(($) => $.autopilot.report.raw_unavailable)
            : t(($) => $.autopilot.report.raw_failed)}
        </span>
        {!missing && (
          <Button type="button" size="xs" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw />
            {t(($) => $.autopilot.report.raw_retry)}
          </Button>
        )}
      </div>
    );
  }

  const output = query.data ? autopilotRunOutput(query.data) : null;
  if (!output) {
    return <p className="text-sm text-muted-foreground">{t(($) => $.autopilot.report.raw_empty)}</p>;
  }

  const forcedPlain = output.length > LARGE_OUTPUT_THRESHOLD;
  const activeMode = forcedPlain ? "plain" : mode;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t(($) => $.autopilot.report.raw_characters, { count: output.length })}
        </span>
        {!forcedPlain && (
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label={t(($) => $.autopilot.report.raw_mode)}>
            <Button
              type="button"
              size="xs"
              variant={activeMode === "markdown" ? "secondary" : "ghost"}
              aria-pressed={activeMode === "markdown"}
              onClick={() => setMode("markdown")}
              className="h-6 rounded-sm px-2"
            >
              {t(($) => $.autopilot.report.raw_markdown)}
            </Button>
            <Button
              type="button"
              size="xs"
              variant={activeMode === "plain" ? "secondary" : "ghost"}
              aria-pressed={activeMode === "plain"}
              onClick={() => setMode("plain")}
              className="h-6 rounded-sm px-2"
            >
              {t(($) => $.autopilot.report.raw_plain)}
            </Button>
          </div>
        )}
      </div>
      {forcedPlain && (
        <p className="mb-2 text-xs text-muted-foreground">
          {t(($) => $.autopilot.report.raw_large)}
        </p>
      )}
      <div className="max-h-80 overflow-auto border-t pt-3">
        {activeMode === "markdown" ? (
          <Markdown mode="full">{output}</Markdown>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/85">
            {output}
          </pre>
        )}
      </div>
    </div>
  );
}

function actionLabel(
  kind: "none" | "review" | "retry" | "investigate",
  t: ReturnType<typeof useT<"inbox">>["t"],
): string {
  switch (kind) {
    case "review": return t(($) => $.autopilot.action.review);
    case "retry": return t(($) => $.autopilot.action.retry);
    case "investigate": return t(($) => $.autopilot.action.investigate);
    default: return t(($) => $.autopilot.action.none);
  }
}

function durationLabel(seconds: number, t: ReturnType<typeof useT<"inbox">>["t"]): string {
  const duration = autopilotDurationParts(seconds);
  if (duration.unit === "seconds") {
    return t(($) => $.autopilot.duration_seconds, { seconds: duration.seconds });
  }
  if (duration.unit === "minutes") {
    return t(($) => $.autopilot.duration_minutes, { minutes: duration.minutes });
  }
  return t(($) => $.autopilot.duration_hours, {
    hours: duration.hours,
    minutes: duration.minutes,
  });
}

function RunGroup({
  items,
  onSelectItem,
}: {
  items: InboxItem[];
  onSelectItem?: (item: InboxItem) => void;
}) {
  const { t } = useT("inbox");
  const [open, setOpen] = useState(false);
  const inboxTitle = useInboxTitle();
  const outputRuns = items.filter((item) => {
    const outcome = getAutopilotRunOutcome(item);
    return outcome?.kind === "changes" || Boolean(outcome?.links.length);
  }).length;
  const attentionRuns = items.filter((item) => {
    const action = getAutopilotRunOutcome(item)?.action;
    return action != null && action.kind !== "none";
  }).length;

  return (
    <section className="border-b py-4">
      <div className="mb-2 flex items-center gap-2">
        <ListTree className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t(($) => $.autopilot.report.group_title)}</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(($) => $.autopilot.report.group_runs, { count: items.length })}
        {outputRuns > 0 && ` · ${t(($) => $.autopilot.merged_outputs, { count: outputRuns })}`}
        {attentionRuns > 0 && ` · ${t(($) => $.autopilot.merged_attention, { count: attentionRuns })}`}
      </p>
      <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-foreground hover:text-foreground/75">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {open
            ? t(($) => $.autopilot.report.group_collapse)
            : t(($) => $.autopilot.report.group_expand)}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 border-l">
          {items.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelectItem?.(run)}
              className="block w-full px-3 py-2 text-left hover:bg-accent/40"
            >
              <p className="truncate text-xs font-medium">{inboxTitle(run, "detail")}</p>
              <p className="mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
                <InboxDetailLabel item={run} />
              </p>
            </button>
          ))}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function AutopilotRunReport({
  item,
  groupedItems = [item],
  onSelectItem,
}: {
  item: InboxItem;
  groupedItems?: InboxItem[];
  onSelectItem?: (item: InboxItem) => void;
}) {
  const { t, i18n } = useT("inbox");
  const wsPaths = useWorkspacePaths();
  const [rawOpen, setRawOpen] = useState(false);
  const presentation = useAutopilotOutcomePresentation(item);
  const trigger = getAutopilotTriggerObject(item);
  const details = item.details ?? {};
  if (!presentation) return null;

  const { outcome } = presentation;
  const supportingText = autopilotOutcomeSupportingText(outcome);
  const action = outcome.action;
  const ActionIcon = action?.kind === "retry"
    ? RefreshCw
    : action?.kind === "investigate"
      ? Search
      : action?.kind === "review"
        ? GitPullRequest
        : outcome.kind === "failed"
          ? AlertCircle
          : CheckCircle2;
  const issueId = item.issue_id ?? details.issue_id ?? null;
  const sessionId = details.issue_session_id ?? null;
  const primaryRunHref = issueId
    ? getAutopilotRunHref(wsPaths, { issue_id: issueId, issue_session_id: sessionId })
    : null;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const triggerLabel = getAutopilotTriggerObjectLabel(item, {
    locale,
    scheduled: (time) => t(($) => $.autopilot.scheduled, { time }),
    repeatedRuns: (title) => title,
  }) ?? details.trigger ?? t(($) => $.autopilot.report.unknown_trigger);
  const occurredAt = trigger?.occurred_at ?? details.triggered_at ?? item.created_at;
  const isGrouped = groupedItems.length > 1 && groupedItems[0]?.id === item.id;

  return (
    <div data-testid="autopilot-run-report" className="mt-5">
      <section className="flex items-start gap-3 border-y bg-muted/25 px-1 py-4">
        <ActionIcon className="mt-0.5 h-5 w-5 shrink-0 text-foreground/70" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">{t(($) => $.autopilot.report.result)}</p>
          <p className="mt-1 text-sm font-medium leading-6">{presentation.summary}</p>
          {supportingText && (
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{supportingText}</p>
          )}
          {outcome.links.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {outcome.links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline underline-offset-2"
                >
                  {link.kind === "pull_request"
                    ? t(($) => $.autopilot.pull_request, { number: link.number ?? "" })
                    : t(($) => $.autopilot.merge_request, { number: link.number ?? "" })}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ))}
            </div>
          )}
        </div>
        {action && (
          <Badge variant={action.kind === "none" ? "secondary" : action.kind === "review" ? "default" : "destructive"}>
            {actionLabel(action.kind, t)}
          </Badge>
        )}
      </section>

      <section className="border-b py-4">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t(($) => $.autopilot.report.facts)}</h3>
        </div>
        <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t(($) => $.autopilot.report.automation)}</dt>
          <dd>{details.autopilot_title ?? item.title}</dd>
          <dt className="text-muted-foreground">{t(($) => $.autopilot.report.trigger)}</dt>
          <dd className="break-words">{triggerLabel}</dd>
          {trigger?.event_type && (
            <>
              <dt className="text-muted-foreground">{t(($) => $.autopilot.report.event)}</dt>
              <dd className="font-mono text-xs">{trigger.event_type}</dd>
            </>
          )}
          {trigger?.target_branch && (
            <>
              <dt className="text-muted-foreground">{t(($) => $.autopilot.report.branch)}</dt>
              <dd>{trigger.target_branch}</dd>
            </>
          )}
          {trigger?.change_title && (
            <>
              <dt className="text-muted-foreground">{t(($) => $.autopilot.report.change)}</dt>
              <dd className="break-words">{trigger.change_title}</dd>
            </>
          )}
          {trigger?.source_revision && (
            <>
              <dt className="text-muted-foreground">{t(($) => $.autopilot.report.revision)}</dt>
              <dd className="break-all font-mono text-xs">{trigger.source_revision}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t(($) => $.autopilot.report.time)}</dt>
          <dd>{formatRunTime(occurredAt, locale)}</dd>
          {typeof details.duration_seconds === "number" && (
            <>
              <dt className="text-muted-foreground">{t(($) => $.autopilot.report.duration)}</dt>
              <dd>{durationLabel(details.duration_seconds, t)}</dd>
            </>
          )}
        </dl>
      </section>

      {isGrouped && <RunGroup items={groupedItems} onSelectItem={onSelectItem} />}

      {outcome.risks.length > 0 && (
        <section className="border-b py-4">
          <div className="mb-2 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <h3 className="text-sm font-medium">{t(($) => $.autopilot.report.risks)}</h3>
          </div>
          <ul className="space-y-1.5 pl-5 text-sm text-foreground/80">
            {outcome.risks.map((risk) => <li key={risk} className="list-disc leading-6">{risk}</li>)}
          </ul>
        </section>
      )}

      <section className="border-b py-4">
        <div className="mb-2 flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t(($) => $.autopilot.report.links)}</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {issueId && (
            <AppLink href={wsPaths.issueDetail(issueId)} className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
              {t(($) => $.autopilot.report.open_issue)}
              <ExternalLink className="h-3.5 w-3.5" />
            </AppLink>
          )}
          {sessionId && primaryRunHref && (
            <AppLink href={primaryRunHref} className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
              {t(($) => $.autopilot.report.open_session)}
              <ExternalLink className="h-3.5 w-3.5" />
            </AppLink>
          )}
          {details.autopilot_id && (
            <AppLink href={wsPaths.autopilotDetail(details.autopilot_id)} className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
              {t(($) => $.autopilot.report.open_autopilot)}
              <ExternalLink className="h-3.5 w-3.5" />
            </AppLink>
          )}
        </div>
      </section>

      <Collapsible open={rawOpen} onOpenChange={setRawOpen} className="border-b py-4">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left">
          <span className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{t(($) => $.autopilot.report.raw_title)}</span>
          </span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {rawOpen
              ? t(($) => $.autopilot.report.raw_collapse)
              : t(($) => $.autopilot.report.raw_expand)}
            {rawOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <RunOutput
            autopilotId={details.autopilot_id ?? ""}
            runId={details.run_id ?? ""}
            open={rawOpen}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
