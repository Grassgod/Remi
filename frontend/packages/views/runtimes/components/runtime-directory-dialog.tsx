"use client";

import { useEffect, useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, ChevronRight, Folder, FolderOpen, Home, Loader2, Monitor, RefreshCw } from "lucide-react";
import { resolveRuntimeDirectoryScan, relativeRuntimeDirectory, runtimeDirectoryParent } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { useT } from "../../i18n";

export function RuntimeDirectoryDialog({ runtimeId, machineName, initialPath, boundary, online, onSelect, onClose }: {
  runtimeId: string;
  machineName: string;
  initialPath: string;
  boundary?: string;
  online: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useT("runtimes");
  const pathId = useId();
  const [path, setPath] = useState(initialPath);
  const [filter, setFilter] = useState("");
  const browse = useMutation({
    mutationFn: async (target: string) => {
      if (boundary && relativeRuntimeDirectory(boundary, target) === null) throw new Error(t($ => $.workspaces.browse_inside_root));
      const result = await resolveRuntimeDirectoryScan(runtimeId, { root: target, mode: "browse" });
      const resolved = result.params.resolved_root;
      if (!resolved || relativeRuntimeDirectory(resolved, resolved) === null) throw new Error(t($ => $.workspaces.browse_missing_path));
      if (boundary && relativeRuntimeDirectory(boundary, resolved) === null) throw new Error(t($ => $.workspaces.browse_inside_root));
      return { ...result, resolved };
    },
    onSuccess: result => { setPath(result.resolved); setFilter(""); },
  });
  const { mutate } = browse;
  useEffect(() => { if (online) mutate(initialPath); }, [initialPath, online, mutate]);

  const current = browse.data?.resolved;
  const parent = current ? runtimeDirectoryParent(current) : null;
  const up = parent && (!boundary || relativeRuntimeDirectory(boundary, parent) !== null) ? parent : null;
  const busy = browse.isPending;
  const candidates = (browse.data?.candidates ?? []).filter(candidate =>
    candidate.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
    && (!boundary || relativeRuntimeDirectory(boundary, candidate.path) !== null));
  const selectEnabled = online && !busy && !browse.isError && Boolean(current) && path.trim() === current;

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <DialogHeader className="shrink-0 gap-2 border-b px-5 py-5 pr-12">
        <DialogTitle>{t($ => boundary ? $.workspaces.browse_cwd_title : $.workspaces.browse_title)}</DialogTitle>
        <DialogDescription className="flex min-w-0 items-center gap-2">
          <Monitor className="size-3.5 shrink-0" />
          <span className="truncate">{t($ => $.workspaces.browse_machine, { machine: machineName })}</span>
        </DialogDescription>
      </DialogHeader>
      <div className="shrink-0 space-y-3 border-b bg-muted/30 px-5 py-4">
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="icon" aria-label={t($ => $.workspaces.browse_up)} title={t($ => $.workspaces.browse_up)} disabled={!online || busy || !up} onClick={() => up && mutate(up)}><ArrowLeft className="size-4" /></Button>
          <Button type="button" variant="outline" size="icon" aria-label={t($ => boundary ? $.workspaces.browse_root : $.workspaces.browse_home)} title={t($ => boundary ? $.workspaces.browse_root : $.workspaces.browse_home)} disabled={!online || busy} onClick={() => mutate(boundary || "~")}><Home className="size-4" /></Button>
          <div className="flex min-w-0 flex-1 gap-2">
            <Input id={pathId} aria-label={t($ => $.workspaces.browse_path)} value={path} disabled={!online || busy} className="min-w-0 font-mono text-xs" onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (path.trim()) mutate(path.trim()); } }} />
            <Button type="button" variant="outline" size="icon" aria-label={t($ => $.workspaces.browse_go)} disabled={!online || busy || !path.trim()} onClick={() => mutate(path.trim())}><ArrowRight className="size-4" /></Button>
          </div>
        </div>
        <Input aria-label={t($ => $.workspaces.browse_filter)} placeholder={t($ => $.workspaces.browse_filter)} value={filter} onChange={event => setFilter(event.target.value)} disabled={busy || !current} className="h-9" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" aria-busy={busy}>
        {!online ? <p role="status" className="px-3 py-12 text-center text-sm text-muted-foreground">{t($ => $.workspaces.browse_offline)}</p>
          : busy ? <div role="status" className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t($ => $.workspaces.browse_loading)}</div>
          : browse.isError ? <div className="space-y-3 px-3 py-10 text-center"><p role="alert" className="text-sm text-destructive">{browse.error.message}</p><Button type="button" variant="outline" size="sm" onClick={() => mutate(path.trim() || initialPath)}><RefreshCw className="size-3.5" />{t($ => $.workspaces.browse_retry)}</Button></div>
          : candidates.length === 0 ? <p className="px-3 py-16 text-center text-sm text-muted-foreground">{t($ => filter ? $.workspaces.browse_no_match : $.workspaces.browse_empty)}</p>
          : <ul>{candidates.map(candidate => <li key={candidate.path}>
            <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={candidate.path} onClick={() => mutate(candidate.path)}>
              <Folder className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">{candidate.name}</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>)}</ul>}
      </div>
      <DialogFooter className="m-0 shrink-0 flex-col items-stretch rounded-none px-5 sm:items-center">
        <div className="mr-auto min-w-0 flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">{t($ => $.workspaces.browse_selected)}</p>
          <p className="break-all font-mono text-xs">{current || t($ => $.workspaces.browse_loading)}</p>
        </div>
        <div className="flex shrink-0 justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t($ => $.workspaces.browse_cancel)}</Button>
          <Button type="button" disabled={!selectEnabled} onClick={() => { if (selectEnabled && current) onSelect(current); }}><FolderOpen className="size-4" />{t($ => $.workspaces.browse_select)}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
