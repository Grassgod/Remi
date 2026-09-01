"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownUp,
  BookOpen,
  Brain,
  ChevronRight,
  Clock3,
  FileInput,
  Files,
  FolderKanban,
  GitFork,
  Library,
  Search,
  Sparkles,
} from "lucide-react";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multiremi/ui/components/ui/tabs";
import { workspaceDocListOptions } from "@multiremi/core/project-docs";
import { knowledgeRunsOptions, knowledgeSubmissionsOptions } from "@multiremi/core/knowledge";
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
import { useActorName } from "@multiremi/core/workspace/hooks";
import { AppLink } from "../navigation";
import { ActorAvatar } from "../common/actor-avatar";
import { EmptyState } from "../common/empty-state";
import { PageHeader } from "../layout/page-header";
import { ProjectIcon } from "../projects/components/project-icon";
import { MemoryCard } from "../projects/components/wiki/project-wiki-section";
import { useFormatRelativeDate } from "../projects/components/labels";
import { matchesPinyin } from "../editor/extensions/pinyin-match";
import { useT } from "../i18n";

type KnowledgeTab = "wiki" | "raw" | "memory" | "runs";
type SortOrder = "newest" | "oldest";

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
                <p className="mt-1 truncate text-xs text-muted-foreground" title={submission.body}>{submission.body || submission.id}</p>
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
  );
}

function RunPane({ runs, search }: { runs: KnowledgeRunDetail[]; search: string }) {
  const { t } = useT("projects");
  const { getAgentName } = useActorName();
  const formatRelativeDate = useFormatRelativeDate();
  const query = search.trim().toLowerCase();
  const rows = runs.filter(({ run, sources, outputs }) => !query || [
    run.id, run.mode, run.status, run.result_summary ?? "", run.agent?.name ?? run.agent_id ?? "",
    ...run.skill_names, ...sources.flatMap((source) => [source.submission_id ?? "", source.source_ref ?? ""]),
    ...outputs.flatMap((output) => [output.doc_id ?? "", output.artifact?.title ?? "", output.artifact?.path ?? ""]),
  ].some((value) => value.toLowerCase().includes(query)));
  if (rows.length === 0) return <EmptyState icon={Sparkles} title={query ? t(($) => $.knowledge.no_results) : t(($) => $.knowledge.runs_empty)} />;
  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-md border">
        {rows.map(({ run, sources, outputs }) => {
          const agentName = run.agent?.name || (run.agent_id ? getAgentName(run.agent_id) : t(($) => $.knowledge.provenance_manual));
          return (
            <article key={run.id} className="border-b px-4 py-3 last:border-b-0">
              <div className="grid gap-3 lg:grid-cols-[minmax(170px,.8fr)_minmax(150px,.7fr)_minmax(160px,1fr)_minmax(220px,1.4fr)_110px] lg:items-start">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium"><Sparkles className="size-3.5 text-muted-foreground" /><span className="truncate" title={run.id}>{run.id}</span></div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3" />{run.created_at ? formatRelativeDate(run.created_at) : "--"}</div>
                </div>
                <div className="min-w-0 text-xs">
                  <div className="flex items-center gap-1.5"><ActorAvatar actorType={run.agent_id ? "agent" : "system"} actorId={run.agent_id ?? "manual"} size={16} /><span className="truncate">{agentName}</span></div>
                  <div className="mt-1 truncate text-muted-foreground">{run.skill_names.join(", ") || run.mode}</div>
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
                <Badge variant={statusVariant(run.status)} className="w-fit font-normal">{run.status}</Badge>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function KnowledgePage() {
  const { t } = useT("projects");
  const workspaceId = useWorkspaceId();
  const projectsQuery = useQuery(projectListOptions(workspaceId));
  const docsQuery = useQuery(workspaceDocListOptions(workspaceId));
  const repositoriesQuery = useQuery(repositoryListOptions(workspaceId));
  const repositoryWikiQuery = useQuery(repositoryWikiSummariesOptions(workspaceId));
  const submissionsQuery = useQuery(knowledgeSubmissionsOptions(workspaceId));
  const runsQuery = useQuery(knowledgeRunsOptions(workspaceId));
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("wiki");
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const projects = projectsQuery.data ?? [];
  const docs = docsQuery.data ?? [];
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const summaries = repositoryWikiQuery.data ?? [];
  const submissions = submissionsQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const formalMemoryCount = docs.filter((doc) => doc.kind === "memory").length;
  const formalWikiCount = docs.filter((doc) => doc.kind === "wiki" && doc.slug !== "_schema").length
    + summaries.reduce((total, summary) => total + summary.page_count, 0);
  const counts = { wiki: formalWikiCount, raw: submissions.length, memory: formalMemoryCount, runs: runs.length };
  const total = counts[activeTab];
  const basePending = projectsQuery.isPending || docsQuery.isPending || repositoriesQuery.isPending || repositoryWikiQuery.isPending;
  const baseError = projectsQuery.error ?? docsQuery.error ?? repositoriesQuery.error ?? repositoryWikiQuery.error;
  const panelPending = activeTab === "raw" ? submissionsQuery.isPending : activeTab === "runs" ? runsQuery.isPending : basePending;
  const panelError = activeTab === "raw" ? submissionsQuery.error : activeTab === "runs" ? runsQuery.error : baseError;
  const retry = () => {
    if (activeTab === "raw") void submissionsQuery.refetch();
    else if (activeTab === "runs") void runsQuery.refetch();
    else {
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
              <TabsTrigger value="wiki" className="px-3"><BookOpen />{t(($) => $.knowledge.tab_wiki)}<span className="tabular-nums text-muted-foreground">{counts.wiki}</span></TabsTrigger>
              <TabsTrigger value="raw" className="px-3"><FileInput />{t(($) => $.knowledge.tab_raw)}<span className="tabular-nums text-muted-foreground">{counts.raw}</span></TabsTrigger>
              <TabsTrigger value="memory" className="px-3"><Brain />{t(($) => $.knowledge.tab_memory)}<span className="tabular-nums text-muted-foreground">{counts.memory}</span></TabsTrigger>
              <TabsTrigger value="runs" className="px-3"><Sparkles />{t(($) => $.knowledge.tab_runs)}<span className="tabular-nums text-muted-foreground">{counts.runs}</span></TabsTrigger>
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
            <TabsContent value="memory" className="min-h-0 overflow-y-auto"><MemoryPane projects={projects} docs={docs} search={search} /></TabsContent>
            <TabsContent value="runs" className="min-h-0 overflow-y-auto"><RunPane runs={runs} search={search} /></TabsContent>
          </>
        )}
      </Tabs>
    </KnowledgeShell>
  );
}
