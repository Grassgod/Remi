"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderGit,
  FolderKanban,
  FolderOpen,
  GitBranch,
  HardDrive,
  Loader2,
  Search,
  X as XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  AgentRuntime,
  CreateProjectResourceRequest,
  GithubRepoResourceRef,
  LocalDirectoryResourceRef,
  Project,
  ProjectRefResourceRef,
  RuntimeDirectoryCandidate,
} from "@multiremi/core/types";
import {
  resolveRuntimeDirectoryScan,
  runtimeListOptions,
} from "@multiremi/core/runtimes";
import { projectListOptions } from "@multiremi/core/projects/queries";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useCurrentWorkspace } from "@multiremi/core/paths";
import { cn } from "@multiremi/ui/lib/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import { Badge } from "@multiremi/ui/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import { ProjectIcon } from "./project-icon";
import {
  isDesktopShell,
  pickDirectory,
  useLocalDaemonStatus,
  validateLocalDirectory,
} from "../../platform";
import { useT } from "../../i18n";

// Three-source resource picker shared by the create-project modal and the
// project detail sidebar. It's fully controlled: `resources` is the current
// pending/attached set (drives checked state, the project_ref exclusion, and
// the one-local_directory-per-daemon cap), `onAdd` appends, and the optional
// `onRemove` toggles a selection back off (the create flow wires it; the
// detail flow removes via the resource row instead and leaves it undefined,
// so already-attached rows render as disabled).
type SourceTab = "git" | "runtime" | "project";

export interface RepoSourcePopoverProps {
  resources: CreateProjectResourceRequest[];
  onAdd: (resource: CreateProjectResourceRequest) => void;
  onRemove?: (resource: CreateProjectResourceRequest) => void;
  /** Excluded from the project_ref picker so a project can't reference itself. */
  currentProjectId?: string;
  /** Closes the containing popover from the footer's Done button. */
  onClose?: () => void;
}

// Scanning is a machine-level action, so the fleet picker lists computers, not
// runtimes. The device name is the text inside the outermost parens of the
// runtime name pattern "<provider> (<device>)"; fall back to the full name.
function machineLabel(runtime: AgentRuntime): string {
  const open = runtime.name.indexOf("(");
  const close = runtime.name.lastIndexOf(")");
  if (open !== -1 && close > open) {
    return runtime.name.slice(open + 1, close).trim() || runtime.name;
  }
  return runtime.name;
}

// Parent directory of an absolute POSIX path (the fleet daemons are Linux/Mac).
// Returns null when there is no separator to ascend past (e.g. "~").
function parentOf(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  return idx === 0 ? "/" : trimmed.slice(0, idx);
}

// One fleet computer: the runtimes sharing a daemon collapse into a single
// pickable entry. Online when ANY of its runtimes is online; scans/browses run
// against the first online runtime (or the first runtime when all are offline).
interface FleetMachine {
  key: string;
  daemonId: string | null;
  label: string;
  online: boolean;
  scanRuntimeId: string;
}

