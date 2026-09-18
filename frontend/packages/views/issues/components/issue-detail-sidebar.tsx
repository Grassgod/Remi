"use client";
import { WorkLocationPicker } from "../../runtimes/components/runtime-workspace-picker";

import { Bot, CalendarClock, CalendarDays, CheckCircle2, ChevronRight, ListTree, Plus, Tag } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import {
  generatedIssuesOptions,
  issueDetailOptions,
  issueKeys,
} from "@multiremi/core/issues/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@multiremi/ui/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import type {
  Issue,
  IssueSession,
  IssueUsageSummary,
  UpdateIssueRequest,
} from "@multiremi/core/types";
import { formatDateOnly } from "@multiremi/core/issues/date";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { AppLink } from "../../navigation";
import { PropRow } from "../../common/prop-row";
import { ActorAvatar } from "../../common/actor-avatar";
import { formatTokens } from "../../common/format";
import { useT } from "../../i18n";
import {
  StatusIcon,
  PriorityIcon,
  StatusPicker,
  PriorityPicker,
  StartDatePicker,
  DueDatePicker,
  AssigneePicker,
  LabelPicker,
} from ".";
import { OPTIONAL_PROP_KEYS, type OptionalPropsState } from "../hooks/use-optional-props";
import type { SidebarSectionsState } from "../hooks/use-sidebar-sections";
import { IssueKeyResultsSection } from "./issue-key-results-section";
import { ExecutionLogSection } from "./execution-log-section";
import { ChangeRequestList } from "./change-request-list";
import { IssueCodeWorkspaceSection } from "./issue-code-workspace-section";
import { IssueSessionArchivesSection } from "./issue-session-archives-section";
import { IssueSubIssuesSummary } from "./issue-sub-issues-summary";

function shortDate(date: string | null): string {
  if (!date) return "—";
  return formatDateOnly(date, { month: "short", day: "numeric" }, "en-US");
}

interface IssueDetailSidebarProps {
  issue: Issue;
  issueId: string;
  sections: SidebarSectionsState;
  optionalProps: OptionalPropsState;
  onUpdateField: (updates: Partial<UpdateIssueRequest>) => void;
  parentIssue: Issue | null;
  /** Workspace-level toggle for the code changes section. */
  changeSidebarEnabled: boolean;
  getActorName: (type: string, id: string) => string;
  issueSessions: IssueSession[];
  usage: IssueUsageSummary | undefined;
  canManageArchives: boolean;
}

/**
 * Right-hand rail of the issue detail: properties, hierarchy (parent then
 * sub-issues), code workspace, code changes, details, key results, execution
 * log, token usage and the metadata dialog. Fold state is owned by
 * `IssueDetail` (see `useSidebarSections`) so it survives the mobile sheet
 * unmounting.
 */
