"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { ApiError, IssueStatusHeldErrorSchema } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useModalStore } from "@multiremi/core/modals";
import { childIssuesOptions } from "@multiremi/core/issues/queries";
import { useUpdateIssue } from "@multiremi/core/issues/mutations";
import type { Issue } from "@multiremi/core/types";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import type { SidebarSectionsState } from "../hooks/use-sidebar-sections";
import { ProgressRing } from "./progress-ring";
import { StatusPicker } from "./pickers/status-picker";
import { StatusIcon } from "./status-icon";

function childRank(child: Issue): number {
  if (child.status === "blocked") return 0;
  if (child.status === "backlog" && child.blocked_by?.length) return 1;
  if (child.status === "done" || child.status === "cancelled") return 3;
  return 2;
}

export function IssueSubIssuesSummary({
  issueId,
  sections,
  onCreateSubIssue = () => {},
  getActorName = () => "",
}: {
  issueId: string;
  sections: SidebarSectionsState;
  onCreateSubIssue?: () => void;
  getActorName?: (type: string, id: string) => string;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const open = sections.isOpen("subIssues");
  const { data: childIssues = [], isPending } = useQuery(childIssuesOptions(wsId, issueId));
  const updateIssue = useUpdateIssue();
  const memberId = useAuthStore((state) => state.user?.id);
  const openModal = useModalStore((state) => state.open);
  const doneCount = childIssues.filter((child) => child.status === "done").length;
  const sortedChildren = childIssues.toSorted((a, b) => childRank(a) - childRank(b) || a.position - b.position);

  return (
    <div>
      <button
        type="button"
        className={`mb-2 flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => sections.toggle("subIssues")}
        aria-expanded={open}
      >
        {t(($) => $.detail.section_sub_issues)}
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5">
          <ProgressRing done={doneCount} total={childIssues.length} size={11} />
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
            {doneCount}/{childIssues.length}
          </span>
        </span>
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="pl-2">
          {isPending ? Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="h-[52px] animate-pulse border-b border-border/60 px-2 py-2">
              <div className="h-3 w-4/5 rounded bg-muted" />
              <div className="mt-2 h-2 w-1/3 rounded bg-muted" />
            </div>
          )) : sortedChildren.map((child) => (
            <div key={child.id} className="flex min-h-[52px] min-w-0 items-start gap-1.5 border-b border-border/60 px-1 py-1.5 text-xs">
              <StatusPicker
                status={child.status}
                trigger={<StatusIcon status={child.status} className="size-3.5" />}
                onUpdate={(updates) => updateIssue.mutate({ id: child.id, ...updates }, {
                  onError: (error) => {
                    const held = error instanceof ApiError && error.status === 409
                      ? IssueStatusHeldErrorSchema.safeParse(error.body)
                      : null;
                    if (memberId && updates.status && held?.success) {
                      openModal("issue-force-status", {
                        issueId: child.id,
                        identifier: child.identifier,
                        status: updates.status,
                        reason: held.data.reason,
                        openChildren: held.data.open_children,
                      });
                      return;
                    }
                    toast.error(error.message);
                  },
                })}
                triggerRender={<button type="button" className="mt-0.5 size-5 shrink-0 rounded hover:bg-accent" aria-label={`${child.identifier} ${t(($) => $.detail.prop_status)}`} />}
                align="start"
              />
              <AppLink href={paths.issueDetail(child.id)} className="group min-w-0 flex-1 hover:text-foreground">
                <span className="flex min-w-0 gap-1.5">
                  <span className="shrink-0 text-muted-foreground">{child.identifier}</span>
                  <span className="truncate font-medium">{child.title}</span>
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="truncate">{child.assignee_type && child.assignee_id ? getActorName(child.assignee_type, child.assignee_id) : "—"}</span>
                  {!!child.blocked_by?.length && (
                    <span className="shrink-0 truncate rounded bg-amber-100 px-1 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      {t(($) => $.detail.waiting_chip, { key: child.blocked_by.join(", ") })}
                    </span>
                  )}
                </span>
              </AppLink>
            </div>
          ))}
          <button type="button" onClick={onCreateSubIssue} className="mt-2 inline-flex h-7 items-center gap-1 px-1 text-xs text-muted-foreground hover:text-foreground">
            <Plus className="size-3.5" />{t(($) => $.detail.add_sub_issues)}
          </button>
        </div>
      )}
    </div>
  );
}