function groupMachines(runtimes: AgentRuntime[]): FleetMachine[] {
  const order: string[] = [];
  const byKey = new Map<string, FleetMachine>();
  for (const runtime of runtimes) {
    const key = runtime.daemon_id ?? `runtime:${runtime.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        daemonId: runtime.daemon_id,
        label: machineLabel(runtime),
        online: runtime.status === "online",
        scanRuntimeId: runtime.id,
      });
      order.push(key);
    } else if (runtime.status === "online" && !existing.online) {
      // Prefer the first online runtime as the scan target.
      existing.online = true;
      existing.scanRuntimeId = runtime.id;
    }
  }
  return order.map((key) => byKey.get(key)!);
}

function githubRepoResource(url: string): CreateProjectResourceRequest {
  return { resource_type: "github_repo", resource_ref: { url } };
}

// Import mapping (per contract): a candidate with a remote becomes a
// github_repo (parallel worktrees, no per-daemon cap); one without a remote
// becomes a local_directory pinned to the scanned runtime's daemon.
function candidateResource(
  candidate: RuntimeDirectoryCandidate,
  daemonId: string,
): CreateProjectResourceRequest {
  if (candidate.remote_url) {
    return githubRepoResource(candidate.remote_url);
  }
  return {
    resource_type: "local_directory",
    resource_ref: {
      local_path: candidate.path,
      daemon_id: daemonId,
      label: candidate.name,
    },
  };
}

function sameResource(
  a: CreateProjectResourceRequest,
  b: CreateProjectResourceRequest,
): boolean {
  if (a.resource_type !== b.resource_type) return false;
  if (a.resource_type === "github_repo") {
    return (
      (a.resource_ref as GithubRepoResourceRef).url ===
      (b.resource_ref as GithubRepoResourceRef).url
    );
  }
  if (a.resource_type === "local_directory") {
    const ar = a.resource_ref as LocalDirectoryResourceRef;
    const br = b.resource_ref as LocalDirectoryResourceRef;
    return ar.local_path === br.local_path && ar.daemon_id === br.daemon_id;
  }
  if (a.resource_type === "project_ref") {
    return (
      (a.resource_ref as ProjectRefResourceRef).project_id ===
      (b.resource_ref as ProjectRefResourceRef).project_id
    );
  }
  return false;
}

// Last path/URL segment, minus a trailing ".git" and any scp-style "host:"
// prefix — used to name a git repo or local directory in the selected bar.
function basename(pathOrUrl: string): string {
  const trimmed = pathOrUrl.replace(/[/\\]+$/, "");
  let seg = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (seg.includes(":")) seg = seg.slice(seg.lastIndexOf(":") + 1);
  return seg.replace(/\.git$/i, "") || pathOrUrl;
}

// Human-readable chip label per resource type. Project refs resolve their
// title from the cached project list, falling back to the raw id.
export function resourceDisplayName(
  resource: CreateProjectResourceRequest,
  projects: Project[],
): string {
  if (resource.resource_type === "github_repo") {
    return basename((resource.resource_ref as GithubRepoResourceRef).url);
  }
  if (resource.resource_type === "local_directory") {
    const ref = resource.resource_ref as LocalDirectoryResourceRef;
    return ref.label?.trim() || basename(ref.local_path);
  }
  if (resource.resource_type === "project_ref") {
    const id = (resource.resource_ref as ProjectRefResourceRef).project_id;
    return projects.find((p) => p.id === id)?.title ?? id;
  }
  return resource.resource_type;
}

// Stable React key derived from a resource's identity fields.
function resourceKey(resource: CreateProjectResourceRequest): string {
  if (resource.resource_type === "github_repo") {
    return `git:${(resource.resource_ref as GithubRepoResourceRef).url}`;
  }
  if (resource.resource_type === "local_directory") {
    const ref = resource.resource_ref as LocalDirectoryResourceRef;
    return `local:${ref.daemon_id}:${ref.local_path}`;
  }
  if (resource.resource_type === "project_ref") {
    return `project:${(resource.resource_ref as ProjectRefResourceRef).project_id}`;
  }
  return resource.resource_type;
}

function resourceIcon(type: CreateProjectResourceRequest["resource_type"]): LucideIcon {
  if (type === "local_directory") return FolderOpen;
  if (type === "project_ref") return FolderKanban;
  return FolderGit;
}

export function RepoSourcePopover({
  resources,
  onAdd,
  onRemove,
  currentProjectId,
  onClose,
}: RepoSourcePopoverProps) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const [tab, setTab] = useState<SourceTab>("git");

  const isSelected = (resource: CreateProjectResourceRequest) =>
    resources.some((r) => sameResource(r, resource));

  const toggle = (resource: CreateProjectResourceRequest) => {
    const existing = resources.find((r) => sameResource(r, resource));
    if (!existing) {
      onAdd(resource);
    } else if (onRemove) {
      onRemove(existing);
    }
  };

  const TABS: Array<{ id: SourceTab; label: string }> = [
    { id: "git", label: t(($) => $.repo_source.tab_git) },
    { id: "runtime", label: t(($) => $.repo_source.tab_runtime) },
    { id: "project", label: t(($) => $.repo_source.tab_project) },
  ];

  return (
    <div
      className={cn(
        "space-y-2",
        // The fleet tab needs room to breathe (path browser + long remotes);
        // the other tabs stay compact.
        tab === "runtime" ? "w-[560px] max-w-[90vw]" : "w-72",
      )}
    >
      <div className="grid grid-cols-3 gap-1 rounded-md bg-muted/60 p-0.5">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            className={cn(
              "rounded px-2 py-1 text-xs transition-colors",
              tab === entry.id
                ? "bg-background shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "git" && (
        <GitRepoTab
          repos={workspace?.repos ?? []}
          isSelected={isSelected}
          toggle={toggle}
          onAdd={onAdd}
          showSelected={!!onRemove}
        />
      )}
      {tab === "runtime" && (
        <RuntimeImportTab
          wsId={wsId}
          resources={resources}
          isSelected={isSelected}
          toggle={toggle}
          showSelected={!!onRemove}
        />
      )}
      {tab === "project" && (
        <ProjectRefTab
          wsId={wsId}
          currentProjectId={currentProjectId}
          isSelected={isSelected}
          toggle={toggle}
          showSelected={!!onRemove}
        />
      )}

      {/* Selected bar: only the removable (create) flow shows chips; the
          detail flow commits on check and marks attached rows in-place. The
          inline chip budget tracks the active tab's width (the fleet tab is
          much wider than the compact git/project tabs). */}
      {onRemove && (
        <SelectedResourcesBar
          resources={resources}
          projects={projects}
          onRemove={onRemove}
          maxVisible={tab === "runtime" ? MAX_VISIBLE_CHIPS : NARROW_MAX_VISIBLE_CHIPS}
        />
      )}

      <SelectedFooter count={resources.length} onClose={onClose} />
    </div>
  );
}

// Persistent bar of the currently-selected resources, shown across every tab.
// Chips wrap up to ~two rows; beyond that they collapse behind a "+N" affordance
// that expands into a scrollable vertical list (and can be collapsed again).
// The inline budget is layout-aware: the wide fleet tab fits ~6 chips in two
// rows, the compact w-72 tabs only ~3 before long names spill past two rows.
const MAX_VISIBLE_CHIPS = 6;
const NARROW_MAX_VISIBLE_CHIPS = 3;

function SelectedResourcesBar({
  resources,
  projects,
  onRemove,
  maxVisible,
}: {
  resources: CreateProjectResourceRequest[];
  projects: Project[];
  onRemove: (resource: CreateProjectResourceRequest) => void;
  maxVisible: number;
}) {
  const { t } = useT("projects");
  const [expanded, setExpanded] = useState(false);

  const overflowing = resources.length > maxVisible;

  // Collapse when the list shrinks back within the inline budget (removals) or
  // the active tab widens, so a stale expanded state never sticks around.
  useEffect(() => {
    if (!overflowing) setExpanded(false);
  }, [overflowing]);

  if (resources.length === 0) return null;

  const collapsed = overflowing && !expanded;
  const visible = collapsed ? resources.slice(0, maxVisible) : resources;

  return (
    <div className="border-t pt-2">
      <div
        className={cn(
          "flex flex-wrap gap-1",
          expanded &&
            overflowing &&
            "max-h-32 flex-col flex-nowrap overflow-y-auto pr-1",
        )}
      >
        {visible.map((resource) => {
          const Icon = resourceIcon(resource.resource_type);
          const name = resourceDisplayName(resource, projects);
          return (
            <span
              key={resourceKey(resource)}
              className="inline-flex max-w-[160px] items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-1.5 pr-1 text-xs"
            >
              <Icon className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate" title={name}>
                {name}
              </span>
              <button
                type="button"
                onClick={() => onRemove(resource)}
                aria-label={`${t(($) => $.resources.remove_tooltip)} ${name}`}
                className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          );
        })}
        {overflowing && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded
              ? t(($) => $.repo_source.collapse)
              : t(($) => $.repo_source.more, {
                  count: resources.length - maxVisible,
                })}
          </button>
        )}
      </div>
    </div>
  );
}

function SelectedFooter({
  count,
  onClose,
}: {
  count: number;
  onClose?: () => void;
}) {
  const { t } = useT("projects");
  return (
    <div className="flex items-center justify-between gap-2 border-t pt-2">
      <span className="text-xs text-muted-foreground">
        {t(($) => $.repo_source.footer_count, { count })}
      </span>
      {onClose && (
        <Button
          type="button"
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={onClose}
        >
          {t(($) => $.repo_source.done)}
        </Button>
      )}
    </div>
  );
}

function RepoUrlText({ url }: { url: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span title={url} className="truncate flex-1 text-left">{url}</span>}
      />
      <TooltipContent side="top" align="start" className="max-w-sm break-all">
        {url}
      </TooltipContent>
    </Tooltip>
  );
}

function GitRepoTab({
  repos,
  isSelected,
  toggle,
  onAdd,
  showSelected,
}: {
  repos: { url: string }[];
  isSelected: (r: CreateProjectResourceRequest) => boolean;
  toggle: (r: CreateProjectResourceRequest) => void;
  onAdd: (r: CreateProjectResourceRequest) => void;
  showSelected: boolean;
}) {
  const { t } = useT("projects");
  const [search, setSearch] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const query = search.trim().toLowerCase();
  const filtered = repos.filter((repo) => repo.url.toLowerCase().includes(query));

  const addCustom = () => {
    const url = customUrl.trim();
    if (!url) return;
    if (!isSelected(githubRepoResource(url))) onAdd(githubRepoResource(url));
    setCustomUrl("");
  };

  return (
    <>
      <div className="text-xs font-medium text-muted-foreground">
        {t(($) => $.repo_source.git_heading)}
      </div>
      {repos.length > 0 ? (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t(($) => $.repo_source.search_placeholder)}
              placeholder={t(($) => $.repo_source.search_placeholder)}
              className="h-8 w-full rounded-md border bg-transparent pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {filtered.length === 0 && query && (
              <p className="py-2 text-center text-xs text-muted-foreground">
                {t(($) => $.repo_source.search_empty)}
              </p>
            )}
            {filtered.map((repo) => {
              const resource = githubRepoResource(repo.url);
              const checked = isSelected(resource);
              const locked = checked && !showSelected;
              return (
                <button
                  type="button"
                  key={repo.url}
                  aria-disabled={locked}
                  onClick={() => {
                    if (locked) return;
                    toggle(resource);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors aria-disabled:cursor-not-allowed",
                    checked && "bg-accent",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    className="size-3.5"
                  />
                  <FolderGit className="size-3.5 shrink-0" />
                  <RepoUrlText url={repo.url} />
                  {locked && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t(($) => $.repo_source.added_badge)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(($) => $.repo_source.git_empty)}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          addCustom();
        }}
        className="flex items-center gap-1.5 pt-1 border-t"
      >
        <input
          type="text"
          value={customUrl}
          onChange={(e) => setCustomUrl(e.target.value)}
          placeholder={t(($) => $.repo_source.url_placeholder)}
          className="flex-1 bg-transparent text-xs px-2 py-1 outline-none placeholder:text-muted-foreground"
        />
        <Button
          type="submit"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={!customUrl.trim()}
        >
          {t(($) => $.repo_source.url_add)}
        </Button>
      </form>
    </>
  );
}

// Two-line candidate display shared by scan results and browse git-repo rows:
// name + branch on line 1, absolute path (mono) on line 2, and the full remote
// on a third muted line — every field truncates with a title tooltip so nothing
// hard-clips mid-text.
function CandidateBody({
  candidate,
  noRemoteLabel,
}: {
  candidate: RuntimeDirectoryCandidate;
  noRemoteLabel: string;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-0.5 text-left">
      <div className="flex items-center gap-1.5">
        <span className="truncate font-medium">{candidate.name}</span>
        {candidate.current_branch && (
          <Badge variant="secondary" className="shrink-0 gap-1 font-normal">
            <GitBranch className="size-3" />
            {candidate.current_branch}
          </Badge>
        )}
        {!candidate.remote_url && (
          <Badge variant="outline" className="ml-auto shrink-0">
            {noRemoteLabel}
          </Badge>
        )}
      </div>
      <div
        className="truncate font-mono text-xs text-muted-foreground"
        title={candidate.path}
      >
        {candidate.path}
      </div>
      {candidate.remote_url && (
        <div
          className="truncate text-xs text-muted-foreground"
          title={candidate.remote_url}
        >
          {candidate.remote_url}
        </div>
      )}
    </div>
  );
}

function RuntimeImportTab({
  wsId,
  resources,
  isSelected,
  toggle,
  showSelected,
}: {
  wsId: string;
  resources: CreateProjectResourceRequest[];
  isSelected: (r: CreateProjectResourceRequest) => boolean;
  toggle: (r: CreateProjectResourceRequest) => void;
  // When false (detail flow, no onRemove), an already-attached row locks with
  // an "Added" hint instead of toggling — mirrors GitRepoTab.
  showSelected: boolean;
}) {
  const { t } = useT("projects");
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  // Scanning is machine-level, so collapse a machine's runtimes into one entry.
  const machines = useMemo(
    () => groupMachines(runtimes.filter((r) => r.runtime_mode === "local")),
    [runtimes],
  );

  const [selectedKey, setSelectedKey] = useState("");
  const [path, setPath] = useState("~");
  const [view, setView] = useState<"browse" | "scan" | null>(null);

  useEffect(() => {
    setSelectedKey((prev) => prev || machines[0]?.key || "");
  }, [machines]);

  const machine = machines.find((m) => m.key === selectedKey);
  const daemonId = machine?.daemonId ?? null;
  const runtimeId = machine?.scanRuntimeId ?? "";
  const online = machine?.online ?? false;

  const scan = useMutation({
    mutationFn: (vars: { runtimeId: string; root: string }) =>
      resolveRuntimeDirectoryScan(
        vars.runtimeId,
        vars.root.trim() ? { root: vars.root.trim() } : undefined,
      ),
  });
  const browse = useMutation({
    mutationFn: (vars: { runtimeId: string; root: string }) =>
      resolveRuntimeDirectoryScan(vars.runtimeId, {
        root: vars.root.trim() || "~",
        mode: "browse",
      }),
  });

  const busy = scan.isPending || browse.isPending;

  const browseTo = (root: string) => {
    if (!runtimeId) return;
    setPath(root);
    setView("browse");
    scan.reset();
    browse.mutate({ runtimeId, root });
  };

  const scanHere = () => {
    if (!runtimeId) return;
    setView("scan");
    browse.reset();
    scan.mutate({ runtimeId, root: path });
  };

  const candidates = scan.data?.candidates ?? [];
  const browseCandidates = browse.data?.candidates ?? [];
  // The daemon echoes the expanded absolute root (e.g. "~" -> "/home/dev"), so
  // prefer that for the current dir — it renders and ascends even on an empty
  // listing. Fall back to a child's shared parent, then the requested path.
  const firstChild = browseCandidates[0];
  const currentDir =
    browse.data?.params?.resolved_root ??
    (firstChild ? parentOf(firstChild.path) ?? path : path);
  const upTarget = parentOf(currentDir);

  const errorMessage = (() => {
    const m = view === "browse" ? browse : view === "scan" ? scan : null;
    if (!m || !m.isError) return null;
    const msg = m.error instanceof Error ? m.error.message : "";
    if (msg && !/timed out|timeout/i.test(msg)) return msg;
    return t(($) => $.repo_source.scan_timeout_error);
  })();

  // Client mirror of the server's one-local_directory-per-(project, daemon)
  // rule: once a no-remote directory is pending on this daemon, block adding
  // more (the server would 409 otherwise).
  const hasLocalForDaemon =
    daemonId !== null &&
    resources.some(
      (r) =>
        r.resource_type === "local_directory" &&
        (r.resource_ref as LocalDirectoryResourceRef).daemon_id === daemonId,
    );

  const desktop = isDesktopShell();
  const localDaemon = useLocalDaemonStatus();
  // The desktop picker always attaches to THIS machine's daemon, so it hits the
  // same one-local_directory-per-(project, daemon) cap as the scan candidates.
  const hasLocalForLocalDaemon =
    localDaemon.daemonId !== null &&
    resources.some(
      (r) =>
        r.resource_type === "local_directory" &&
        (r.resource_ref as LocalDirectoryResourceRef).daemon_id ===
          localDaemon.daemonId,
    );
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const handlePickLocal = async () => {
    if (picking) return;
    setPickError(null);
    if (!localDaemon.daemonId || !localDaemon.running) {
      setPickError(t(($) => $.repo_source.desktop_daemon_offline));
      return;
    }
    if (hasLocalForLocalDaemon) {
      setPickError(t(($) => $.repo_source.local_cap_hint));
      return;
    }
    setPicking(true);
    try {
      const picked = await pickDirectory();
      if (!picked.ok || !picked.path) {
        if (picked.reason && picked.reason !== "cancelled") {
          setPickError(picked.error ?? t(($) => $.repo_source.desktop_pick_failed));
        }
        return;
      }
      const validation = await validateLocalDirectory(picked.path);
      if (!validation.ok) {
        setPickError(validation.error ?? t(($) => $.repo_source.desktop_invalid_dir));
        return;
      }
      const resource: CreateProjectResourceRequest = {
        resource_type: "local_directory",
        resource_ref: {
          local_path: picked.path,
          daemon_id: localDaemon.daemonId,
          ...(picked.basename ? { label: picked.basename } : {}),
        },
      };
      // Add-only — a re-pick of the same directory must not toggle it off.
      if (!isSelected(resource)) toggle(resource);
    } finally {
      setPicking(false);
    }
  };

  if (machines.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        {t(($) => $.repo_source.no_local_runtimes)}
      </p>
    );
  }

  const noRemoteLabel = t(($) => $.repo_source.no_remote_badge);

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          {t(($) => $.repo_source.runtime_label)}
        </label>
        <Select
          value={selectedKey}
          onValueChange={(v) => {
            if (!v) return;
            // Drop stale results from the previously-selected machine.
            scan.reset();
            browse.reset();
            setView(null);
            setSelectedKey(v);
          }}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder={t(($) => $.repo_source.runtime_placeholder)}>
              {machine ? machine.label : null}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {machines.map((m) => (
              <SelectItem key={m.key} value={m.key}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          {t(($) => $.repo_source.root_label)}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t(($) => $.repo_source.root_placeholder)}
            aria-label={t(($) => $.repo_source.root_label)}
            className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 text-xs"
            disabled={!online || busy}
            onClick={() => browseTo(path.trim() || "~")}
          >
            {browse.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <FolderOpen className="size-3" />
            )}
            {t(($) => $.repo_source.browse_button)}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 text-xs"
            disabled={!online || busy}
            onClick={scanHere}
          >
            {scan.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <HardDrive className="size-3" />
            )}
            {t(($) => $.repo_source.browse_scan_here)}
          </Button>
        </div>
      </div>

      {!online && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {t(($) => $.repo_source.runtime_offline)}
        </p>
      )}

      {errorMessage && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {errorMessage}
        </div>
      )}

      {view === "browse" && !browse.isError && (
        <div className="space-y-1">
          <div
            className="truncate px-1 font-mono text-[11px] text-muted-foreground"
            title={currentDir}
          >
            {currentDir}
          </div>
          <div className="max-h-[340px] space-y-1 overflow-y-auto">
            {upTarget && (
              <button
                type="button"
                onClick={() => browseTo(upTarget)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
              >
                <CornerLeftUp className="size-3.5 shrink-0" />
                {t(($) => $.repo_source.browse_up)}
              </button>
            )}
            {!browse.isPending && browseCandidates.length === 0 && (
              <p className="px-1 py-3 text-center text-xs text-muted-foreground">
                {t(($) => $.repo_source.browse_empty)}
              </p>
            )}
            {browseCandidates.map((candidate) => {
              if (candidate.is_git_repo !== true) {
                // Plain directory — navigate into it, nothing to import.
                return (
                  <button
                    type="button"
                    key={candidate.path}
                    onClick={() => browseTo(candidate.path)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors"
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1 text-left">
                      <div className="truncate font-medium">{candidate.name}</div>
                      <div
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={candidate.path}
                      >
                        {candidate.path}
                      </div>
                    </div>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                );
              }
              // Git repo — descend on the row, import via the checkbox.
              const resource = candidateResource(candidate, daemonId ?? "");
              const checked = isSelected(resource);
              const noRemote = !candidate.remote_url;
              const capped = noRemote && !checked && hasLocalForDaemon;
              // Already attached in the detail flow: lock, don't toggle off.
              const locked = checked && !showSelected;
              const importDisabled =
                locked || capped || (noRemote && daemonId === null);
              return (
                <div
                  key={candidate.path}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors",
                    checked && "bg-accent",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={importDisabled}
                    aria-label={candidate.name}
                    onChange={() => {
                      if (importDisabled) return;
                      toggle(resource);
                    }}
                    className="size-3.5 shrink-0 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => browseTo(candidate.path)}
                    className="flex min-w-0 flex-1 items-center gap-2"
                  >
                    <FolderGit className="size-3.5 shrink-0" />
                    <CandidateBody candidate={candidate} noRemoteLabel={noRemoteLabel} />
                  </button>
                  {locked && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {t(($) => $.repo_source.added_badge)}
                    </span>
                  )}
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "scan" && scan.isSuccess && candidates.length === 0 && (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">
          {t(($) => $.repo_source.scan_empty)}
        </p>
      )}

      {view === "scan" && candidates.length > 0 && (
        <div className="max-h-[340px] space-y-1 overflow-y-auto">
          {candidates.map((candidate) => {
            const resource = candidateResource(candidate, daemonId ?? "");
            const checked = isSelected(resource);
            const noRemote = !candidate.remote_url;
            // No-remote candidates become local_directory rows and hit the
            // per-daemon cap; disable further ones once one is pending.
            const capped = noRemote && !checked && hasLocalForDaemon;
            // Already attached in the detail flow: lock, don't toggle off.
            const locked = checked && !showSelected;
            const disabled = locked || capped || (noRemote && daemonId === null);
            return (
              <button
                type="button"
                key={candidate.path}
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  toggle(resource);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors aria-disabled:opacity-50 aria-disabled:cursor-not-allowed",
                  checked && "bg-accent",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  className="size-3.5 shrink-0"
                />
                <CandidateBody candidate={candidate} noRemoteLabel={noRemoteLabel} />
                {locked && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t(($) => $.repo_source.added_badge)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {hasLocalForDaemon && (
        <p className="text-[10px] text-muted-foreground leading-snug">
          {t(($) => $.repo_source.local_cap_hint)}
        </p>
      )}

      {desktop && (
        <div className="space-y-1 border-t pt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full text-xs"
            onClick={() => void handlePickLocal()}
            disabled={picking || !localDaemon.running || hasLocalForLocalDaemon}
          >
            <FolderOpen className="size-3" />
            {picking
              ? t(($) => $.repo_source.desktop_picking)
              : t(($) => $.repo_source.desktop_pick_button)}
          </Button>
          {/* Skip the hint when the scan tab already shows it for this machine. */}
          {hasLocalForLocalDaemon && localDaemon.daemonId !== daemonId && (
            <p className="text-[10px] text-muted-foreground leading-snug">
              {t(($) => $.repo_source.local_cap_hint)}
            </p>
          )}
          {pickError && (
            <p className="text-[11px] text-destructive">{pickError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectRefTab({
  wsId,
  currentProjectId,
  isSelected,
  toggle,
  showSelected,
}: {
  wsId: string;
  currentProjectId?: string;
  isSelected: (r: CreateProjectResourceRequest) => boolean;
  toggle: (r: CreateProjectResourceRequest) => void;
  // When false (detail flow, no onRemove), an already-referenced project row
  // locks with an "Added" hint instead of toggling — mirrors GitRepoTab.
  showSelected: boolean;
}) {
  const { t } = useT("projects");
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  // Keep already-referenced projects in the list (rendered as checked rows) so
  // a selection stays visible instead of vanishing on click.
  const candidates = projects.filter(
    (p) => p.id !== currentProjectId && p.title.toLowerCase().includes(query),
  );

  return (
    <>
      <div className="text-xs font-medium text-muted-foreground">
        {t(($) => $.repo_source.project_heading)}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t(($) => $.repo_source.project_placeholder)}
          placeholder={t(($) => $.repo_source.project_placeholder)}
          className="h-8 w-full rounded-md border bg-transparent pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t(($) => $.repo_source.project_empty)}
          </p>
        ) : (
          candidates.map((p) => {
            const resource: CreateProjectResourceRequest = {
              resource_type: "project_ref",
              resource_ref: { project_id: p.id },
            };
            const checked = isSelected(resource);
            const locked = checked && !showSelected;
            return (
              <button
                type="button"
                key={p.id}
                aria-disabled={locked}
                onClick={() => {
                  if (locked) return;
                  toggle(resource);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors aria-disabled:cursor-not-allowed",
                  checked && "bg-accent",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  className="size-3.5 shrink-0"
                />
                <ProjectIcon project={p} size="sm" />
                <span className="truncate flex-1 text-left">{p.title}</span>
                {locked && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t(($) => $.repo_source.added_badge)}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