export function IssueDetailSidebar({
  issue,
  issueId,
  sections,
  optionalProps,
  onUpdateField,
  parentIssue,
  changeSidebarEnabled,
  getActorName,
  issueSessions,
  usage,
  canManageArchives,
}: IssueDetailSidebarProps) {
  const { t } = useT("issues");
  const { t: tRuntime } = useT("runtimes");
  const paths = useWorkspacePaths();
  const propertiesOpen = sections.isOpen("properties");
  const parentIssueOpen = sections.isOpen("parentIssue");
  const codeChangesOpen = sections.isOpen("codeChanges");
  const detailsOpen = sections.isOpen("details");
  const tokenUsageOpen = sections.isOpen("tokenUsage");
  const metadataOpen = sections.isOpen("metadata");
  const { data: tasks = [] } = useQuery({
    queryKey: issueKeys.tasks(issueId),
    queryFn: () => api.listTasksByIssue(issueId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const latestTask = tasks.toSorted(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];
  const hasActiveTask = tasks.some(
    (task) =>
      task.status !== "completed" &&
      task.status !== "failed" &&
      task.status !== "cancelled",
  );
  const canCompleteIssue =
    issue.status === "in_review" &&
    latestTask?.status === "completed" &&
    !hasActiveTask;

  return (
    <div className="space-y-5">
      {/* Properties */}
      <div>
        <button
          type="button"
          className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70 ${propertiesOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => sections.toggle("properties")}
        >
          {t(($) => $.detail.section_properties)}
          <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${propertiesOpen ? "rotate-90" : ""}`} />
        </button>
        {propertiesOpen && <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pl-2">
          {/* Core props — always rendered. */}
          <PropRow label={t(($) => $.detail.prop_status)}>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <StatusPicker status={issue.status} onUpdate={onUpdateField} align="start" />
              {canCompleteIssue && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={() => onUpdateField({ status: "done" })}
                >
                  <CheckCircle2 className="size-3.5" />
                  {t(($) => $.detail.complete_issue_action)}
                </Button>
              )}
            </div>
          </PropRow>
          <PropRow label={t(($) => $.detail.prop_assignee)}>
            <AssigneePicker assigneeType={issue.assignee_type} assigneeId={issue.assignee_id} onUpdate={onUpdateField} align="start" />
          </PropRow>
          <PropRow label={tRuntime($ => $.location.label)} interactive={tasks.length === 0}>
            <WorkLocationPicker wsId={issue.workspace_id} projectId={issue.project_id}
              value={issue.runtime_workspace_id ?? null} onChange={onUpdateField} disabled={tasks.length > 0} />
          </PropRow>
          {/* Optional props — rendered only when set on the issue OR added
              via "+ Add property" in this session. Row order follows the
              order of `OPTIONAL_PROP_KEYS`. */}
          {optionalProps.visible.has("priority") && (
            <PropRow label={t(($) => $.detail.prop_priority)}>
              <PriorityPicker
                priority={issue.priority}
                onUpdate={onUpdateField}
                align="start"
                defaultOpen={optionalProps.autoOpen === "priority"}
              />
            </PropRow>
          )}
          {optionalProps.visible.has("start_date") && (
            <PropRow label={t(($) => $.detail.prop_start_date)}>
              <StartDatePicker
                startDate={issue.start_date}
                onUpdate={onUpdateField}
                defaultOpen={optionalProps.autoOpen === "start_date"}
              />
            </PropRow>
          )}
          {optionalProps.visible.has("due_date") && (
            <PropRow label={t(($) => $.detail.prop_due_date)}>
              <DueDatePicker
                dueDate={issue.due_date}
                onUpdate={onUpdateField}
                defaultOpen={optionalProps.autoOpen === "due_date"}
              />
            </PropRow>
          )}
          {optionalProps.visible.has("labels") && (
            <PropRow label={t(($) => $.detail.prop_labels)}>
              <LabelPicker
                issueId={issue.id}
                align="start"
                defaultOpen={optionalProps.autoOpen === "labels"}
              />
            </PropRow>
          )}

          {/* "+ Add property" — opens a Popover listing optional fields
              not yet displayed. Hidden once every optional field is on
              screen. Sits inside the same grid as a full-row, with its
              own padding so the visual rhythm follows the rows above. */}
          {OPTIONAL_PROP_KEYS.some((k) => !optionalProps.visible.has(k)) && (
            <div className="col-span-2 mt-1">
              <Popover open={optionalProps.popoverOpen} onOpenChange={optionalProps.setPopoverOpen}>
                <PopoverTrigger
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 -mx-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
                >
                  <Plus className="h-3 w-3 shrink-0" />
                  <span>{t(($) => $.detail.add_property_action)}</span>
                </PopoverTrigger>
                {/* Item visuals mirror the inspector rows' typography
                    (text-xs, muted icons) and each option leads with the
                    icon the resulting picker uses, so the dropdown reads
                    as a preview of what will show up below. */}
                <PopoverContent align="start" className="w-44 p-1">
                  {OPTIONAL_PROP_KEYS.filter((k) => !optionalProps.visible.has(k)).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => optionalProps.add(k)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-foreground/90 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      {k === "priority" && (
                        <PriorityIcon priority="medium" inheritColor className="text-muted-foreground" />
                      )}
                      {k === "start_date" && (
                        <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      {k === "due_date" && (
                        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      {k === "labels" && (
                        <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">
                        {k === "priority" && t(($) => $.detail.prop_priority)}
                        {k === "start_date" && t(($) => $.detail.prop_start_date)}
                        {k === "due_date" && t(($) => $.detail.prop_due_date)}
                        {k === "labels" && t(($) => $.detail.prop_labels)}
                      </span>
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>}
      </div>

      {/* Issue hierarchy — parent above children, so the rail reads in the
          same direction as the tree (parent → this issue → sub-issues).
          Both halves stay adjacent; splitting them across unrelated
          sections made the relation hard to scan (MUL-204). Each half
          hides itself when the issue has no parent / no children, so an
          isolated issue spends no rail space on either. */}
      {parentIssue && (
        <div>
          <button
            type="button"
            className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70 ${parentIssueOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => sections.toggle("parentIssue")}
            aria-expanded={parentIssueOpen}
          >
            {t(($) => $.detail.section_parent_issue)}
            <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${parentIssueOpen ? "rotate-90" : ""}`} />
          </button>
          {parentIssueOpen && <div className="pl-2">
            <AppLink
              href={paths.issueDetail(parentIssue.id)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 -mx-2 text-xs hover:bg-accent/50 transition-colors group"
            >
              <StatusIcon status={parentIssue.status} className="h-3.5 w-3.5 shrink-0" />
              <span className="text-muted-foreground shrink-0">{parentIssue.identifier}</span>
              <span className="truncate group-hover:text-foreground">{parentIssue.title}</span>
            </AppLink>
          </div>}
        </div>
      )}

      <IssueSubIssuesSummary issueId={issueId} sections={sections} />

      <IssueCodeWorkspaceSection issueId={issueId} issueKind={issue.issue_kind} />

      <IssueCreationRelationSection issue={issue} />

      {changeSidebarEnabled && (
        <div>
          <button
            type="button"
            className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70 ${codeChangesOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => sections.toggle("codeChanges")}
          >
            {t(($) => $.detail.section_code_changes)}
            <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${codeChangesOpen ? "rotate-90" : ""}`} />
          </button>
          {codeChangesOpen && <div className="pl-2"><ChangeRequestList issueId={issueId} /></div>}
        </div>
      )}

      {/* Details */}
      <div>
        <button
          type="button"
          className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70 ${detailsOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => sections.toggle("details")}
        >
          {t(($) => $.detail.section_details)}
          <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${detailsOpen ? "rotate-90" : ""}`} />
        </button>
        {detailsOpen && <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pl-2">
          <PropRow label={t(($) => $.detail.prop_created_by)}>
            <ActorAvatar actorType={issue.creator_type} actorId={issue.creator_id} size={18} enableHoverCard />
            <span className="cursor-pointer truncate">{getActorName(issue.creator_type, issue.creator_id)}</span>
          </PropRow>
          <PropRow label={t(($) => $.detail.prop_created)}>
            <span className="text-muted-foreground">{shortDate(issue.created_at)}</span>
          </PropRow>
          <PropRow label={t(($) => $.detail.prop_updated)}>
            <span className="text-muted-foreground">{shortDate(issue.updated_at)}</span>
          </PropRow>
        </div>}
      </div>

      {/* Key results — what the sessions published, typed by kind. Hides
          itself until the first result lands. */}
      <IssueKeyResultsSection issueId={issueId} sessions={issueSessions} />

      {/* Execution log — active runs + collapsed past runs. Self-contained;
          owns its own collapse state and WS subscriptions. Hides itself
          when there are no runs to show. */}
      <ExecutionLogSection issueId={issueId} />

      <IssueSessionArchivesSection
        issueId={issue.id}
        issueStatus={issue.status}
        canManage={canManageArchives}
      />

      {/* Token usage */}
      {usage && usage.task_count > 0 && (
        <div>
          <button
            type="button"
            className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70 ${tokenUsageOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => sections.toggle("tokenUsage")}
          >
            {t(($) => $.detail.section_token_usage)}
            <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${tokenUsageOpen ? "rotate-90" : ""}`} />
          </button>
          {tokenUsageOpen && <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pl-2">
            {/* ACP bridges report only a context-used total (no input/output
                split) — show that as 上下文 and hide the misleading 0/0 rows. */}
            {(usage.total_input_tokens > 0 || usage.total_output_tokens > 0 || !(usage.total_tokens ?? 0)) && <>
              <PropRow label={t(($) => $.detail.prop_input)}>
                <span className="text-muted-foreground">{formatTokens(usage.total_input_tokens)}</span>
              </PropRow>
              <PropRow label={t(($) => $.detail.prop_output)}>
                <span className="text-muted-foreground">{formatTokens(usage.total_output_tokens)}</span>
              </PropRow>
            </>}
            {(usage.total_tokens ?? 0) > 0 && (
              <PropRow label={t(($) => $.detail.prop_context)}>
                <span className="text-muted-foreground">{formatTokens(usage.total_tokens ?? 0)}</span>
              </PropRow>
            )}
            {(usage.total_cache_read_tokens > 0 || usage.total_cache_write_tokens > 0) && (
              <PropRow label={t(($) => $.detail.prop_cache)}>
                <span className="text-muted-foreground">
                  {t(($) => $.detail.prop_cache_value, {
                    read: formatTokens(usage.total_cache_read_tokens),
                    write: formatTokens(usage.total_cache_write_tokens),
                  })}
                </span>
              </PropRow>
            )}
            <PropRow label={t(($) => $.detail.prop_runs)}>
              <span className="text-muted-foreground">{usage.task_count}</span>
            </PropRow>
          </div>}
        </div>
      )}

      {/* Metadata — agent-facing free-form KV bag. The values almost
          never mean anything to humans, so the trigger row matches the
          sibling section headers (Pull requests / Details / Parent issue)
          but clicking opens a dialog with the raw JSON instead of expanding
          inline — the payload can be large and pushing the rest of the
          sidebar down was noisy. */}
      {Object.keys(issue.metadata ?? {}).length > 0 && (
        <>
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            onClick={() => sections.setOpen("metadata", true)}
          >
            {t(($) => $.detail.section_metadata)}
            <span className="tabular-nums">
              · {Object.keys(issue.metadata ?? {}).length}
            </span>
          </button>
          <Dialog open={metadataOpen} onOpenChange={(open) => sections.setOpen("metadata", open)}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>{t(($) => $.detail.section_metadata)}</DialogTitle>
              </DialogHeader>
              <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                {JSON.stringify(issue.metadata ?? {}, null, 2)}
              </pre>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

function IssueCreationRelationSection({ issue }: { issue: Issue }) {
  const { t } = useT("issues");
  const wsId = issue.workspace_id;
  const paths = useWorkspacePaths();
  const isIntake = issue.issue_kind === "intake";
  const isTerminal = issue.status === "done" || issue.status === "cancelled";
  const { data: generated } = useQuery({
    ...generatedIssuesOptions(wsId, issue.id),
    enabled: isIntake,
    refetchInterval: isIntake && !isTerminal ? 5_000 : false,
  });
  const { data: source } = useQuery({
    ...issueDetailOptions(wsId, issue.source_issue_id ?? ""),
    enabled: Boolean(issue.source_issue_id),
  });
  if (!isIntake && !issue.source_issue_id) return null;

  const linkedIssues = isIntake ? generated?.issues ?? [] : source ? [source] : [];
  return (
    <div>
      <div className="mb-2 flex items-center gap-1 px-2 py-1 text-xs font-medium">
        {isIntake ? <ListTree className="size-3.5 text-muted-foreground" /> : <Bot className="size-3.5 text-muted-foreground" />}
        {isIntake
          ? t(($) => $.detail.section_generated_issues, { count: linkedIssues.length })
          : t(($) => $.detail.section_source_intake)}
      </div>
      <div className="space-y-1 pl-2">
        {linkedIssues.map((linked) => (
          <AppLink
            key={linked.id}
            href={paths.issueDetail(linked.id)}
            className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50"
          >
            <StatusIcon status={linked.status} className="size-3.5 shrink-0" />
            <span className="shrink-0 text-muted-foreground">{linked.identifier}</span>
            <span className="truncate">{linked.title}</span>
          </AppLink>
        ))}
        {isIntake && linkedIssues.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {t(($) => isTerminal
              ? $.detail.generated_issues_empty_terminal
              : $.detail.generated_issues_empty)}
          </div>
        )}
      </div>
    </div>
  );
}
