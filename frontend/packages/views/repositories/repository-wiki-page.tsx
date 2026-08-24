"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BookOpen, ChevronRight, FileText, GitFork, History, Loader2, RefreshCw, Search } from "lucide-react";
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
import { cn } from "@multiremi/ui/lib/utils";
import { AppLink } from "../navigation";
import { DocRefs } from "../common/doc-refs";
import { EmptyState } from "../common/empty-state";
import { TranscriptButton } from "../common/task-transcript";
import { ReadonlyContent } from "../editor";
import { PageHeader } from "../layout/page-header";
import { useT } from "../i18n";

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
  const buildMutation = useBuildRepositoryWiki(workspaceId, repositoryId);
  const repository = repositoriesQuery.data?.repositories.find((item) => item.id === repositoryId);
  const summary = summariesQuery.data?.find((item) => item.repository_id === repositoryId);
  const docs = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return docs.filter((doc) => !query || [doc.title, doc.path, doc.summary ?? "", ...doc.tags].some((value) => value.toLowerCase().includes(query)));
  }, [docs, filter]);
  const selected = docs.find((doc) => doc.path === wikiPath || doc.slug === wikiPath || doc.id === wikiPath) ?? docs[0] ?? null;

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

  // Minimal AgentTask so TranscriptButton can lazy-load the Atlas build
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

  const buildButton = (variant: "default" | "outline", rebuild: boolean) => (
    <Button
      type="button"
      size={variant === "outline" ? "sm" : undefined}
      variant={variant}
      disabled={buildDisabled}
      onClick={handleBuild}
    >
      {buildPending
        ? <Loader2 className="size-4 animate-spin" />
        : rebuild
          ? <RefreshCw className="size-4" />
          : <BookOpen className="size-4" />}
      {buildPending
        ? t(($) => $.wiki.building_action)
        : rebuild
          ? t(($) => $.wiki.rebuild_action)
          : t(($) => $.wiki.build_action)}
    </Button>
  );

  if (repositoriesQuery.isLoading || docsQuery.isLoading) {
    return <div className="flex flex-1 flex-col"><PageHeader><Skeleton className="h-4 w-40" /></PageHeader><div className="p-5"><Skeleton className="h-96 w-full" /></div></div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="justify-between px-5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <AppLink href={paths.repositories()} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <GitFork className="size-4" />
            {repository?.name ?? t(($) => $.page.title)}
          </AppLink>
          <ChevronRight className="size-3.5 text-muted-foreground" />
          <span className="truncate font-medium">{t(($) => $.wiki.title)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RepositoryWikiStatusBadge status={building ? "building" : summary?.status ?? "unbuilt"} />
          {building && buildTask && (
            <TranscriptButton task={buildTask} agentName="Atlas" isLive title={t(($) => $.wiki.view_build_log)} />
          )}
          {docs.length > 0 && buildButton("outline", true)}
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
            <TranscriptButton task={buildTask} agentName="Atlas" title={t(($) => $.wiki.view_build_log)} />
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
        <div className="flex min-h-0 flex-1 flex-col xl:grid xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="shrink-0 border-b xl:min-h-0 xl:border-b-0 xl:border-r">
            <div className="border-b p-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t(($) => $.wiki.search)} className="pl-8" />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t(($) => $.wiki.page_count, { count: docs.length })}</p>
            </div>
            <nav className="flex max-h-52 gap-1 overflow-auto p-2 xl:max-h-none xl:flex-col">
              {filtered.length ? filtered.map((doc) => (
                <AppLink
                  key={doc.id}
                  href={paths.repositoryWikiPage(repositoryId, doc.path)}
                  className={cn("flex min-w-48 items-center gap-2 rounded-md px-2 py-1.5 text-sm xl:min-w-0", selected?.id === doc.id ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
                >
                  <FileText className="size-3.5 shrink-0" />
                  <span className="truncate" title={doc.title}>{doc.title}</span>
                </AppLink>
              )) : <p className="p-2 text-xs text-muted-foreground">{t(($) => $.wiki.no_match)}</p>}
            </nav>
          </aside>

          {selected && (
            <main className="min-h-0 overflow-auto">
              <article className="mx-auto max-w-3xl px-6 py-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-muted-foreground">{selected.path}</p>
                    <h1 className="mt-1 text-xl font-semibold">{selected.title}</h1>
                    {selected.summary && <p className="mt-1 text-sm text-muted-foreground">{selected.summary}</p>}
                  </div>
                  <HistoryPanel doc={selected} />
                </div>
                <DocRefs refs={selected.refs} className="mt-3" />
                <div className="mt-5"><ReadonlyContent content={selected.body} /></div>
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
