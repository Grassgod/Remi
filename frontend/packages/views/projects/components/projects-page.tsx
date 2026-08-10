"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Archive,
  FolderKanban,
  LayoutGrid,
  Plus,
  RotateCcw,
  Rows3,
  Search,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { projectListOptions } from "@multiremi/core/projects/queries";
import {
  useArchiveProject,
  useRestoreProject,
  useUpdateProject,
} from "@multiremi/core/projects/mutations";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useModalStore } from "@multiremi/core/modals";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { AppLink } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import type { Project, UpdateProjectRequest } from "@multiremi/core/types";
import { PageHeader } from "../../layout/page-header";
import { ProjectIcon } from "./project-icon";
import { useT } from "../../i18n";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useFormatRelativeDate } from "./labels";
import { useProjectViewStore } from "@multiremi/core/projects";
import { ProjectLeadPicker } from "./project-lead-picker";

type ProjectScope = "active" | "archived";

const COMPACT_GRID =
  "grid w-full grid-cols-[24px_minmax(160px,1fr)_80px] sm:min-w-[700px] sm:grid-cols-[24px_minmax(220px,1fr)_140px_150px_96px_80px]";

function IssueCompletion({ project, compact = false }: { project: Project; compact?: boolean }) {
  const { t } = useT("projects");
  const percentage = project.issue_count > 0
    ? Math.round((project.done_count / project.issue_count) * 100)
    : 0;

  if (project.issue_count === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t(($) => $.detail.no_issues_yet)}
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn("relative shrink-0", compact ? "size-4" : "size-5")}>
        <svg className="size-full -rotate-90" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="text-muted" strokeWidth="2" stroke="currentColor" fill="none" r="6" cx="8" cy="8" />
          <circle
            className="text-success"
            strokeWidth="2"
            stroke="currentColor"
            fill="none"
            r="6"
            cx="8"
            cy="8"
            strokeDasharray={`${percentage * 0.377} 37.7`}
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="min-w-0 text-xs tabular-nums">
        <span className="font-medium text-foreground">{project.done_count}/{project.issue_count}</span>
        {!compact && (
          <span className="ml-1 text-muted-foreground">
            {t(($) => $.table.issue_completion_suffix)}
          </span>
        )}
      </span>
    </span>
  );
}

function ProjectOwner({ project }: { project: Project }) {
  const { t } = useT("projects");
  const { getActorName } = useActorName();
  if (!project.lead_type || !project.lead_id) {
    return <span className="text-xs text-muted-foreground">{t(($) => $.lead.no_lead)}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <ActorAvatar actorType={project.lead_type} actorId={project.lead_id} size={20} enableHoverCard />
      <span className="truncate text-xs text-muted-foreground">
        {getActorName(project.lead_type, project.lead_id)}
      </span>
    </span>
  );
}

function ProjectLifecycleAction({
  project,
  onArchive,
  onRestore,
}: {
  project: Project;
  onArchive: (project: Project) => void;
  onRestore: (project: Project) => void;
}) {
  const { t } = useT("projects");
  const archived = !!project.archived_at;
  return (
    <Button
      type="button"
      variant={archived ? "outline" : "ghost"}
      size={archived ? "sm" : "icon-sm"}
      className={cn(
        "justify-self-end",
        !archived && "text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
      )}
      title={archived ? t(($) => $.page.restore_project) : t(($) => $.page.archive_project)}
      onClick={() => archived ? onRestore(project) : onArchive(project)}
    >
      {archived ? <RotateCcw /> : <Archive />}
      {archived && <span>{t(($) => $.page.restore)}</span>}
    </Button>
  );
}

