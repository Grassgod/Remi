"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownUp,
  BookOpen,
  Brain,
  Check,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileInput,
  Files,
  FolderKanban,
  GitBranch,
  GitFork,
  GitPullRequest,
  Library,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@multiremi/ui/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multiremi/ui/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { workspaceDocListOptions } from "@multiremi/core/project-docs";
import { knowledgeRunOptions, knowledgeRunsOptions, knowledgeSubmissionsOptions } from "@multiremi/core/knowledge";
import { projectListOptions } from "@multiremi/core/projects/queries";
import { repositoryListOptions, repositoryWikiSummariesOptions } from "@multiremi/core/repositories";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type {
  KnowledgeRunDetail,
  KnowledgeSubmission,
  Project,
  RepositoryWikiSummary,
  WorkspaceDoc,
  WorkspaceRepository,
} from "@multiremi/core/types";
import type { AgentTask } from "@multiremi/core/types/agent";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { AppLink } from "../navigation";
import { ActorAvatar } from "../common/actor-avatar";
import { EmptyState } from "../common/empty-state";
import { TranscriptButton } from "../common/task-transcript";
import { PageHeader } from "../layout/page-header";
import { ProjectIcon } from "../projects/components/project-icon";
import { MemoryCard } from "../projects/components/wiki/project-wiki-section";
import { useFormatRelativeDate } from "../projects/components/labels";
import { matchesPinyin } from "../editor/extensions/pinyin-match";
import { useT } from "../i18n";

type KnowledgeTab = "wiki" | "raw" | "memory" | "runs";
type SortOrder = "newest" | "oldest";

function knowledgePluginLabel(name: string): string {
  return name === "code-to-wiki" ? "Code to Wiki" : name;
}

interface ProjectWikiRow {
  project: Project;
  docs: WorkspaceDoc[];
  latestUpdatedAt: string | null;
}

function KnowledgeShell({ count, children }: { count?: number; children: ReactNode }) {
  const { t } = useT("projects");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Library className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="shrink-0 text-sm font-medium">{t(($) => $.knowledge.title)}</h1>
          {count !== undefined && count > 0 && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
          )}
          <p className="ml-1 hidden truncate text-xs text-muted-foreground md:block">
            {t(($) => $.knowledge.description)}
          </p>
        </div>
      </PageHeader>
      {children}
    </div>
  );
}

