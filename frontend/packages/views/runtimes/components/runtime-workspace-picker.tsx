"use client";

import type { ReactElement } from "react";
import { Check, ChevronDown, FolderKanban, FolderOpen, Monitor, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { runtimeWorkspacesOptions } from "@multiremi/core/runtimes/workspaces";
import { runtimeListOptions } from "@multiremi/core/runtimes/queries";
import { runtimeWorkspaceDirectory } from "@multiremi/core/runtimes";
import { projectListOptions } from "@multiremi/core/projects/queries";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@multiremi/ui/components/ui/dropdown-menu";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useT } from "../../i18n";

export interface WorkLocation {
  project_id: string | null;
  runtime_workspace_id: string | null;
}

/** One assignment slot. Selecting either kind replaces the other atomically. */
export function WorkLocationPicker({ wsId, projectId = null, value, onChange, disabled = false, includeProjects = true, triggerRender }: {
  wsId: string;
  projectId?: string | null;
  value: string | null;
  onChange: (location: WorkLocation) => void;
  disabled?: boolean;
  includeProjects?: boolean;
  triggerRender?: ReactElement;
}) {
  const { t } = useT("runtimes");
  const directories = useQuery(runtimeWorkspacesOptions(wsId));
  const projects = useQuery({ ...projectListOptions(wsId), enabled: Boolean(wsId) && includeProjects });
  const runtimes = useQuery(runtimeListOptions(wsId));
  const selected = directories.data?.find(w => w.id === value);
  const project = projects.data?.find(p => p.id === projectId);
  const machine = (daemonId: string) => {
    const runtime = runtimes.data?.find(r => r.daemon_id === daemonId);
    return runtime?.device_info?.split(" · ")[0] || runtime?.name || t($ => $.location.machine_unknown);
  };
  const path = selected && (runtimeWorkspaceDirectory(selected.root_path, selected.cwd) || selected.root_path);
  const label = value ? selected?.name || t($ => $.location.directory_missing)
    : projectId ? project?.title || t($ => $.location.project_missing) : t($ => $.location.unassigned);
  const detail = selected ? `${machine(selected.daemon_id)} · ${path}` : project?.title;
  return <div className="min-w-0 max-w-full">
    <DropdownMenu>
      <DropdownMenuTrigger render={triggerRender} disabled={disabled}
        aria-label={`${t($ => $.location.label)}: ${label}`}
        title={disabled ? `${detail || label}\n${t($ => $.location.locked)}` : detail || label}
        className={triggerRender ? "max-w-full" : "flex max-w-full items-center gap-1.5 rounded-md px-1 py-1 -mx-1 text-xs text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"}>
        {value ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" /> : project ? <ProjectIcon project={project} size="sm" /> : <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 truncate">{label}</span>
        {selected?.status !== "available" && value && <span aria-label={t($ => $.workspaces.unavailable)} className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />}
        {!disabled && <ChevronDown className="size-3 shrink-0 text-muted-foreground" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="px-2.5 py-2"><p className="text-xs font-medium">{t($ => $.location.label)}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t($ => includeProjects ? $.location.hint : $.location.chat_hint)}</p></div>
        <DropdownMenuItem className="gap-2.5 px-2.5 py-2" onClick={() => onChange({ project_id: null, runtime_workspace_id: null })}>
          <Sparkles className="size-4 text-muted-foreground" /><span className="flex-1 text-xs">{t($ => $.location.unassigned)}</span>{!value && !projectId && <Check className="size-3.5" />}
        </DropdownMenuItem>
        {includeProjects && <><DropdownMenuSeparator /><DropdownMenuGroup>
          <DropdownMenuLabel className="px-2.5 pt-2">{t($ => $.location.projects)}</DropdownMenuLabel>
          {projects.isPending ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{t($ => $.location.loading)}</p>
            : projects.isError ? <p role="alert" className="px-2.5 py-2 text-xs text-destructive">{t($ => $.location.projects_failed)}</p>
            : projects.data?.filter(p => !p.archived_at).length ? projects.data.filter(p => !p.archived_at).map(p => <DropdownMenuItem key={p.id} className="gap-2.5 px-2.5 py-2" onClick={() => onChange({ project_id: p.id, runtime_workspace_id: null })}>
              <ProjectIcon project={p} size="sm" /><span className="min-w-0 flex-1 truncate text-xs">{p.title}</span>{p.id === projectId && !value && <Check className="size-3.5" />}
            </DropdownMenuItem>) : <p className="px-2.5 py-2 text-xs text-muted-foreground">{t($ => $.location.projects_empty)}</p>}
        </DropdownMenuGroup></>}
        <DropdownMenuSeparator /><DropdownMenuGroup>
          <DropdownMenuLabel className="px-2.5 pt-2">{t($ => $.location.directories)}</DropdownMenuLabel>
          {directories.isPending ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{t($ => $.location.loading)}</p>
            : directories.isError ? <p role="alert" className="px-2.5 py-2 text-xs text-destructive">{t($ => $.workspaces.load_failed)}</p>
            : directories.data?.length ? directories.data.map(w => <DropdownMenuItem key={w.id} className="items-start gap-2.5 px-2.5 py-2.5" onClick={() => onChange({ project_id: null, runtime_workspace_id: w.id })}>
              <FolderOpen className="mt-0.5 size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block truncate text-xs font-medium">{w.name}</span>
                <span className="block break-all font-mono text-[11px] leading-4 text-muted-foreground">{runtimeWorkspaceDirectory(w.root_path, w.cwd) || w.root_path}</span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Monitor className="size-3" /><span className="truncate">{machine(w.daemon_id)}</span>{w.status !== "available" && <span className="shrink-0">· {t($ => $.location.offline)}</span>}</span>
              </span>{w.id === value && <Check className="mt-0.5 size-3.5" />}
            </DropdownMenuItem>) : <p className="px-2.5 py-2 text-xs leading-5 text-muted-foreground">{t($ => $.location.directories_empty)}</p>}
        </DropdownMenuGroup>
        {selected?.status === "unavailable" && <p className="border-t px-2.5 py-2 text-xs leading-5 text-muted-foreground">{t($ => $.workspaces.wait_hint)}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

/** Directory-only variant for callers that do not offer Project selection. */
export function RuntimeWorkspacePicker(props: { wsId: string; value: string | null; onChange: (id: string | null) => void; disabled?: boolean }) {
  return <WorkLocationPicker {...props} includeProjects={false} onChange={location => props.onChange(location.runtime_workspace_id)} />;
}