function ProjectCard({
  project,
  onArchive,
}: {
  project: Project;
  onArchive: (project: Project) => void;
}) {
  const { t } = useT("projects");
  const wsPaths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const updateProject = useUpdateProject();
  const handleUpdate = useCallback(
    (data: UpdateProjectRequest) => updateProject.mutate({ id: project.id, ...data }),
    [project.id, updateProject],
  );

  return (
    <article className="group flex min-h-36 flex-col rounded-md border bg-card transition-colors hover:bg-accent/20">
      <div className="flex items-start gap-3 p-3">
        <ProjectIcon project={project} size="md" />
        <div className="min-w-0 flex-1">
          <AppLink href={wsPaths.projectDetail(project.id)} className="block truncate text-sm font-medium hover:underline">
            {project.title}
          </AppLink>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.repo_source.footer_count, { count: project.resource_count })}
          </p>
        </div>
        <ProjectLifecycleAction project={project} onArchive={onArchive} onRestore={() => {}} />
      </div>
      <div className="px-3 pb-3">
        <IssueCompletion project={project} />
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 border-t px-3 py-2.5">
        <ProjectLeadPicker
          project={project}
          handleUpdate={handleUpdate}
          renderTrigger={(leadName) => (
            <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent">
              {project.lead_type && project.lead_id ? (
                <ActorAvatar actorType={project.lead_type} actorId={project.lead_id} size={20} enableHoverCard />
              ) : (
                <span className="size-5 rounded-full border border-dashed border-muted-foreground/30" />
              )}
              <span className="max-w-24 truncate">{leadName ?? t(($) => $.lead.no_lead)}</span>
            </button>
          )}
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatRelativeDate(project.updated_at)}
        </span>
      </div>
    </article>
  );
}

function ProjectCompactRow({
  project,
  onArchive,
  onRestore,
}: {
  project: Project;
  onArchive: (project: Project) => void;
  onRestore: (project: Project) => void;
}) {
  const { t } = useT("projects");
  const wsPaths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const updateProject = useUpdateProject();
  const archived = !!project.archived_at;
  const handleUpdate = useCallback(
    (data: UpdateProjectRequest) => updateProject.mutate({ id: project.id, ...data }),
    [project.id, updateProject],
  );

  return (
    <div className={cn(COMPACT_GRID, "group min-h-12 items-center gap-3 border-b px-4 text-sm transition-colors hover:bg-accent/30", archived && "text-muted-foreground opacity-70 hover:opacity-100")}>
      <ProjectIcon project={project} size="sm" />
      <AppLink href={wsPaths.projectDetail(project.id)} className="min-w-0">
        <span className="block truncate text-left font-medium text-foreground">{project.title}</span>
        <span className="block truncate text-left text-xs text-muted-foreground">
          {project.resource_count > 0
            ? t(($) => $.repo_source.footer_count, { count: project.resource_count })
            : ""}
        </span>
      </AppLink>
      <div className="hidden sm:block"><IssueCompletion project={project} compact /></div>
      <div className="hidden min-w-0 sm:block">
        {archived ? (
          <ProjectOwner project={project} />
        ) : (
          <ProjectLeadPicker
            project={project}
            handleUpdate={handleUpdate}
            align="start"
            renderTrigger={(leadName) => (
              <button type="button" className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent">
                {project.lead_type && project.lead_id ? (
                  <ActorAvatar actorType={project.lead_type} actorId={project.lead_id} size={20} enableHoverCard />
                ) : (
                  <span className="size-5 rounded-full border border-dashed border-muted-foreground/30" />
                )}
                <span className="truncate text-xs text-muted-foreground">{leadName ?? "--"}</span>
              </button>
            )}
          />
        )}
      </div>
      <span className="hidden text-left text-xs text-muted-foreground tabular-nums sm:block">
        {formatRelativeDate(archived ? project.archived_at! : project.updated_at)}
      </span>
      <ProjectLifecycleAction project={project} onArchive={onArchive} onRestore={onRestore} />
    </div>
  );
}