function LoadingPane() {
  return (
    <div className="space-y-2 p-4" data-testid="knowledge-loading">
      <Skeleton className="h-8 w-full" />
      {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-12 w-full" />)}
    </div>
  );
}

function ErrorPane({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useT("projects");
  return (
    <EmptyState
      variant="status"
      tone="destructive"
      icon={AlertCircle}
      title={t(($) => $.knowledge.load_error_title)}
      description={error instanceof Error ? error.message : t(($) => $.knowledge.load_error_hint)}
      action={<Button type="button" variant="outline" size="sm" onClick={retry}>{t(($) => $.knowledge.load_error_retry)}</Button>}
    />
  );
}

function matchesDoc(doc: WorkspaceDoc, query: string): boolean {
  return [doc.title, doc.summary ?? "", doc.body, ...doc.tags]
    .some((value) => value.toLowerCase().includes(query));
}

function ProjectMaintainer({ project }: { project: Project }) {
  const { getActorName } = useActorName();
  if (!project.lead_type || !project.lead_id) return <span className="text-xs text-muted-foreground">--</span>;
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <ActorAvatar actorType={project.lead_type} actorId={project.lead_id} size={20} profileLink={false} />
      <span className="truncate">{getActorName(project.lead_type, project.lead_id)}</span>
    </span>
  );
}

function ProjectWikiRowView({ row }: { row: ProjectWikiRow }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const first = row.docs[0];
  const href = first
    ? paths.projectWikiPage(row.project.id, first.slug || first.id)
    : paths.projectWiki(row.project.id);
  return (
    <AppLink
      href={href}
      data-testid={`knowledge-project-${row.project.id}`}
      className="group grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-11 sm:grid-cols-[minmax(220px,1fr)_80px_108px_minmax(128px,180px)_20px]"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded border bg-muted/50">
          {row.project.icon ? <ProjectIcon project={row.project} size="sm" /> : <FolderKanban className="size-3.5 text-muted-foreground" />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{row.project.title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground sm:hidden">
            {t(($) => $.knowledge.wiki_pages, { count: row.docs.length })}
          </span>
        </span>
      </span>
      <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
        {row.docs.length || "--"}
      </span>
      <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
        {row.latestUpdatedAt ? formatRelativeDate(row.latestUpdatedAt) : "--"}
      </span>
      <span className="hidden min-w-0 sm:block"><ProjectMaintainer project={row.project} /></span>
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </AppLink>
  );
}

function RepositoryRow({ repository, summary }: { repository: WorkspaceRepository; summary?: RepositoryWikiSummary }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  return (
    <AppLink href={paths.repositoryWiki(repository.id)} className="group grid min-h-12 grid-cols-[minmax(0,1fr)_auto_20px] items-center gap-3 border-b px-4 last:border-b-0 hover:bg-accent/40">
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded border bg-muted/50"><GitFork className="size-3.5 text-muted-foreground" /></span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{repository.name}</span>
          <span className="block truncate font-mono text-xs text-muted-foreground">{repository.url}</span>
        </span>
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {summary?.page_count ? t(($) => $.knowledge.repository_pages, { count: summary.page_count }) : t(($) => $.knowledge.repository_unbuilt)}
      </span>
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </AppLink>
  );
}

function WikiPane({
  projects,
  docs,
  repositories,
  summaries,
  search,
  sortOrder,
}: {
  projects: Project[];
  docs: WorkspaceDoc[];
  repositories: WorkspaceRepository[];
  summaries: RepositoryWikiSummary[];
  search: string;
  sortOrder: SortOrder;
}) {
  const { t } = useT("projects");
  const query = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const docsByProject = new Map<string, WorkspaceDoc[]>();
    for (const doc of docs) {
      if (doc.kind !== "wiki" || doc.slug === "_schema") continue;
      const current = docsByProject.get(doc.project_id) ?? [];
      current.push(doc);
      docsByProject.set(doc.project_id, current);
    }
    return projects.map<ProjectWikiRow>((project) => {
      const projectDocs = (docsByProject.get(project.id) ?? []).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return { project, docs: projectDocs, latestUpdatedAt: projectDocs[0]?.updated_at ?? null };
    }).filter((row) => !query
      || row.project.title.toLowerCase().includes(query)
      || matchesPinyin(row.project.title, query)
      || (row.project.description ?? "").toLowerCase().includes(query)
      || row.docs.some((doc) => matchesDoc(doc, query)))
      .sort((a, b) => {
        if (!a.latestUpdatedAt && !b.latestUpdatedAt) return a.project.title.localeCompare(b.project.title);
        if (!a.latestUpdatedAt) return 1;
        if (!b.latestUpdatedAt) return -1;
        const delta = b.latestUpdatedAt.localeCompare(a.latestUpdatedAt);
        return sortOrder === "newest" ? delta : -delta;
      });
  }, [docs, projects, query, sortOrder]);
  const summariesByRepository = new Map(summaries.map((summary) => [summary.repository_id, summary]));
  const repositoryRows = repositories.filter((repository) => !query
    || [repository.name, repository.url, repository.description ?? ""].some((value) => value.toLowerCase().includes(query)));

  if (rows.length === 0 && repositoryRows.length === 0) {
    return <EmptyState icon={BookOpen} title={t(($) => $.knowledge.no_results)} />;
  }
  return (
    <div className="space-y-5 p-4">
      {rows.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Files className="size-3.5" />{t(($) => $.knowledge.projects_group)}</h2>
          <div className="overflow-hidden rounded-md border">
            <div className="hidden h-8 grid-cols-[minmax(220px,1fr)_80px_108px_minmax(128px,180px)_20px] items-center gap-3 border-b bg-muted/20 px-4 text-xs text-muted-foreground sm:grid">
              <span>{t(($) => $.knowledge.column_project)}</span><span>{t(($) => $.knowledge.column_wiki)}</span><span>{t(($) => $.knowledge.column_updated)}</span><span>{t(($) => $.knowledge.column_maintainer)}</span><span />
            </div>
            {rows.map((row) => <ProjectWikiRowView key={row.project.id} row={row} />)}
          </div>
        </section>
      )}
      {repositoryRows.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><GitFork className="size-3.5" />{t(($) => $.knowledge.repositories_group)}</h2>
          <div className="overflow-hidden rounded-md border">
            {repositoryRows.map((repository) => <RepositoryRow key={repository.id} repository={repository} summary={summariesByRepository.get(repository.id)} />)}
          </div>
        </section>
      )}
    </div>
  );
}

