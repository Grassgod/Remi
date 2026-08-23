"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowDownUp,
  BookText,
  Brain,
  ChevronRight,
  Files,
  FolderKanban,
  GitFork,
  Library,
  Loader2,
  Bot,
  CheckCircle2,
  Search,
} from "lucide-react";
import { Button, buttonVariants } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { workspaceDocListOptions } from "@multiremi/core/project-docs";
import { projectListOptions } from "@multiremi/core/projects/queries";
import {
  atlasWikiSetupOptions,
  repositoryListOptions,
  repositoryWikiSummariesOptions,
  useConfigureAtlasWiki,
} from "@multiremi/core/repositories";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type { AtlasWikiSetupStatus, Project, RepositoryWikiSummary, WorkspaceDoc, WorkspaceRepository } from "@multiremi/core/types";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { AppLink } from "../navigation";
import { ActorAvatar } from "../common/actor-avatar";
import { EmptyState } from "../common/empty-state";
import { PageHeader } from "../layout/page-header";
import { ProjectIcon } from "../projects/components/project-icon";
import { useFormatRelativeDate } from "../projects/components/labels";
import { matchesPinyin } from "../editor/extensions/pinyin-match";
import { useT } from "../i18n";

type SortOrder = "newest" | "oldest";

interface ProjectKnowledgeRow {
  project: Project;
  docs: WorkspaceDoc[];
  wikiCount: number;
  memoryCount: number;
  latestUpdatedAt: string | null;
}

function matchesDoc(doc: WorkspaceDoc, query: string): boolean {
  return (
    doc.title.toLowerCase().includes(query) ||
    (doc.summary ?? "").toLowerCase().includes(query) ||
    doc.body.toLowerCase().includes(query) ||
    doc.tags.some((tag) => tag.toLowerCase().includes(query))
  );
}

