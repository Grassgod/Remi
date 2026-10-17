"use client";

import type { ReactElement } from "react";
import { Check, ChevronDown, Folder, FolderKanban, FolderOpen, Monitor, Sparkles } from "lucide-react";
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
export function WorkLocationPicker({ wsId, projectId = null, value, onChange, disabled = false, readOnly = false, projectsEnabled = true, includeProjects = true, triggerRender, wrapLabel = false, surface = "task" }: {
  wsId: string;
  projectId?: string | null;
  value: string | null;
  onChange: (location: WorkLocation) => void;
  disabled?: boolean;
  /** A started Chat shows its fixed location as a chip with the locked hint, not a menu. */
  readOnly?: boolean;
  /** Hidden callers keep cached project labels without fetching candidates. */
  projectsEnabled?: boolean;
  includeProjects?: boolean;
  triggerRender?: ReactElement;
  /** Detail sidebars use the full value column and show long names on multiple lines. */
  wrapLabel?: boolean;
  /**
   * Chat sits in the composer footer and calls its unbound choice 「无项目」,
   * described as pulling no code. Issues keep 「自动安排」, whose runs may
   * still prepare repositories.
   */
  surface?: "task" | "chat";
}) {
  const { t } = useT("runtimes");
  const chat = surface === "chat";
  const directories = useQuery(runtimeWorkspacesOptions(wsId));
  const projects = useQuery({ ...projectListOptions(wsId), enabled: projectsEnabled && Boolean(wsId) && includeProjects });
  const runtimes = useQuery(runtimeListOptions(wsId));
  const selected = directories.data?.find(w => w.id === value);
  const project = projects.data?.find(p => p.id === projectId);
  const machine = (daemonId: string) => {
    const runtime = runtimes.data?.find(r => r.daemon_id === daemonId);
    return runtime?.device_info?.split(" · ")[0] || runtime?.name || t($ => $.location.machine_unknown);
  };
  const unbound = !value && !projectId;
  const unassigned = t($ => chat ? $.location.chat_unassigned : $.location.unassigned);
  const path = selected && (runtimeWorkspaceDirectory(selected.root_path, selected.cwd) || selected.root_path);
  const label = value ? selected?.name || t($ => $.location.directory_missing)
    : projectId ? project?.title || t($ => $.location.project_missing) : unassigned;
  const detail = selected ? `${machine(selected.daemon_id)} · ${path}`
    : project?.title ?? (chat && unbound ? t($ => $.location.chat_unassigned_detail) : undefined);
  // Chat's trigger can collapse to its icon, so its tooltip always leads with the name.
  const summary = chat ? [label, detail !== label ? detail : null].filter(Boolean).join("\n") : detail || label;
  const icon = value ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
    : project ? <ProjectIcon project={project} size="sm" />
      : chat && unbound ? <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        : <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />;
  // Chat: the short unbound label never truncates and names truncate within
  // the cap. The label hides, leaving the icon, when the composer footer's
  // `@container` is too narrow for it.
  const wrapperClass = wrapLabel ? "w-full min-w-0" : chat ? `${unbound ? "shrink-0" : "min-w-0"} max-w-48` : "min-w-0 max-w-full";
  const labelClass = wrapLabel ? "min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]"
    : chat ? "min-w-0 truncate @max-[14rem]:hidden" : "min-w-0 truncate";
  const offlineDot = selected?.status !== "available" && value
    && <span aria-label={t($ => $.workspaces.unavailable)} className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />;
  if (readOnly) {
    return <div className={wrapperClass}>
      <span role="group" aria-label={`${t($ => $.location.label)}: ${label}`} title={`${summary}\n${t($ => $.location.locked)}`}
        className="flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
        {icon}<span className={labelClass}>{label}</span>{offlineDot}
      </span>
    </div>;
  }
  // No negative margin outside the full-width sidebar: a shrink-to-fit wrapper
  // is as wide as the trigger's margin box, and `max-w-full` would then cap the
  // trigger short of its own label.
  const triggerClass = triggerRender ? "max-w-full"
    : chat ? "flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-left outline-none transition-colors hover:bg-accent aria-expanded:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
      : `flex ${wrapLabel ? "w-full min-w-0 -mx-1" : "max-w-full"} items-center gap-1.5 rounded-md px-1 py-1 text-xs text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default`;
  return <div className={wrapperClass}>
    <DropdownMenu>
      <DropdownMenuTrigger render={triggerRender} disabled={disabled}
        aria-label={`${t($ => $.location.label)}: ${label}`}
        title={disabled ? `${summary}\n${t($ => $.location.locked)}` : summary}
        className={triggerClass}>
        {icon}
        <span className={labelClass}>{label}</span>
        {offlineDot}
        {!disabled && <ChevronDown className="size-3 shrink-0 text-muted-foreground" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={chat ? "top" : "bottom"} className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="px-2.5 py-2"><p className="text-xs font-medium">{t($ => $.location.label)}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t($ => chat ? $.location.chat_location_hint : includeProjects ? $.location.hint : $.location.chat_hint)}</p></div>
        {chat ? <DropdownMenuItem className="items-start gap-2.5 px-2.5 py-2" onClick={() => onChange({ project_id: null, runtime_workspace_id: null })}>
          <Folder className="mt-0.5 size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-xs font-medium">{unassigned}</span>
            <span className="block text-[11px] leading-4 text-muted-foreground">{t($ => $.location.chat_unassigned_detail)}</span>
          </span>{unbound && <Check className="mt-0.5 size-3.5" />}
        </DropdownMenuItem> : <DropdownMenuItem className="gap-2.5 px-2.5 py-2" onClick={() => onChange({ project_id: null, runtime_workspace_id: null })}>
          <Sparkles className="size-4 text-muted-foreground" /><span className="flex-1 text-xs">{unassigned}</span>{unbound && <Check className="size-3.5" />}
        </DropdownMenuItem>}
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