function MemoryPane({ projects, docs, search }: { projects: Project[]; docs: WorkspaceDoc[]; search: string }) {
  const { t } = useT("projects");
  const query = search.trim().toLowerCase();
  const allWikiPages = docs.filter((doc) => doc.kind === "wiki" && doc.slug !== "_schema");
  const groups = projects.map((project) => ({
    project,
    docs: docs.filter((doc) => doc.project_id === project.id && doc.kind === "memory" && (!query || matchesDoc(doc, query)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  })).filter((group) => group.docs.length > 0);
  if (groups.length === 0) return <EmptyState icon={Brain} title={query ? t(($) => $.knowledge.no_results) : t(($) => $.knowledge.memory_empty)} />;
  return (
    <div className="space-y-6 p-4">
      {groups.map(({ project, docs: memoryDocs }) => (
        <section key={project.id}>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <FolderKanban className="size-3.5" />{project.title}<span className="tabular-nums">{memoryDocs.length}</span>
          </h2>
          <div className="grid gap-3 xl:grid-cols-2">
            {memoryDocs.map((doc) => <MemoryCard key={doc.id} doc={doc} pages={allWikiPages.filter((page) => page.project_id === project.id)} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed" || status === "rejected") return "destructive";
  if (status === "published" || status === "consumed") return "secondary";
  if (status === "processing" || status === "validating") return "default";
  return "outline";
}

function syntheticKnowledgeTask(detail: KnowledgeRunDetail): AgentTask | null {
  const { run } = detail;
  if (!run.task_id) return null;
  return {
    id: run.task_id,
    agent_id: run.agent_id ?? "",
    runtime_id: "",
    issue_id: "",
    status: run.status === "processing" || run.status === "validating"
      ? "running"
      : run.status === "failed" ? "failed" : "completed",
    priority: 0,
    dispatched_at: null,
    started_at: run.created_at || null,
    completed_at: run.completed_at,
    result: null,
    error: run.status === "failed" ? run.result_summary : null,
    created_at: run.created_at,
  };
}

function runDuration(createdAt: string, completedAt: string | null): string | null {
  if (!createdAt || !completedAt) return null;
  const durationMs = Date.parse(completedAt) - Date.parse(createdAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function KnowledgeRunSheet({
  selected,
  onOpenChange,
}: {
  selected: KnowledgeRunDetail | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("projects");
  const workspaceId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { getAgentName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const detailQuery = useQuery(knowledgeRunOptions(workspaceId, selected?.run.id));
  const detail = detailQuery.data ?? selected;
  const run = detail?.run;
  const sources = detail?.sources ?? [];
  const outputs = detail?.outputs ?? [];
  const provenance = run?.provenance;
  const repositoryLabel = provenance?.repository_name || provenance?.repository_id || run?.repository_id;
  const agentName = run
    ? run.agent?.name || (run.agent_id ? getAgentName(run.agent_id) : t(($) => $.knowledge.provenance_manual))
    : t(($) => $.knowledge.provenance_unknown);
  const task = detail ? syntheticKnowledgeTask(detail) : null;
  const duration = run ? runDuration(run.created_at, run.completed_at) : null;

  const modeLabel = (() => {
    switch (run?.mode) {
      case "repository_update": return t(($) => $.knowledge.run_mode_repository_update);
      case "issue_ingest": return t(($) => $.knowledge.run_mode_issue_ingest);
      case "memory_curate": return t(($) => $.knowledge.run_mode_memory_curate);
      default: return run?.mode || t(($) => $.knowledge.provenance_unknown);
    }
  })();
  const triggerLabel = (() => {
    switch (provenance?.event_type ?? provenance?.automation_source) {
      case "change.merged": return t(($) => $.knowledge.run_trigger_change_merged);
      case "default_branch.updated": return t(($) => $.knowledge.run_trigger_default_branch);
      case "schedule": return t(($) => $.knowledge.run_trigger_schedule);
      case "manual": return t(($) => $.knowledge.run_trigger_manual);
      default: return provenance?.event_type || provenance?.automation_source || t(($) => $.knowledge.run_trigger_unknown);
    }
  })();

  return (
    <Sheet open={Boolean(selected)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(440px,100vw)] gap-0 p-0 sm:max-w-[440px]">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{t(($) => $.knowledge.run_details_title)}</SheetTitle>
          <SheetDescription className="truncate font-mono text-xs">
            {provenance?.automation_title || run?.id || t(($) => $.knowledge.run_details_description)}
          </SheetDescription>
        </SheetHeader>

        {!detail && detailQuery.isPending ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{t(($) => $.knowledge.run_details_loading)}
          </div>
        ) : !detail ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <AlertCircle className="size-5 text-destructive" />
            <p className="text-sm text-muted-foreground">{t(($) => $.knowledge.provenance_unavailable)}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
              {t(($) => $.knowledge.load_error_retry)}
            </Button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-wrap gap-1.5 border-b px-4 py-3">
              <Badge variant="outline" className="font-normal">{modeLabel}</Badge>
              <Badge variant="secondary" className="font-normal">{triggerLabel}</Badge>
              <Badge variant={statusVariant(detail.run.status)} className="font-normal">{detail.run.status}</Badge>
              {duration && <Badge variant="outline" className="font-normal">{duration}</Badge>}
            </div>

            <section className="border-b px-4 py-4">
              <h3 className="text-xs font-medium text-muted-foreground">{t(($) => $.knowledge.run_stage_trigger)}</h3>
              <div className="mt-3 space-y-2 text-sm">
                {provenance ? (
                  <>
                    {repositoryLabel && (
                      <div className="flex min-w-0 items-center gap-2">
                        <GitFork className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{repositoryLabel}</span>
                      </div>
                    )}
                    <div className="flex min-w-0 items-center gap-2">
                      <Sparkles className="size-4 shrink-0 text-muted-foreground" />
                      <AppLink href={paths.autopilotDetail(provenance.automation_id)} className="truncate hover:underline">
                        {provenance.automation_title || provenance.automation_id}
                      </AppLink>
                    </div>
                    {provenance.change_number !== null ? (
                      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <GitPullRequest className="size-4 shrink-0" />
                        {provenance.change_url ? (
                          <a href={provenance.change_url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1 hover:text-foreground hover:underline">
                            <span className="truncate">#{provenance.change_number}{provenance.change_title ? ` ${provenance.change_title}` : ""}</span>
                            <ExternalLink className="size-3 shrink-0" />
                          </a>
                        ) : <span className="truncate">#{provenance.change_number}{provenance.change_title ? ` ${provenance.change_title}` : ""}</span>}
                      </div>
                    ) : null}
                    {(provenance.target_branch || provenance.source_revision) && (
                      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <GitBranch className="size-4 shrink-0" />
                        <span className="truncate font-mono text-xs">
                          {[provenance.target_branch, provenance.source_revision?.slice(0, 7)].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                    )}
                  </>
                ) : <p className="text-muted-foreground">{t(($) => $.knowledge.run_trigger_unknown)}</p>}
              </div>
            </section>

            <section className="border-b px-4 py-4">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t(($) => $.knowledge.run_stage_inputs)} · {sources.length}
              </h3>
              <div className="mt-3 divide-y">
                {sources.length > 0 ? sources.map((source) => (
                  <div key={source.id} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex min-w-0 items-center gap-2 text-sm">
                      <FileInput className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-xs">{source.submission_id || source.source_ref || source.source_type}</span>
                    </div>
                    {source.submission?.body && (
                      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words pl-6 text-xs leading-relaxed text-muted-foreground">
                        {source.submission.body}
                      </p>
                    )}
                  </div>
                )) : <p className="text-sm text-muted-foreground">{t(($) => $.knowledge.provenance_no_sources)}</p>}
              </div>
            </section>

            <section className="border-b px-4 py-4">
              <h3 className="text-xs font-medium text-muted-foreground">{t(($) => $.knowledge.run_stage_agent)}</h3>
              <div className="mt-3 flex items-start gap-2">
                <ActorAvatar actorType={detail.run.agent_id ? "agent" : "system"} actorId={detail.run.agent_id ?? "manual"} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{agentName}</div>
                  {detail.run.plugin_names.length > 0 && (
                    <div className="mt-2">
                      <div className="mb-1 text-xs text-muted-foreground">{t(($) => $.knowledge.run_plugins)}</div>
                      <TooltipProvider delay={100}>
                        <div className="flex flex-wrap gap-1">
                          {detail.run.plugin_names.map((plugin) => (
                            <Tooltip key={plugin}>
                              <TooltipTrigger render={
                                <button type="button" className="rounded border px-2 py-0.5 text-xs hover:bg-accent">
                                  {knowledgePluginLabel(plugin)}
                                </button>
                              } />
                              <TooltipContent>
                                {plugin === "code-to-wiki"
                                  ? t(($) => $.knowledge.plugin_code_to_wiki_description)
                                  : plugin}
                              </TooltipContent>
                            </Tooltip>
                          ))}
                        </div>
                      </TooltipProvider>
                    </div>
                  )}
                </div>
                {task && (
                  <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <span>{t(($) => $.knowledge.run_task_transcript)}</span>
                    <TranscriptButton
                      task={task}
                      agentName={agentName}
                      isLive={task.status === "running"}
                      title={t(($) => $.knowledge.run_task_transcript)}
                    />
                  </div>
                )}
              </div>
            </section>

            <section className="px-4 py-4">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t(($) => $.knowledge.run_stage_outputs)} · {outputs.length}
              </h3>
              <div className="mt-3 divide-y">
                {outputs.length > 0 ? outputs.map((output) => (
                  <div key={output.id} className="flex min-w-0 items-start gap-2 py-2 first:pt-0 last:pb-0">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      <Check className="size-3" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5 text-sm">
                        <Badge variant="outline" className="shrink-0 font-normal">{output.action}</Badge>
                        <span className="truncate">{output.artifact?.title || output.artifact?.path || output.doc_id || output.artifact_scope}</span>
                        {output.version !== null && <span className="shrink-0 text-xs text-muted-foreground">{t(($) => $.knowledge.version_short, { version: output.version })}</span>}
                      </div>
                      {output.artifact?.path && <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{output.artifact.path}</div>}
                    </div>
                  </div>
                )) : <p className="text-sm text-muted-foreground">{t(($) => $.knowledge.provenance_no_outputs)}</p>}
              </div>
              {detail.run.result_summary && (
                <div className="mt-4 border-t pt-3">
                  <div className="text-xs font-medium text-muted-foreground">{t(($) => $.knowledge.run_result)}</div>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{detail.run.result_summary}</p>
                </div>
              )}
            </section>
          </div>
        )}

        {run && (
          <div className="border-t px-4 py-3 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono" title={run.id}>{run.id}</span>
              <span className="shrink-0">{run.created_at ? formatRelativeDate(run.created_at) : "--"}</span>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RawBodyPreview({ body, fallback }: { body: string; fallback: string }) {
  const content = body || fallback;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" className="mt-1 block w-full truncate text-left text-xs text-muted-foreground">
            {content}
          </button>
        }
      />
      <TooltipContent
        side="bottom"
        align="start"
        className="max-h-80 w-[min(32rem,calc(100vw-2rem))] max-w-none items-start overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 leading-relaxed"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function RawPane({ submissions, search }: { submissions: KnowledgeSubmission[]; search: string }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const { getAgentName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const query = search.trim().toLowerCase();
  const rows = submissions.filter((submission) => !query || [
    submission.id, submission.body, submission.source_type, submission.scope,
    submission.proposed_path ?? "", submission.proposed_slug ?? "",
    submission.source_issue?.key ?? submission.source_issue_id ?? "",
    submission.author_agent?.name ?? submission.author_agent_id ?? "",
  ].some((value) => value.toLowerCase().includes(query)));
  if (rows.length === 0) return <EmptyState icon={FileInput} title={query ? t(($) => $.knowledge.no_results) : t(($) => $.knowledge.raw_empty)} />;
  return (
    <TooltipProvider delay={100}>
      <div className="p-4">
        <div className="overflow-hidden rounded-md border">
          <div className="hidden h-8 grid-cols-[minmax(160px,1fr)_120px_130px_minmax(180px,1.2fr)_110px_96px] items-center gap-3 border-b bg-muted/20 px-4 text-xs text-muted-foreground lg:grid">
            <span>{t(($) => $.knowledge.raw_source)}</span><span>{t(($) => $.knowledge.raw_issue)}</span><span>{t(($) => $.knowledge.raw_agent)}</span><span>{t(($) => $.knowledge.raw_target)}</span><span>{t(($) => $.knowledge.raw_status)}</span><span>{t(($) => $.knowledge.raw_created)}</span>
          </div>
          {rows.map((submission) => {
            const issueLabel = submission.source_issue?.key || submission.source_issue?.title || submission.source_issue_id;
            const agentLabel = submission.author_agent?.name
              || (submission.author_agent_id ? getAgentName(submission.author_agent_id) : null);
            const target = submission.proposed_path || submission.proposed_slug || t(($) => $.knowledge.raw_unspecified_target);
            return (
              <article key={submission.id} className="grid gap-2 border-b px-4 py-3 last:border-b-0 lg:grid-cols-[minmax(160px,1fr)_120px_130px_minmax(180px,1.2fr)_110px_96px] lg:items-center lg:gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5"><FileInput className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate text-xs font-medium">{submission.source_type}</span></div>
                  <RawBodyPreview body={submission.body} fallback={submission.id} />
                </div>
                <div className="min-w-0 text-xs">
                  {issueLabel && submission.source_issue_id ? <AppLink href={paths.issueDetail(submission.source_issue_id)} className="block truncate hover:underline">{issueLabel}</AppLink> : <span className="text-muted-foreground">--</span>}
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-xs">
                  {submission.author_agent_id && <ActorAvatar actorType="agent" actorId={submission.author_agent_id} size={16} />}
                  <span className="truncate">{agentLabel || t(($) => $.knowledge.provenance_unknown)}</span>
                </div>
                <div className="min-w-0 text-xs">
                  <Badge variant="outline" className="mr-1.5 font-normal">{submission.scope}</Badge>
                  <span className="break-all font-mono text-muted-foreground">{target}</span>
                </div>
                <Badge variant={statusVariant(submission.status)} className="w-fit font-normal">{submission.status}</Badge>
                <span className="text-xs text-muted-foreground">{submission.created_at ? formatRelativeDate(submission.created_at) : "--"}</span>
              </article>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}

function RunPane({ runs, search }: { runs: KnowledgeRunDetail[]; search: string }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const { getAgentName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const [selected, setSelected] = useState<KnowledgeRunDetail | null>(null);
  const query = search.trim().toLowerCase();
  const rows = runs.filter(({ run, sources, outputs }) => !query || [
    run.id, run.mode, run.status, run.result_summary ?? "", run.agent?.name ?? run.agent_id ?? "",
    run.provenance?.automation_title ?? "", run.provenance?.event_type ?? "",
    run.provenance?.repository_name ?? "", run.provenance?.change_title ?? "",
    ...run.plugin_names, ...sources.flatMap((source) => [source.submission_id ?? "", source.source_ref ?? ""]),
    ...outputs.flatMap((output) => [output.doc_id ?? "", output.artifact?.title ?? "", output.artifact?.path ?? ""]),
  ].some((value) => value.toLowerCase().includes(query)));
  if (rows.length === 0) return <EmptyState icon={Sparkles} title={query ? t(($) => $.knowledge.no_results) : t(($) => $.knowledge.runs_empty)} />;
  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-md border">
        <div className="hidden h-8 grid-cols-[minmax(230px,1.2fr)_minmax(145px,.7fr)_minmax(150px,.8fr)_minmax(220px,1.3fr)_120px] items-center gap-3 border-b bg-muted/20 px-4 text-xs text-muted-foreground lg:grid">
          <span>{t(($) => $.knowledge.run_origin)}</span>
          <span>{t(($) => $.knowledge.raw_agent)}</span>
          <span>{t(($) => $.knowledge.run_inputs)}</span>
          <span>{t(($) => $.knowledge.run_outputs)}</span>
          <span className="text-right">{t(($) => $.knowledge.raw_status)}</span>
        </div>
        {rows.map(({ run, sources, outputs }) => {
          const agentName = run.agent?.name || (run.agent_id ? getAgentName(run.agent_id) : t(($) => $.knowledge.provenance_manual));
          const provenance = run.provenance;
          const repositoryLabel = provenance?.repository_name || provenance?.repository_id || run.repository_id;
          const modeLabel = (() => {
            switch (run.mode) {
              case "repository_update": return t(($) => $.knowledge.run_mode_repository_update);
              case "issue_ingest": return t(($) => $.knowledge.run_mode_issue_ingest);
              case "memory_curate": return t(($) => $.knowledge.run_mode_memory_curate);
              default: return run.mode;
            }
          })();
          const triggerLabel = (() => {
            switch (provenance?.event_type ?? provenance?.automation_source) {
              case "change.merged": return t(($) => $.knowledge.run_trigger_change_merged);
              case "default_branch.updated": return t(($) => $.knowledge.run_trigger_default_branch);
              case "schedule": return t(($) => $.knowledge.run_trigger_schedule);
              case "manual": return t(($) => $.knowledge.run_trigger_manual);
              default: return provenance?.event_type || provenance?.automation_source || t(($) => $.knowledge.run_trigger_unknown);
            }
          })();
          return (
            <article key={run.id} className="border-b px-4 py-3 last:border-b-0">
              <div className="grid gap-3 lg:grid-cols-[minmax(230px,1.2fr)_minmax(145px,.7fr)_minmax(150px,.8fr)_minmax(220px,1.3fr)_120px] lg:items-start">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                    {repositoryLabel ? <GitFork className="size-3.5 shrink-0 text-muted-foreground" /> : <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />}
                    {repositoryLabel ? (
                      <span className="truncate" title={repositoryLabel}>{repositoryLabel}</span>
                    ) : provenance ? (
                      <AppLink href={paths.autopilotDetail(provenance.automation_id)} className="truncate hover:underline">
                        {provenance.automation_title || provenance.automation_id}
                      </AppLink>
                    ) : <span className="truncate" title={run.id}>{run.id}</span>}
                  </div>
                  {repositoryLabel && provenance && (
                    <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <Sparkles className="size-3 shrink-0" />
                      <AppLink href={paths.autopilotDetail(provenance.automation_id)} className="truncate hover:underline">
                        {provenance.automation_title || provenance.automation_id}
                      </AppLink>
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge variant="outline" className="font-normal">{modeLabel}</Badge>
                    <Badge variant="secondary" className="font-normal">{triggerLabel}</Badge>
                  </div>
                  <div className="mt-1.5 min-w-0 text-xs text-muted-foreground">
                    {provenance?.change_number !== null && provenance?.change_number !== undefined ? (
                      <span className="flex min-w-0 items-center gap-1">
                        <GitPullRequest className="size-3 shrink-0" />
                        {provenance.change_url ? (
                          <a href={provenance.change_url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                            #{provenance.change_number}{provenance.change_title ? ` ${provenance.change_title}` : ""}
                          </a>
                        ) : <span className="truncate">#{provenance.change_number}{provenance.change_title ? ` ${provenance.change_title}` : ""}</span>}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 min-w-0 text-xs text-muted-foreground">
                    {provenance?.target_branch || provenance?.source_revision ? (
                      <span className="flex min-w-0 items-center gap-1">
                        <GitBranch className="size-3 shrink-0" />
                        <span className="truncate">
                          {[provenance.target_branch, provenance.source_revision?.slice(0, 7)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="min-w-0 text-xs">
                  <div className="flex items-center gap-1.5"><ActorAvatar actorType={run.agent_id ? "agent" : "system"} actorId={run.agent_id ?? "manual"} size={16} /><span className="truncate">{agentName}</span></div>
                  <div className="mt-1 flex items-center gap-1 text-muted-foreground"><Clock3 className="size-3" />{run.created_at ? formatRelativeDate(run.created_at) : "--"}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">{t(($) => $.knowledge.run_inputs)} · {sources.length}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {sources.length > 0 ? sources.map((source) => <Badge key={source.id} variant="outline" className="max-w-44 truncate font-mono font-normal">{source.submission_id || source.source_ref || source.source_type}</Badge>) : <span className="text-xs text-muted-foreground">--</span>}
                  </div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">{t(($) => $.knowledge.run_outputs)} · {outputs.length}</div>
                  <div className="mt-1 space-y-1">
                    {outputs.length > 0 ? outputs.map((output) => (
                      <div key={output.id} className="flex min-w-0 items-center gap-1.5 text-xs">
                        <Badge variant="outline" className="shrink-0 font-normal">{output.action}</Badge>
                        <span className="truncate" title={output.artifact?.path || output.doc_id || output.action}>{output.artifact?.title || output.artifact?.path || output.doc_id || output.artifact_scope}</span>
                        {output.version !== null && <span className="shrink-0 text-muted-foreground">{t(($) => $.knowledge.version_short, { version: output.version })}</span>}
                      </div>
                    )) : <span className="text-xs text-muted-foreground">--</span>}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={run.result_summary ?? undefined}>{run.result_summary || run.mode}</p>
                </div>
                <div className="flex items-center gap-2 lg:justify-end">
                  <Badge variant={statusVariant(run.status)} className="w-fit font-normal">{run.status}</Badge>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => setSelected({ run, sources, outputs })}
                  >
                    <span className="hidden xl:inline">{t(($) => $.knowledge.run_view_log)}</span>
                    <ChevronRight className="size-3.5" />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <KnowledgeRunSheet selected={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </div>
  );
}

export function KnowledgePage() {
  const { t } = useT("projects");
  const workspaceId = useWorkspaceId();
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("wiki");
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const needsProjects = activeTab === "wiki" || activeTab === "memory";
  const projectsQuery = useQuery({ ...projectListOptions(workspaceId), enabled: Boolean(workspaceId) && needsProjects });
  const docsQuery = useQuery({
    ...workspaceDocListOptions(workspaceId, { includeBody: Boolean(search.trim()) }),
    enabled: Boolean(workspaceId) && activeTab === "wiki",
  });
  const memoryDocsQuery = useQuery({
    ...workspaceDocListOptions(workspaceId, { kind: "memory", includeBody: true }),
    enabled: Boolean(workspaceId) && activeTab === "memory",
  });
  const repositoriesQuery = useQuery({ ...repositoryListOptions(workspaceId), enabled: Boolean(workspaceId) && activeTab === "wiki" });
  const repositoryWikiQuery = useQuery({ ...repositoryWikiSummariesOptions(workspaceId), enabled: Boolean(workspaceId) && activeTab === "wiki" });
  const submissionsQuery = useQuery({ ...knowledgeSubmissionsOptions(workspaceId), enabled: Boolean(workspaceId) && activeTab === "raw" });
  const runsQuery = useQuery({ ...knowledgeRunsOptions(workspaceId), enabled: Boolean(workspaceId) && activeTab === "runs" });
  const projects = projectsQuery.data ?? [];
  const docs = docsQuery.data ?? [];
  const memoryDocs = memoryDocsQuery.data ?? [];
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const summaries = repositoryWikiQuery.data ?? [];
  const submissions = submissionsQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const formalMemoryCount = memoryDocs.length;
  const formalWikiCount = docs.filter((doc) => doc.kind === "wiki" && doc.slug !== "_schema").length
    + summaries.reduce((total, summary) => total + summary.page_count, 0);
  const counts: Record<KnowledgeTab, number | undefined> = {
    wiki: docsQuery.data && repositoryWikiQuery.data ? formalWikiCount : undefined,
    raw: submissionsQuery.data ? submissions.length : undefined,
    memory: memoryDocsQuery.data ? formalMemoryCount : undefined,
    runs: runsQuery.data ? runs.length : undefined,
  };
  const total = counts[activeTab];
  const wikiPending = projectsQuery.isPending || docsQuery.isPending || repositoriesQuery.isPending || repositoryWikiQuery.isPending;
  const wikiError = projectsQuery.error ?? docsQuery.error ?? repositoriesQuery.error ?? repositoryWikiQuery.error;
  const memoryPending = projectsQuery.isPending || memoryDocsQuery.isPending;
  const memoryError = projectsQuery.error ?? memoryDocsQuery.error;
  const panelPending = activeTab === "raw" ? submissionsQuery.isPending : activeTab === "runs" ? runsQuery.isPending : activeTab === "memory" ? memoryPending : wikiPending;
  const panelError = activeTab === "raw" ? submissionsQuery.error : activeTab === "runs" ? runsQuery.error : activeTab === "memory" ? memoryError : wikiError;
  const retry = () => {
    if (activeTab === "raw") void submissionsQuery.refetch();
    else if (activeTab === "runs") void runsQuery.refetch();
    else if (activeTab === "memory") {
      void projectsQuery.refetch();
      void memoryDocsQuery.refetch();
    } else {
      void projectsQuery.refetch();
      void docsQuery.refetch();
      void repositoriesQuery.refetch();
      void repositoryWikiQuery.refetch();
    }
  };
  const placeholder = activeTab === "raw"
    ? t(($) => $.knowledge.raw_search_placeholder)
    : activeTab === "runs"
      ? t(($) => $.knowledge.runs_search_placeholder)
      : activeTab === "memory"
        ? t(($) => $.knowledge.memory_search_placeholder)
        : t(($) => $.knowledge.wiki_search_placeholder);

  return (
    <KnowledgeShell count={total}>
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setActiveTab(value as KnowledgeTab);
          setSearch("");
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex min-h-12 shrink-0 flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:items-center sm:py-0">
          <div className="overflow-x-auto pb-1 sm:pb-0">
            <TabsList variant="line" aria-label={t(($) => $.knowledge.views_label)}>
              <TabsTrigger value="wiki" className="px-3"><BookOpen />{t(($) => $.knowledge.tab_wiki)}{counts.wiki !== undefined && <span className="tabular-nums text-muted-foreground">{counts.wiki}</span>}</TabsTrigger>
              <TabsTrigger value="raw" className="px-3"><FileInput />{t(($) => $.knowledge.tab_raw)}{counts.raw !== undefined && <span className="tabular-nums text-muted-foreground">{counts.raw}</span>}</TabsTrigger>
              <TabsTrigger value="memory" className="px-3"><Brain />{t(($) => $.knowledge.tab_memory)}{counts.memory !== undefined && <span className="tabular-nums text-muted-foreground">{counts.memory}</span>}</TabsTrigger>
              <TabsTrigger value="runs" className="px-3"><Sparkles />{t(($) => $.knowledge.tab_runs)}{counts.runs !== undefined && <span className="tabular-nums text-muted-foreground">{counts.runs}</span>}</TabsTrigger>
            </TabsList>
          </div>
          <div className="relative min-w-0 flex-1 sm:ml-auto sm:max-w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={placeholder} className="h-8 w-full pl-8 text-sm" />
          </div>
          {activeTab === "wiki" && (
            <Button type="button" variant="outline" size="sm" className="shrink-0" aria-label={sortOrder === "newest" ? t(($) => $.knowledge.sort_newest) : t(($) => $.knowledge.sort_oldest)} onClick={() => setSortOrder((current) => current === "newest" ? "oldest" : "newest") }>
              <ArrowDownUp className="size-3.5" /><span className="hidden lg:inline">{sortOrder === "newest" ? t(($) => $.knowledge.sort_newest) : t(($) => $.knowledge.sort_oldest)}</span>
            </Button>
          )}
        </div>

        {panelPending ? <LoadingPane /> : panelError ? <ErrorPane error={panelError} retry={retry} /> : (
          <>
            <TabsContent value="wiki" className="min-h-0 overflow-y-auto"><WikiPane projects={projects} docs={docs} repositories={repositories} summaries={summaries} search={search} sortOrder={sortOrder} /></TabsContent>
            <TabsContent value="raw" className="min-h-0 overflow-y-auto"><RawPane submissions={submissions} search={search} /></TabsContent>
            <TabsContent value="memory" className="min-h-0 overflow-y-auto"><MemoryPane projects={projects} docs={memoryDocs} search={search} /></TabsContent>
            <TabsContent value="runs" className="min-h-0 overflow-y-auto"><RunPane runs={runs} search={search} /></TabsContent>
          </>
        )}
      </Tabs>
    </KnowledgeShell>
  );
}
