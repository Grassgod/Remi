"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { ChevronLeft } from "lucide-react";
import { useNavigation } from "../../navigation";
import { Button } from "@multiremi/ui/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@multiremi/ui/components/ui/resizable";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { useQuery } from "@tanstack/react-query";
import { useGitHubSettings } from "@multiremi/core/github";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useRecentContextStore } from "@multiremi/core/chat";
import {
  issueListOptions,
  issueDetailOptions,
  issueUsageOptions,
} from "@multiremi/core/issues/queries";
import { projectDetailOptions } from "@multiremi/core/projects/queries";
import { issueLabelsOptions } from "@multiremi/core/labels";
import { memberListOptions, agentListOptions } from "@multiremi/core/workspace/queries";
import { useRecentIssuesStore } from "@multiremi/core/issues/stores";
import { useIssueDetailPreferencesStore } from "@multiremi/core/issues/stores";
import { useIssueSelectionStore } from "@multiremi/core/issues/stores/selection-store";
import { useIssueActions } from "../actions";
import { useIssueSessionSelection } from "../hooks/use-issue-session-selection";
import { useOptionalProps } from "../hooks/use-optional-props";
import { useSidebarSections } from "../hooks/use-sidebar-sections";
import { KEY_RESULTS_SECTION_ID } from "./issue-key-results-section";
import { IssueDetailMain } from "./issue-detail-main";
import { IssueDetailSidebar } from "./issue-detail-sidebar";
import { IssueDetailSkeleton } from "./issue-detail-skeleton";
import { useT } from "../../i18n";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface IssueDetailProps {
  issueId: string;
  onDelete?: () => void;
  /** Called after the issue is marked as done via the toolbar button. */
  onDone?: () => void;
  defaultSidebarOpen?: boolean;
  layoutId?: string;
  /** When set, the issue detail will auto-scroll to this comment and briefly highlight it. */
  highlightCommentId?: string;
  /** Selects the product Session that owns a deep-linked comment. */
  initialIssueSessionId?: string;
  /** Lets the host decide whether and how Session selection changes its URL. */
  onIssueSessionChange?: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// IssueDetail
// ---------------------------------------------------------------------------

/**
 * Two slots inside a resizable group: `IssueDetailMain` (the document) and
 * `IssueDetailSidebar` (the property rail). This component owns the data both
 * slots share and the state that has to outlive either of them collapsing.
 */
export function IssueDetail({
  issueId,
  onDelete,
  onDone,
  defaultSidebarOpen = true,
  layoutId = "multimira_issue_detail_layout",
  highlightCommentId,
  initialIssueSessionId,
  onIssueSessionChange,
}: IssueDetailProps) {
  const { t } = useT("issues");
  const id = issueId;
  const router = useNavigation();
  const user = useAuthStore((s) => s.user);
  const paths = useWorkspacePaths();

  const wsId = useWorkspaceId();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const sessions = useIssueSessionSelection(
    id,
    initialIssueSessionId,
    onIssueSessionChange,
  );
  // Workspace owners and admins moderate any comment authored by anyone
  // (mirrors backend `comment.go:507-512`). Computed here so per-comment
  // rendering doesn't have to re-derive it for every row.
  const currentUserRole =
    members.find((m) => m.user_id === user?.id)?.role ?? null;
  const canModerateComments =
    currentUserRole === "owner" || currentUserRole === "admin";
  const { data: allIssues = [] } = useQuery(issueListOptions(wsId));
  const { getActorName } = useActorName();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: layoutId,
  });
  const sidebarRef = usePanelRef();
  const isMobile = useIsMobile();
  const sessionSidebarOpen = useIssueDetailPreferencesStore(
    (state) => state.sessionSidebarOpen,
  );
  const toggleSessionSidebar = useIssueDetailPreferencesStore(
    (state) => state.toggleSessionSidebar,
  );
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(defaultSidebarOpen);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileSessionSidebarOpen, setMobileSessionSidebarOpen] = useState(false);

  useEffect(() => {
    if (isMobile) {
      setMobileSidebarOpen(false);
      setMobileSessionSidebarOpen(false);
    }
  }, [id, isMobile]);
  const sidebarOpen = isMobile ? mobileSidebarOpen : desktopSidebarOpen;
  const visibleSessionSidebarOpen = isMobile
    ? mobileSessionSidebarOpen
    : sessionSidebarOpen;
  const sections = useSidebarSections();
  const githubSettings = useGitHubSettings();

  // Virtuoso's `customScrollParent` wants the HTMLElement, not a ref. A plain
  // `useRef.current` does not trigger a re-render when it populates, so the
  // Virtuoso prop would never receive the element. Callback ref + state fixes
  // that: setState triggers the re-render that hands Virtuoso the element.
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);

  // Issue data from TQ — uses detail query, seeded from list cache if available.
  // Only seed when description is present; list API omits it, and ContentEditor
  // reads defaultValue on mount only — seeding null description shows an empty editor.
  const { data: issue = null, isLoading: issueLoading } = useQuery({
    ...issueDetailOptions(wsId, id),
    initialData: () => {
      const cached = allIssues.find((i) => i.id === id);
      return cached?.description != null ? cached : undefined;
    },
  });

  // Record recent visit
  const recordVisit = useRecentIssuesStore((s) => s.recordVisit);
  const recordRecentContext = useRecentContextStore((s) => s.recordVisit);
  useEffect(() => {
    if (issue) {
      recordVisit(wsId, issue.id);
      recordRecentContext(wsId, {
        type: "issue",
        id: issue.id,
        label: issue.identifier,
        subtitle: issue.title,
        status: issue.status,
      });
    }
  }, [issue?.id, wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fire `onDelete` once when the issue transitions from loaded to missing.
  // Delete goes through a shell-level modal, so the caller (e.g. inbox) can't
  // be notified directly — instead, the detail page observes its own cache
  // clearing and runs the callback. We navigate via `onDeletedNavigateTo` on
  // the actions menu when no callback is supplied (standalone routes).
  const hadIssueRef = useRef(false);
  const firedDeleteCallbackRef = useRef(false);
  useEffect(() => {
    if (issue) {
      hadIssueRef.current = true;
      firedDeleteCallbackRef.current = false;
      return;
    }
    if (
      hadIssueRef.current &&
      !issueLoading &&
      !firedDeleteCallbackRef.current &&
      onDelete
    ) {
      firedDeleteCallbackRef.current = true;
      onDelete();
    }
  }, [issue, issueLoading, onDelete]);

  // Token usage — sidebar only, but queried here so the mobile sheet doesn't
  // have to be opened before the numbers start loading.
  const { data: usage } = useQuery(issueUsageOptions(id));

  // Sub-issue queries
  const parentIssueId = issue?.parent_issue_id;
  const { data: parentIssue = null } = useQuery({
    ...issueDetailOptions(wsId, parentIssueId ?? ""),
    enabled: !!parentIssueId,
    initialData: () => allIssues.find((i) => i.id === parentIssueId),
  });

  // Project segment in the breadcrumb. The issue's project_id is the source of
  // truth — same URL renders the same breadcrumb regardless of entry path.
  const issueProjectId = issue?.project_id;
  const { data: breadcrumbProject = null } = useQuery({
    ...projectDetailOptions(wsId, issueProjectId ?? ""),
    enabled: !!issueProjectId,
  });

  // Selection store is global (workspace-scoped); clear it whenever this
  // issue detail is mounted or switched, so leftover selections from the
  // main list view (or another sub-issue list) don't leak into this one.
  const clearSelection = useIssueSelectionStore((s) => s.clear);
  useEffect(() => {
    clearSelection();
    return clearSelection;
  }, [id, clearSelection]);

  const loading = issueLoading;

  // Shared issue actions (mutations, pin, copy-link, modal dispatch, etc.).
  // Called before the `if (!issue)` early return so hook order stays stable.
  const actions = useIssueActions(issue);

  // Labels live in their own query (not on the issue body) — fetch the count
  // here so seeding can decide whether the "Labels" optional row should be
  // shown for an issue that already has labels attached.
  const { data: attachedLabels = [] } = useQuery(issueLabelsOptions(wsId, id));
  const optionalProps = useOptionalProps(issue, attachedLabels.length);

  const handleToggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSidebarOpen((open) => !open);
      return;
    }

    const panel = sidebarRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, [isMobile, sidebarRef]);

  const handleToggleSessionSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSessionSidebarOpen((open) => !open);
      return;
    }
    toggleSessionSidebar();
  }, [isMobile, toggleSessionSidebar]);

  // A timeline "published a result" line points at the panel section that
  // holds the result itself. Open the panel first when it is closed —
  // otherwise the click would scroll to something the user can't see.
  const handleShowKeyResults = useCallback(() => {
    if (!sidebarOpen) handleToggleSidebar();
    document
      .getElementById(KEY_RESULTS_SECTION_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [handleToggleSidebar, sidebarOpen]);

  if (loading) {
    return <IssueDetailSkeleton />;
  }

  if (!issue) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>{t(($) => $.detail.not_found)}</p>
        {!onDelete && (
          <Button variant="outline" size="sm" onClick={() => router.push(paths.issues())}>
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            {t(($) => $.detail.back_to_issues)}
          </Button>
        )}
      </div>
    );
  }

  const sidebarContent = (
    <IssueDetailSidebar
      issue={issue}
      issueId={id}
      sections={sections}
      optionalProps={optionalProps}
      onUpdateField={actions.updateField}
      parentIssue={parentIssue}
      prSidebarEnabled={githubSettings.prSidebar}
      getActorName={getActorName}
      agents={agents}
      issueSessions={sessions.list}
      activeIssueSessionId={sessions.activeId}
      usage={usage}
      canManageArchives={canModerateComments}
    />
  );

  const detailContent = (
    <IssueDetailMain
      issue={issue}
      issueId={id}
      parentIssue={parentIssue}
      breadcrumbProject={breadcrumbProject}
      actions={actions}
      onDone={onDone}
      // When a parent passes `onDelete`, we detect deletion via the effect
      // above and skip navigation. Otherwise the modal navigates for us.
      onDeletedNavigateTo={onDelete ? undefined : paths.issues()}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={handleToggleSidebar}
      isMobile={isMobile}
      sessionSidebarOpen={visibleSessionSidebarOpen}
      onToggleSessionSidebar={handleToggleSessionSidebar}
      sessions={sessions}
      members={members}
      agents={agents}
      currentUserId={user?.id}
      canModerateComments={canModerateComments}
      highlightCommentId={highlightCommentId}
      onShowKeyResults={handleShowKeyResults}
      onScrollContainerRef={setScrollContainerEl}
      scrollContainerEl={scrollContainerEl}
    />
  );

  if (isMobile) {
    return (
      <div className="flex flex-1 min-h-0">
        {detailContent}
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="right" showCloseButton={false} className="w-[320px] overflow-y-auto p-4">
            {sidebarContent}
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="content" minSize="50%">
        {detailContent}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel
        id="sidebar"
        defaultSize={defaultSidebarOpen ? 320 : 0}
        minSize={260}
        maxSize={420}
        collapsible
        groupResizeBehavior="preserve-pixel-size"
        panelRef={sidebarRef}
        onResize={(size) => setDesktopSidebarOpen(size.inPixels > 0)}
      >
      <div className="overflow-y-auto border-l h-full">
        <div className="p-4">
          {sidebarContent}
        </div>
      </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