function KnowledgeShell({
  projectCount,
  children,
}: {
  projectCount?: number;
  children: ReactNode;
}) {
  const { t } = useT("projects");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Library className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h1 className="shrink-0 text-sm font-medium">
            {t(($) => $.knowledge.title)}
          </h1>
          {projectCount !== undefined && projectCount > 0 && (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {projectCount}
            </span>
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

function ProjectMaintainer({ project }: { project: Project }) {
  const { getActorName } = useActorName();

  if (!project.lead_type || !project.lead_id) {
    return (
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-5 rounded-full border border-dashed border-muted-foreground/30" />
        --
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <ActorAvatar
        actorType={project.lead_type}
        actorId={project.lead_id}
        size={20}
        profileLink={false}
      />
      <span className="truncate">
        {getActorName(project.lead_type, project.lead_id)}
      </span>
    </span>
  );
}

function Metric({
  icon,
  value,
  label,
}: {
  icon: ReactNode;
  value: number;
  label: string;
}) {
  return (
    <span
      className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
      aria-label={`${label}: ${value}`}
    >
      {icon}
      {value || "--"}
    </span>
  );
}

function ProjectRow({ row }: { row: ProjectKnowledgeRow }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const updatedLabel = row.latestUpdatedAt
    ? formatRelativeDate(row.latestUpdatedAt)
    : t(($) => $.knowledge.never_updated);

  return (
    <AppLink
      href={paths.projectWiki(row.project.id)}
      data-testid={`knowledge-project-${row.project.id}`}
      className="group grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-4 transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-11 sm:grid-cols-[minmax(220px,1fr)_84px_108px_108px_minmax(128px,180px)_20px]"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded border bg-muted/50">
          {row.project.icon ? (
            <ProjectIcon project={row.project} size="sm" />
          ) : (
            <FolderKanban className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {row.project.title}
          </span>
          <span className="mt-1 flex items-center gap-3 sm:hidden">
            <Metric
              icon={<Files className="size-3.5" />}
              value={row.wikiCount}
              label={t(($) => $.knowledge.column_wiki)}
            />
            <Metric
              icon={<Brain className="size-3.5" />}
              value={row.memoryCount}
              label={t(($) => $.knowledge.column_memory)}
            />
          </span>
        </span>
      </span>

      <span className="hidden sm:block">
        <Metric
          icon={<Files className="size-3.5" />}
          value={row.wikiCount}
          label={t(($) => $.knowledge.column_wiki)}
        />
      </span>
      <span className="hidden sm:block">
        <Metric
          icon={<Brain className="size-3.5" />}
          value={row.memoryCount}
          label={t(($) => $.knowledge.column_memory)}
        />
      </span>
      <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
        {updatedLabel}
      </span>
      <span className="hidden min-w-0 sm:block">
        <ProjectMaintainer project={row.project} />
      </span>
      <ChevronRight className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:block" />

      <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground sm:hidden">
        {updatedLabel}
        <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </AppLink>
  );
}

function RepositoryRow({ repository, summary }: { repository: WorkspaceRepository; summary?: RepositoryWikiSummary }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  return (
    <AppLink
      href={paths.repositoryWiki(repository.id)}
      className="group grid min-h-12 grid-cols-[minmax(0,1fr)_auto_20px] items-center gap-3 border-b px-4 last:border-b-0 hover:bg-accent/40"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded border bg-muted/50">
          <GitFork className="size-3.5 text-muted-foreground" />
        </span>
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

function AtlasSetupBar({ status, loading }: { status?: AtlasWikiSetupStatus; loading: boolean }) {
  const { t } = useT("projects");
  const workspaceId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const configure = useConfigureAtlasWiki(workspaceId);

  if (loading) return <div className="border-b px-4 py-2"><Skeleton className="h-8 w-full" /></div>;
  const state = status?.state ?? "not_configured";
  const description = state === "plugin_required"
    ? t(($) => $.knowledge.atlas_plugin_required)
    : state === "scm_connection_required"
      ? t(($) => $.knowledge.atlas_scm_required)
      : state === "ready"
        ? t(($) => $.knowledge.atlas_ready)
        : t(($) => $.knowledge.atlas_description);

  const runConfigure = () => configure.mutate(undefined, {
    onSuccess: (result) => {
      if (result.configured) toast.success(t(($) => $.knowledge.atlas_configured));
      else if (result.scm_warning) toast.warning(result.scm_warning);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t(($) => $.knowledge.atlas_failed)),
  });

  return (
    <div className="flex min-h-12 items-center gap-3 border-b bg-muted/10 px-4 py-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded border bg-background">
        {state === "ready" ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Bot className="size-4 text-muted-foreground" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t(($) => $.knowledge.atlas_title)}</div>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      {state === "plugin_required" ? (
        <AppLink href={paths.plugins()} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.knowledge.atlas_import_plugin)}</AppLink>
      ) : state === "ready" ? (
        <div className="flex items-center gap-2">
          {status?.agent_id && <AppLink href={paths.agentDetail(status.agent_id)} className={buttonVariants({ variant: "ghost", size: "sm" })}>{t(($) => $.knowledge.atlas_agent)}</AppLink>}
          {status?.repository_autopilot_id && <AppLink href={paths.autopilotDetail(status.repository_autopilot_id)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.knowledge.atlas_automation)}</AppLink>}
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={configure.isPending} onClick={runConfigure}>
          {configure.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
          {t(($) => $.knowledge.atlas_configure)}
        </Button>
      )}
    </div>
  );
}

export function KnowledgePage() {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const projectsQuery = useQuery(projectListOptions(wsId));
  const docsQuery = useQuery(workspaceDocListOptions(wsId));
  const repositoriesQuery = useQuery(repositoryListOptions(wsId));
  const repositoryWikiQuery = useQuery(repositoryWikiSummariesOptions(wsId));
  const atlasQuery = useQuery(atlasWikiSetupOptions(wsId));
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);
  const docs = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);
  const repositories = useMemo(
    () => repositoriesQuery.data?.repositories ?? [],
    [repositoriesQuery.data],
  );
  const repositorySummaries = useMemo(
    () => repositoryWikiQuery.data ?? [],
    [repositoryWikiQuery.data],
  );

  const rows = useMemo(() => {
    const docsByProject = new Map<string, WorkspaceDoc[]>();
    for (const doc of docs) {
      if (doc.kind === "wiki" && doc.slug === "_schema") continue;
      const projectDocs = docsByProject.get(doc.project_id);
      if (projectDocs) projectDocs.push(doc);
      else docsByProject.set(doc.project_id, [doc]);
    }

    const query = search.trim().toLowerCase();
    return projects
      .map<ProjectKnowledgeRow>((project) => {
        const projectDocs = docsByProject.get(project.id) ?? [];
        const latestUpdatedAt = projectDocs.reduce<string | null>(
          (latest, doc) =>
            !latest || Date.parse(doc.updated_at) > Date.parse(latest)
              ? doc.updated_at
              : latest,
          null,
        );
        return {
          project,
          docs: projectDocs,
          wikiCount: projectDocs.filter((doc) => doc.kind === "wiki").length,
          memoryCount: projectDocs.filter((doc) => doc.kind === "memory").length,
          latestUpdatedAt,
        };
      })
      .filter(
        (row) =>
          !query ||
          row.project.title.toLowerCase().includes(query) ||
          matchesPinyin(row.project.title, query) ||
          (row.project.description ?? "").toLowerCase().includes(query) ||
          row.docs.some((doc) => matchesDoc(doc, query)),
      )
      .sort((a, b) => {
        if (!a.latestUpdatedAt && !b.latestUpdatedAt) {
          return a.project.title.localeCompare(b.project.title);
        }
        if (!a.latestUpdatedAt) return 1;
        if (!b.latestUpdatedAt) return -1;
        const delta = Date.parse(b.latestUpdatedAt) - Date.parse(a.latestUpdatedAt);
        return sortOrder === "newest" ? delta : -delta;
      });
  }, [docs, projects, search, sortOrder]);

  const repositoryRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const summaries = new Map(repositorySummaries.map((summary) => [summary.repository_id, summary]));
    return repositories
      .filter((repository) => !query || [repository.name, repository.url, repository.description ?? ""].some((value) => value.toLowerCase().includes(query)))
      .map((repository) => ({ repository, summary: summaries.get(repository.id) }));
  }, [repositories, repositorySummaries, search]);

  const isPending = projectsQuery.isPending || docsQuery.isPending || repositoriesQuery.isPending || repositoryWikiQuery.isPending;
  const isError = projectsQuery.isError || docsQuery.isError || repositoriesQuery.isError || repositoryWikiQuery.isError;
  const error = projectsQuery.error ?? docsQuery.error ?? repositoriesQuery.error ?? repositoryWikiQuery.error;

  if (isPending) {
    return (
      <KnowledgeShell>
        <div className="flex h-12 shrink-0 items-center border-b px-4">
          <Skeleton className="h-8 w-64" />
        </div>
        <div className="space-y-2 px-4 py-4" data-testid="knowledge-loading">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-11 w-full" />
          ))}
        </div>
      </KnowledgeShell>
    );
  }

  if (isError) {
    return (
      <KnowledgeShell>
        <EmptyState
          variant="status"
          tone="destructive"
          icon={AlertCircle}
          title={t(($) => $.knowledge.load_error_title)}
          description={
            error instanceof Error
              ? error.message
              : t(($) => $.knowledge.load_error_hint)
          }
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void projectsQuery.refetch();
                void docsQuery.refetch();
                void repositoriesQuery.refetch();
                void repositoryWikiQuery.refetch();
              }}
            >
              {t(($) => $.knowledge.load_error_retry)}
            </Button>
          }
        />
      </KnowledgeShell>
    );
  }

  if (projects.length === 0 && repositories.length === 0) {
    return (
      <KnowledgeShell projectCount={0}>
        <AtlasSetupBar status={atlasQuery.data} loading={atlasQuery.isPending} />
        <EmptyState
          icon={BookText}
          title={t(($) => $.knowledge.empty_title)}
          description={t(($) => $.knowledge.empty_hint)}
        />
      </KnowledgeShell>
    );
  }

  return (
    <KnowledgeShell projectCount={projects.length + repositories.length}>
      <AtlasSetupBar status={atlasQuery.data} loading={atlasQuery.isPending} />
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(($) => $.knowledge.search_placeholder)}
            className="h-8 w-full pl-8 text-sm sm:w-64"
          />
        </div>
        <span className="ml-auto hidden text-xs tabular-nums text-muted-foreground sm:block">
          {rows.length + repositoryRows.length} / {projects.length + repositories.length}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label={
            sortOrder === "newest"
              ? t(($) => $.knowledge.sort_newest)
              : t(($) => $.knowledge.sort_oldest)
          }
          aria-pressed={sortOrder === "oldest"}
          onClick={() =>
            setSortOrder((current) =>
              current === "newest" ? "oldest" : "newest",
            )
          }
        >
          <ArrowDownUp className="size-3.5" />
          <span className="hidden sm:inline">
            {sortOrder === "newest"
              ? t(($) => $.knowledge.sort_newest)
              : t(($) => $.knowledge.sort_oldest)}
          </span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {rows.length === 0 && repositoryRows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t(($) => $.knowledge.no_results)}
          </p>
        ) : (
          <div className="space-y-5">
            {rows.length > 0 && <section>
              <h2 className="mb-2 text-xs font-medium uppercase text-muted-foreground">{t(($) => $.knowledge.projects_group)}</h2>
              <div className="overflow-hidden rounded-md border">
                <div className="hidden h-8 grid-cols-[minmax(220px,1fr)_84px_108px_108px_minmax(128px,180px)_20px] items-center gap-3 border-b bg-muted/20 px-4 text-xs text-muted-foreground sm:grid">
                  <span>{t(($) => $.knowledge.column_project)}</span>
                  <span>{t(($) => $.knowledge.column_wiki)}</span>
                  <span>{t(($) => $.knowledge.column_memory)}</span>
                  <span>{t(($) => $.knowledge.column_updated)}</span>
                  <span>{t(($) => $.knowledge.column_maintainer)}</span>
                  <span />
                </div>
                {rows.map((row) => <ProjectRow key={row.project.id} row={row} />)}
              </div>
            </section>}
            {repositoryRows.length > 0 && <section>
              <h2 className="mb-2 text-xs font-medium uppercase text-muted-foreground">{t(($) => $.knowledge.repositories_group)}</h2>
              <div className="overflow-hidden rounded-md border">
                {repositoryRows.map(({ repository, summary }) => <RepositoryRow key={repository.id} repository={repository} summary={summary} />)}
              </div>
            </section>}
          </div>
        )}
      </div>
    </KnowledgeShell>
  );
}