export function ProjectsPage() {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const viewMode = useProjectViewStore((state) => state.viewMode);
  const setViewMode = useProjectViewStore((state) => state.setViewMode);
  const { data: projects = [], isLoading } = useQuery(projectListOptions(wsId));
  const archiveProject = useArchiveProject();
  const restoreProject = useRestoreProject();
  const [scope, setScope] = useState<ProjectScope>("active");
  const [search, setSearch] = useState("");

  const activeProjects = useMemo(() => projects.filter((project) => !project.archived_at), [projects]);
  const archivedProjects = useMemo(() => projects.filter((project) => !!project.archived_at), [projects]);
  const scopedProjects = scope === "active" ? activeProjects : archivedProjects;
  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return scopedProjects;
    return scopedProjects.filter((project) =>
      project.title.toLowerCase().includes(query) || matchesPinyin(project.title, query),
    );
  }, [scopedProjects, search]);
  const isCompact = scope === "archived" || viewMode === "compact";

  const openCreateProject = () => useModalStore.getState().open("create-project");
  const handleArchive = (project: Project) => {
    archiveProject.mutate(project.id, {
      onSuccess: () => toast.success(t(($) => $.detail.toast_project_archived)),
      onError: () => toast.error(t(($) => $.detail.toast_project_archive_failed)),
    });
  };
  const handleRestore = (project: Project) => {
    restoreProject.mutate(project.id, {
      onSuccess: () => toast.success(t(($) => $.detail.toast_project_restored)),
      onError: () => toast.error(t(($) => $.detail.toast_project_restore_failed)),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="justify-between px-5">
        <div className="flex items-center gap-2">
          <FolderKanban className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">{t(($) => $.page.title)}</h1>
          {!isLoading && <span className="text-xs tabular-nums text-muted-foreground">{activeProjects.length}</span>}
        </div>
        <Button size="sm" variant="outline" onClick={openCreateProject}>
          <Plus />
          {t(($) => $.page.new_project)}
        </Button>
      </PageHeader>

      <div className="flex h-11 shrink-0 items-end gap-5 border-b px-5">
        {(["active", "archived"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={cn(
              "relative h-11 text-xs text-muted-foreground transition-colors hover:text-foreground",
              scope === value && "font-medium text-foreground after:absolute after:inset-x-0 after:bottom-[-1px] after:h-0.5 after:bg-foreground",
            )}
            onClick={() => { setScope(value); setSearch(""); }}
          >
            {value === "active" ? t(($) => $.page.active_projects) : t(($) => $.page.archived_projects)}
            <span className="ml-1.5 tabular-nums text-muted-foreground">
              {value === "active" ? activeProjects.length : archivedProjects.length}
            </span>
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {(projects.length > 0 || isLoading) && (
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
            <div className="relative flex-1 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={scope === "active" ? t(($) => $.page.search_active) : t(($) => $.page.search_archived)}
                className="h-8 w-full pl-8 text-sm sm:w-64"
              />
            </div>
            {scope === "active" && (
              <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
                <button
                  type="button"
                  title={t(($) => $.page.view_compact)}
                  onClick={() => setViewMode("compact")}
                  className={cn("rounded p-1.5 text-muted-foreground", viewMode === "compact" && "bg-background text-foreground shadow-sm")}
                >
                  <Rows3 className="size-3.5" />
                </button>
                <button
                  type="button"
                  title={t(($) => $.page.view_comfortable)}
                  onClick={() => setViewMode("comfortable")}
                  className={cn("rounded p-1.5 text-muted-foreground", viewMode === "comfortable" && "bg-background text-foreground shadow-sm")}
                >
                  <LayoutGrid className="size-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        <div className={cn("min-h-0 flex-1", isCompact ? "flex flex-col overflow-hidden" : "overflow-y-auto")}>
          {isLoading ? (
            <div className="mx-5 mt-4 overflow-hidden rounded-md border">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="flex h-12 items-center gap-3 border-b px-4 last:border-b-0">
                  <Skeleton className="size-6 rounded" />
                  <Skeleton className="h-4 w-48" />
                </div>
              ))}
            </div>
          ) : scopedProjects.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-24 text-muted-foreground">
              {scope === "active" ? <FolderKanban className="mb-3 size-10 opacity-30" /> : <Archive className="mb-3 size-10 opacity-30" />}
              <p className="text-sm">{scope === "active" ? t(($) => $.page.empty) : t(($) => $.page.archived_empty)}</p>
              {scope === "active" && (
                <Button size="sm" variant="outline" className="mt-3" onClick={openCreateProject}>
                  {t(($) => $.page.create_first)}
                </Button>
              )}
            </div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center py-24 text-muted-foreground">
              <Search className="mb-3 size-10 opacity-30" />
              <p className="text-sm">{t(($) => $.page.no_search_results)}</p>
            </div>
          ) : isCompact ? (
            <div className="m-5 min-h-0 flex-1 overflow-auto rounded-md border">
              <div>
                <div className={cn(COMPACT_GRID, "sticky top-0 z-10 h-8 items-center gap-3 border-b bg-muted/30 px-4 text-xs font-medium text-muted-foreground")}>
                  <span />
                  <span>{t(($) => $.table.name)}</span>
                  <span className="hidden sm:block">{t(($) => $.table.issue_completion)}</span>
                  <span className="hidden sm:block">{t(($) => $.table.lead)}</span>
                  <span className="hidden sm:block">{scope === "active" ? t(($) => $.table.updated) : t(($) => $.table.archived)}</span>
                  <span />
                </div>
                {filteredProjects.map((project) => (
                  <ProjectCompactRow key={project.id} project={project} onArchive={handleArchive} onRestore={handleRestore} />
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
              {filteredProjects.map((project) => (
                <ProjectCard key={project.id} project={project} onArchive={handleArchive} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
