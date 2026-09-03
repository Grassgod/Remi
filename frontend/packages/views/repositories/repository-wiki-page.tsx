"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BookOpen, ChevronRight, GitFork, History, Loader2, PanelLeft, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import {
  isWikiBuildActive,
  isWikiBuildInProgressError,
  repositoryKeys,
  repositoryListOptions,
  repositoryWikiDocsOptions,
  repositoryWikiSummariesOptions,
  useBuildRepositoryWiki,
} from "@multiremi/core/repositories";
import { api } from "@multiremi/core/api";
import type { RepositoryWikiDoc, RepositoryWikiStatus } from "@multiremi/core/types";
import type { AgentTask } from "@multiremi/core/types/agent";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@multiremi/ui/components/ui/sheet";
import { cn } from "@multiremi/ui/lib/utils";
import { AppLink } from "../navigation";
import { DocRefs } from "../common/doc-refs";
import { EmptyState } from "../common/empty-state";
import { WikiDirectoryTree, WikiPathBreadcrumb } from "../common/wiki-directory-tree";
import { WikiDocumentContent } from "../common/wiki-document-content";
import { TranscriptButton } from "../common/task-transcript";
import { PageHeader } from "../layout/page-header";
import { useT } from "../i18n";
import { KnowledgeProvenance } from "../knowledge/knowledge-provenance";

export function RepositoryWikiStatusBadge({ status }: { status: RepositoryWikiStatus }) {
  const { t } = useT("repositories");
  const quiet = status === "healthy";
  return (
    <Badge
      variant={status === "failed" ? "destructive" : status === "stale" ? "outline" : "secondary"}
      className={cn("gap-1.5", quiet && "border-0 bg-transparent px-0 text-muted-foreground")}
    >
      <span className={cn(
        "size-1.5 rounded-full",
        status === "healthy" ? "bg-emerald-500" : status === "failed" ? "bg-destructive-foreground" : status === "building" ? "animate-pulse bg-blue-500" : "bg-amber-500",
      )} />
      {t(($) => $.wiki.status[status])}
    </Badge>
  );
}

