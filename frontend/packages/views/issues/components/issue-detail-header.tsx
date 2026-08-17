"use client";

import { useState } from "react";
import {
  Archive,
  CircleCheck,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
  Share2,
} from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multiremi/ui/components/ui/tooltip";
import { cn } from "@multiremi/ui/lib/utils";
import type { Issue, Project, UpdateIssueRequest } from "@multiremi/core/types";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { AppLink } from "../../navigation";
import { BreadcrumbHeader, type BreadcrumbSegment } from "../../layout/breadcrumb-header";
import { useT } from "../../i18n";
import { ProjectIcon } from "../../projects/components/project-icon";
import { IssueActionsDropdown } from "../actions";
import { IssueShareDialog } from "./issue-share-dialog";

interface IssueDetailHeaderProps {
  issue: Issue;
  parentIssue: Issue | null;
  breadcrumbProject: Project | null;
  onUpdateField: (updates: Partial<UpdateIssueRequest>) => void;
  /** Present when the shell wants to close/advance the surface itself. */
  onDone?: () => void;
  /**
   * When the caller handles deletion, the actions modal must not navigate —
   * the detail observes its own cache clearing instead.
   */
  onDeletedNavigateTo?: string;
  isPinned: boolean;
  onTogglePin: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  sessionSidebarOpen: boolean;
  onToggleSessionSidebar: () => void;
}

/**
 * Breadcrumb + toolbar row of the issue detail.
 *
 * The breadcrumb shows the single most-direct container, never a fabricated
 * chain. `project_id` and `parent_issue_id` are orthogonal (a sub-issue can
 * live in a different project than its parent), so we never render both:
 * parent wins, else project, else nothing. The project is still shown in the
 * properties panel. The workspace name is intentionally absent — "all issues"
 * is a view, not a container.
 */
export function IssueDetailHeader({
  issue,
  parentIssue,
  breadcrumbProject,
  onUpdateField,
  onDone,
  onDeletedNavigateTo,
  isPinned,
  onTogglePin,
  sidebarOpen,
  onToggleSidebar,
  sessionSidebarOpen,
  onToggleSessionSidebar,
}: IssueDetailHeaderProps) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  const [shareOpen, setShareOpen] = useState(false);

  const segments: BreadcrumbSegment[] = parentIssue
    ? [{ href: paths.issueDetail(parentIssue.id), label: parentIssue.identifier }]
    : breadcrumbProject
      ? [
          {
            href: paths.projectDetail(breadcrumbProject.id),
            className: "flex items-center gap-1 min-w-0 max-w-72",
            label: (
              <>
                <ProjectIcon project={breadcrumbProject} size="sm" />
                <span className="min-w-0 truncate">{breadcrumbProject.title}</span>
              </>
            ),
          },
        ]
      : [];

  return (
    <>
    <BreadcrumbHeader
      segments={segments}
      leaf={
        <AppLink
          href={paths.issueDetail(issue.id)}
          className="flex min-w-0 transition-opacity hover:opacity-80"
        >
          <span className="truncate font-medium text-foreground">
            {issue.identifier} {issue.title}
          </span>
        </AppLink>
      }
      actions={
        <>
        {onDone && issue.status !== "done" && issue.status !== "cancelled" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => { onUpdateField({ status: "done" }); onDone?.(); }}
                >
                  <CircleCheck />
                </Button>
              }
            />
            <TooltipContent side="bottom">{t(($) => $.detail.mark_done_tooltip)}</TooltipContent>
          </Tooltip>
        )}
        {onDone && issue.status === "done" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => { onDone(); }}
                >
                  <Archive />
                </Button>
              }
            />
            <TooltipContent side="bottom">{t(($) => $.detail.archive_tooltip)}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("text-muted-foreground", isPinned && "text-foreground")}
                onClick={onTogglePin}
              >
                {isPinned ? <PinOff /> : <Pin />}
              </Button>
            }
          />
          <TooltipContent side="bottom">{isPinned ? t(($) => $.detail.unpin_tooltip) : t(($) => $.detail.pin_tooltip)}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => setShareOpen(true)}
              >
                <Share2 />
              </Button>
            }
          />
          <TooltipContent side="bottom">{t(($) => $.share.tooltip)}</TooltipContent>
        </Tooltip>
        <IssueActionsDropdown
          issue={issue}
          align="end"
          onDeletedNavigateTo={onDeletedNavigateTo}
          trigger={
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
              <MoreHorizontal />
            </Button>
          }
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={sessionSidebarOpen ? "secondary" : "ghost"}
                size="icon-sm"
                className={sessionSidebarOpen ? "" : "text-muted-foreground"}
                aria-label={t(($) => $.detail.sessions_sidebar_tooltip)}
                aria-pressed={sessionSidebarOpen}
                onClick={onToggleSessionSidebar}
              >
                <PanelLeft />
              </Button>
            }
          />
          <TooltipContent side="bottom">
            {t(($) => $.detail.sessions_sidebar_tooltip)}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={sidebarOpen ? "secondary" : "ghost"}
                size="icon-sm"
                className={sidebarOpen ? "" : "text-muted-foreground"}
                onClick={onToggleSidebar}
              >
                <PanelRight />
              </Button>
            }
          />
          <TooltipContent side="bottom">{t(($) => $.detail.sidebar_tooltip)}</TooltipContent>
        </Tooltip>
        </>
      }
    />
    <IssueShareDialog issueId={issue.id} open={shareOpen} onOpenChange={setShareOpen} />
    </>
  );
}
