"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { childIssuesOptions } from "@multiremi/core/issues/queries";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import type { SidebarSectionsState } from "../hooks/use-sidebar-sections";
import { ProgressRing } from "./progress-ring";
import { StatusIcon } from "./status-icon";

export function IssueSubIssuesSummary({
  issueId,
  sections,
}: {
  issueId: string;
  sections: SidebarSectionsState;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const open = sections.isOpen("subIssues");
  const { data: childIssues = [] } = useQuery(childIssuesOptions(wsId, issueId));

  if (childIssues.length === 0) return null;

  const doneCount = childIssues.filter((child) => child.status === "done").length;

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
        <div className="space-y-1 pl-2">
          {childIssues.map((child) => (
            <AppLink
              key={child.id}
              href={paths.issueDetail(child.id)}
              className="group -mx-2 flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/50"
            >
              <StatusIcon status={child.status} className="h-3.5 w-3.5 shrink-0" />
              <span className="shrink-0 text-muted-foreground">{child.identifier}</span>
              <span className="truncate group-hover:text-foreground">{child.title}</span>
            </AppLink>
          ))}
        </div>
      )}
    </div>
  );
}
