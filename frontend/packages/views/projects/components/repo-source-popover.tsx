"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  FolderGit,
  FolderOpen,
  HardDrive,
  Loader2,
  Search,
  X as XIcon,
} from "lucide-react";
import type {
  AgentRuntime,
  CreateProjectResourceRequest,
  GithubRepoResourceRef,
  LocalDirectoryResourceRef,
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
}

function runtimeLabel(runtime: AgentRuntime): string {
  return `${runtime.name} (${runtime.provider})`;
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

export function RepoSourcePopover({
  resources,
  onAdd,
  onRemove,
  currentProjectId,
}: RepoSourcePopoverProps) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
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
    <div className="space-y-2">
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
        />
      )}
      {tab === "project" && (
        <ProjectRefTab
          wsId={wsId}
          currentProjectId={currentProjectId}
          resources={resources}
          onAdd={onAdd}
        />
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
  const selectedUrls = repos
    .map((repo) => repo.url)
    .filter((url) => isSelected(githubRepoResource(url)));

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
                      {t(($) => $.repo_source.attached_badge)}
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
      {showSelected && selectedUrls.length > 0 && (
        <div className="space-y-1 pt-1 border-t">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            {t(($) => $.repo_source.selected_heading)}
          </div>
          {selectedUrls.map((url) => (
            <div key={url} className="flex items-center gap-2 text-xs">
              <FolderGit className="size-3 text-muted-foreground" />
              <RepoUrlText url={url} />
              <button
                type="button"
                onClick={() => toggle(githubRepoResource(url))}
                className="text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RuntimeImportTab({
  wsId,
  resources,
  isSelected,
  toggle,
}: {
  wsId: string;
  resources: CreateProjectResourceRequest[];
  isSelected: (r: CreateProjectResourceRequest) => boolean;
  toggle: (r: CreateProjectResourceRequest) => void;
}) {
  const { t } = useT("projects");
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const localRuntimes = useMemo(
    () => runtimes.filter((r) => r.runtime_mode === "local"),
    [runtimes],
  );

  const [selectedRuntimeId, setSelectedRuntimeId] = useState("");
  const [root, setRoot] = useState("~");

  useEffect(() => {
    setSelectedRuntimeId((prev) => prev || localRuntimes[0]?.id || "");
  }, [localRuntimes]);

  const selectedRuntime = localRuntimes.find((r) => r.id === selectedRuntimeId);
  const daemonId = selectedRuntime?.daemon_id ?? null;
  const online = selectedRuntime?.status === "online";

  const scan = useMutation({
    mutationFn: (vars: { runtimeId: string; root: string }) =>
      resolveRuntimeDirectoryScan(
        vars.runtimeId,
        vars.root.trim() ? { root: vars.root.trim() } : undefined,
      ),
  });

  const candidates = scan.data?.candidates ?? [];
  const scanErrorMessage = (() => {
    if (!scan.isError) return null;
    const msg = scan.error instanceof Error ? scan.error.message : "";
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

  if (localRuntimes.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        {t(($) => $.repo_source.no_local_runtimes)}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">
          {t(($) => $.repo_source.runtime_label)}
        </label>
        <Select
          value={selectedRuntimeId}
          onValueChange={(v) => {
            if (!v) return;
            // Drop stale candidates from the previously-selected machine.
            scan.reset();
            setSelectedRuntimeId(v);
          }}
        >
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder={t(($) => $.repo_source.runtime_placeholder)}>
              {selectedRuntime ? runtimeLabel(selectedRuntime) : null}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {localRuntimes.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {runtimeLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1 space-y-1">
          <label className="text-xs text-muted-foreground">
            {t(($) => $.repo_source.root_label)}
          </label>
          <input
            type="text"
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            placeholder={t(($) => $.repo_source.root_placeholder)}
            aria-label={t(($) => $.repo_source.root_label)}
            className="h-8 w-full rounded-md border bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 text-xs"
          disabled={!online || scan.isPending}
          onClick={() =>
            selectedRuntimeId &&
            scan.mutate({ runtimeId: selectedRuntimeId, root })
          }
        >
          {scan.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <HardDrive className="size-3" />
          )}
          {scan.isPending
            ? t(($) => $.repo_source.scanning)
            : t(($) => $.repo_source.scan_button)}
        </Button>
      </div>

      {!online && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {t(($) => $.repo_source.runtime_offline)}
        </p>
      )}

      {scanErrorMessage && (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {scanErrorMessage}
        </div>
      )}

      {scan.isSuccess && candidates.length === 0 && (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">
          {t(($) => $.repo_source.scan_empty)}
        </p>
      )}

      {candidates.length > 0 && (
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {candidates.map((candidate) => {
            const resource = candidateResource(candidate, daemonId ?? "");
            const checked = isSelected(resource);
            const noRemote = !candidate.remote_url;
            // No-remote candidates become local_directory rows and hit the
            // per-daemon cap; disable further ones once one is pending.
            const capped = noRemote && !checked && hasLocalForDaemon;
            const disabled = capped || (noRemote && daemonId === null);
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
                  className="size-3.5"
                />
                <div className="min-w-0 flex-1 text-left">
                  <div className="truncate font-medium">{candidate.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {candidate.path}
                  </div>
                </div>
                {candidate.remote_url ? (
                  <Badge variant="secondary" className="max-w-[8rem] shrink-0 truncate">
                    {candidate.remote_url}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="shrink-0">
                    {t(($) => $.repo_source.no_remote_badge)}
                  </Badge>
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
  resources,
  onAdd,
}: {
  wsId: string;
  currentProjectId?: string;
  resources: CreateProjectResourceRequest[];
  onAdd: (r: CreateProjectResourceRequest) => void;
}) {
  const { t } = useT("projects");
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const [search, setSearch] = useState("");

  const referencedIds = new Set(
    resources
      .filter((r) => r.resource_type === "project_ref")
      .map((r) => (r.resource_ref as ProjectRefResourceRef).project_id),
  );
  const query = search.trim().toLowerCase();
  const candidates = projects.filter(
    (p) =>
      p.id !== currentProjectId &&
      !referencedIds.has(p.id) &&
      p.title.toLowerCase().includes(query),
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
          candidates.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() =>
                onAdd({
                  resource_type: "project_ref",
                  resource_ref: { project_id: p.id },
                })
              }
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent transition-colors"
            >
              <ProjectIcon project={p} size="sm" />
              <span className="truncate flex-1 text-left">{p.title}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}