function HistoryPanel({ doc }: { doc: RepositoryWikiDoc }) {
  const { t } = useT("repositories");
  const workspaceId = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["repository-wiki-revisions", workspaceId, doc.repository_id, doc.id],
    queryFn: () => api.listRepositoryWikiRevisions(workspaceId, doc.repository_id, doc.id),
    enabled: open,
  });
  return (
    <div className="relative">
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen((value) => !value)}>
        <History className="size-3.5" />
        {t(($) => $.wiki.version, { version: doc.version })}
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded-md border bg-popover p-2 shadow-md">
          <p className="px-2 py-1 text-xs font-medium">{t(($) => $.wiki.history)}</p>
          {query.isLoading ? <Skeleton className="h-16 w-full" /> : (
            <div className="max-h-64 overflow-auto">
              {(query.data ?? []).map((revision) => (
                <div key={revision.id} className="border-t px-2 py-2 text-xs first:border-0">
                  <div className="font-medium">{t(($) => $.wiki.version, { version: revision.version })}</div>
                  <div className="mt-0.5 truncate text-muted-foreground">{revision.source_revision ?? revision.created_at}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RepositoryWikiPage({ repositoryId, wikiPath }: { repositoryId: string; wikiPath: string | null }) {
  const { t } = useT("repositories");
  const workspaceId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const queryClient = useQueryClient();
  const repositoriesQuery = useQuery(repositoryListOptions(workspaceId));
  const docsQuery = useQuery(repositoryWikiDocsOptions(workspaceId, repositoryId));
  const summariesQuery = useQuery(repositoryWikiSummariesOptions(workspaceId));
  const [filter, setFilter] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const buildMutation = useBuildRepositoryWiki(workspaceId, repositoryId);
  const repository = repositoriesQuery.data?.repositories.find((item) => item.id === repositoryId);
  const summary = summariesQuery.data?.find((item) => item.repository_id === repositoryId);
  const docs = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);
  const selected = docs.find((doc) => doc.path === wikiPath || doc.slug === wikiPath || doc.id === wikiPath) ?? docs[0] ?? null;
  const treePages = useMemo(() => docs.map((doc) => ({
    id: doc.id,
    path: doc.path,
    title: doc.title,
    searchText: `${doc.summary ?? ""}\n${doc.tags.join(" ")}`,
  })), [docs]);

  // The server-reported build state is the single source of truth — the page
  // never keeps its own "building" flag, so a refresh restores the state.
  const buildInfo = summary?.build ?? null;
  const building = isWikiBuildActive(summary);
  const buildFailed = !building && (buildInfo?.status === "failed" || summary?.status === "failed");
  const failureReason = buildInfo?.failure_reason ?? summary?.status_message ?? null;

  // When polling observes the build leaving the active state (→ healthy or
  // failed), refresh the docs so newly generated pages appear immediately.
  const wasBuildingRef = useRef(false);
  useEffect(() => {
    if (wasBuildingRef.current && !building) {
      queryClient.invalidateQueries({ queryKey: repositoryKeys.wiki(workspaceId, repositoryId) });
    }
    wasBuildingRef.current = building;
  }, [building, queryClient, repositoryId, workspaceId]);

  const handleBuild = () => {
    if (building || buildMutation.isPending) return;
    buildMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(t(($) => $.wiki.build_started));
      },
      onError: (error) => {
        // 409 "already building" is not a failure — the mutation hook has
        // already flipped the cached summary to the building state.
        if (isWikiBuildInProgressError(error)) {
          toast.info(t(($) => $.wiki.build_in_progress));
          return;
        }
        toast.error(error instanceof Error && error.message ? error.message : t(($) => $.wiki.build_failed));
      },
    });
  };

  // Minimal AgentTask so TranscriptButton can lazy-load the Wiki build
  // transcript — same pattern as the autopilot run history rows.
  const buildTask: AgentTask | null = buildInfo?.task_id
    ? {
        id: buildInfo.task_id,
        agent_id: "",
        runtime_id: "",
        issue_id: "",
        status: buildFailed ? "failed" : building ? "running" : "completed",
        priority: 0,
        dispatched_at: null,
        started_at: buildInfo.started_at,
        completed_at: null,
        result: null,
        error: buildInfo.failure_reason,
        created_at: buildInfo.started_at ?? buildInfo.updated_at ?? "",
      }
    : null;

  const buildDisabled = building || buildMutation.isPending;
  const buildPending = building || buildMutation.isPending;
  const sidebar = (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 border-b p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t(($) => $.wiki.search)} className="h-8 pl-8 text-sm" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t(($) => $.wiki.page_count, { count: docs.length })}</p>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        <WikiDirectoryTree
          pages={treePages}
          selectedId={selected?.id}
          filter={filter}
          noMatches={t(($) => $.wiki.no_match)}
          hrefFor={(page) => paths.repositoryWikiPage(repositoryId, page.path)}
          onNavigate={() => setSidebarOpen(false)}
        />
      </nav>
    </div>
  );

  const buildButton = (variant: "default" | "outline", rebuild: boolean, compact = false) => (
    <Button
      type="button"
      size={variant === "outline" ? "sm" : undefined}
      variant={variant}
      disabled={buildDisabled}
      onClick={handleBuild}
      aria-label={buildPending
        ? t(($) => $.wiki.building_action)
        : rebuild
          ? t(($) => $.wiki.rebuild_action)
          : t(($) => $.wiki.build_action)}
    >
      {buildPending
        ? <Loader2 className="size-4 animate-spin" />
        : rebuild
          ? <RefreshCw className="size-4" />
          : <BookOpen className="size-4" />}
      <span className={cn(compact && "hidden md:inline")}>
        {buildPending
          ? t(($) => $.wiki.building_action)
          : rebuild
            ? t(($) => $.wiki.rebuild_action)
            : t(($) => $.wiki.build_action)}
      </span>
    </Button>
  );

  if (repositoriesQuery.isLoading || docsQuery.isLoading) {
    return <div className="flex flex-1 flex-col"><PageHeader><Skeleton className="h-4 w-40" /></PageHeader><div className="p-5"><Skeleton className="h-96 w-full" /></div></div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="justify-between px-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {docs.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="-ml-2 lg:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label={t(($) => $.wiki.title)}
              title={t(($) => $.wiki.title)}
            >
              <PanelLeft className="size-4" />
            </Button>
          )}
          <AppLink href={paths.repositories()} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <GitFork className="size-4" />
            <span className="hidden sm:inline">{repository?.name ?? t(($) => $.page.title)}</span>
          </AppLink>
          <ChevronRight className="size-3.5 text-muted-foreground" />
          <span className="truncate font-medium">{t(($) => $.wiki.title)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RepositoryWikiStatusBadge status={building ? "building" : summary?.status ?? "unbuilt"} />
          {building && buildTask && (
            <TranscriptButton task={buildTask} agentName={t(($) => $.wiki.build_agent_name)} isLive title={t(($) => $.wiki.view_build_log)} />
          )}
          {docs.length > 0 && buildButton("outline", true, true)}
        </div>
      </PageHeader>

      {buildFailed && (
        <div className="flex items-center gap-3 border-b bg-destructive/5 px-5 py-2.5 text-sm">
          <AlertCircle className="size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 truncate">
            <span className="font-medium text-destructive">{t(($) => $.wiki.build_failed_title)}</span>
            {failureReason && <span className="ml-2 text-muted-foreground" title={failureReason}>{failureReason}</span>}
          </div>
          {buildTask && (
            <TranscriptButton task={buildTask} agentName={t(($) => $.wiki.build_agent_name)} title={t(($) => $.wiki.view_build_log)} />
          )}
          {docs.length === 0 && buildButton("outline", true)}
        </div>
      )}

      {docsQuery.isError ? (
        <EmptyState variant="status" tone="destructive" icon={AlertCircle} title={String(docsQuery.error)} />
      ) : docs.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t(($) => $.wiki.empty_title)}
          description={t(($) => $.wiki.empty_description)}
          action={buildButton("default", buildFailed)}
        />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="hidden min-h-0 border-r lg:flex">{sidebar}</aside>
          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetContent side="left" className="!w-[280px] gap-0 p-0" showCloseButton={false}>
              <SheetTitle className="sr-only">{t(($) => $.wiki.title)}</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>

          {selected && (
            <main className="min-h-0 overflow-auto">
              <article className="mx-auto max-w-3xl px-6 py-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <WikiPathBreadcrumb path={selected.path} />
                    <h1 className="mt-1 text-xl font-semibold">{selected.title}</h1>
                    {selected.summary && <p className="mt-1 text-sm text-muted-foreground">{selected.summary}</p>}
                  </div>
                  <HistoryPanel doc={selected} />
                </div>
                <DocRefs refs={selected.refs} className="mt-3" />
                <KnowledgeProvenance compilationRunId={selected.compilation_run_id} />
                <div className="mt-5">
                  <WikiDocumentContent
                    doc={selected}
                    pages={docs}
                    scope={{ kind: "repository", repositoryId }}
                  />
                </div>
                <footer className="mt-8 flex flex-wrap gap-2 border-t pt-3 text-xs text-muted-foreground">
                  {selected.source_revision && <span className="font-mono">{t(($) => $.wiki.source_revision, { revision: selected.source_revision.slice(0, 12) })}</span>}
                  <span>{t(($) => $.wiki.updated, { time: new Date(selected.updated_at).toLocaleString() })}</span>
                </footer>
              </article>
            </main>
          )}
        </div>
      )}
    </div>
  );
}
