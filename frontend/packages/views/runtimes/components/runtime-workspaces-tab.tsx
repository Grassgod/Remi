"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArrowRight, ChevronRight, CornerDownRight, FolderOpen, Loader2, Monitor, Plus, SlidersHorizontal } from "lucide-react";
import type { AgentRuntime } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { runtimeWorkspacesOptions, useCreateRuntimeWorkspace, useArchiveRuntimeWorkspace } from "@multiremi/core/runtimes/workspaces";
import { relativeRuntimeDirectory, runtimeDirectoryName, runtimeWorkspaceDirectory } from "@multiremi/core/runtimes";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { useT } from "../../i18n";
import { RuntimeDirectoryDialog } from "./runtime-directory-dialog";

export function RuntimeWorkspacesTab(props: { runtime: AgentRuntime; canManage: boolean }) {
  const wsId = useWorkspaceId();
  return <WorkspaceContent key={`${wsId}:${props.runtime.id}`} {...props} wsId={wsId} />;
}

function WorkspaceContent({ runtime, canManage, wsId }: { runtime: AgentRuntime; canManage: boolean; wsId: string }) {
  const { t } = useT("runtimes");
  const prefix = useId();
  const query = useQuery(runtimeWorkspacesOptions(wsId));
  const create = useCreateRuntimeWorkspace(wsId);
  const archive = useArchiveRuntimeWorkspace(wsId);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [cwd, setCwd] = useState(".");
  const [context, setContext] = useState("");
  const [envFile, setEnvFile] = useState("");
  const [message, setMessage] = useState("");
  const [picker, setPicker] = useState<"root" | "cwd" | null>(null);
  const workspaces = (query.data ?? []).filter(w => w.daemon_id === runtime.daemon_id);
  const machineName = runtime.device_info?.split(" · ")[0] || runtime.name;
  const online = runtime.status === "online";
  const executionPath = root ? runtimeWorkspaceDirectory(root, cwd) : null;

  return <div className="mx-auto w-full max-w-5xl space-y-7 px-4 py-6 sm:px-8 sm:py-8">
    <header className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold tracking-tight">{t($ => $.workspaces.title)}</h2>
        <div className="flex max-w-full items-center gap-2 rounded-full border bg-muted/30 px-3 py-1.5 text-xs">
          <Monitor className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{machineName}</span>
          <span className={`size-1.5 shrink-0 rounded-full ${online ? "bg-success" : "bg-muted-foreground"}`} />
          <span className="shrink-0 text-muted-foreground">{t($ => online ? $.workspaces.available : $.workspaces.unavailable)}</span>
        </div>
      </div>
      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t($ => $.workspaces.description)}</p>
    </header>

    {canManage && runtime.daemon_id && <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <form className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-xs" onSubmit={async event => {
        event.preventDefault();
        if (!executionPath || !name.trim()) return;
        setMessage("");
        try {
          await create.mutateAsync({ runtimeId: runtime.id, input: {
            name: name.trim(), root_path: root, cwd,
            context_paths: context.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
            env_file: envFile.trim() || null,
          } });
          setName(""); setRoot(""); setCwd("."); setContext(""); setEnvFile("");
          setMessage(t($ => $.workspaces.registered));
        } catch { /* Preserve the chosen directory and input for correction. */ }
      }}>
        <div className="space-y-6 p-5 sm:p-6">
          <section className="space-y-4" aria-labelledby={`${prefix}-location`}>
            <h3 id={`${prefix}-location`} className="flex items-center gap-2.5 text-sm font-semibold">
              <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">1</span>{t($ => $.workspaces.location_title)}
            </h3>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t($ => $.workspaces.root)}</p>
              <button type="button" aria-label={t($ => $.workspaces.choose_root)} disabled={!online || create.isPending}
                className="group flex w-full items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-4 text-left transition-colors hover:border-foreground/30 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => setPicker("root")}>
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background"><FolderOpen className="size-5 text-muted-foreground" /></span>
                <span className="min-w-0 flex-1 space-y-1">
                  <span className={`block ${root ? "break-all font-mono text-xs leading-5" : "text-sm font-medium"}`}>{root || t($ => $.workspaces.choose_root)}</span>
                  <span className="block text-xs text-muted-foreground">{t($ => root ? $.workspaces.change_directory : $.workspaces.choose_root_hint)}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
              {!online && <p className="text-xs text-muted-foreground">{t($ => $.workspaces.browse_offline)}</p>}
              <p className="text-xs leading-5 text-muted-foreground">{t($ => $.workspaces.root_hint)}</p>
            </div>
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium">{t($ => $.workspaces.cwd)}</p>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!root || !online || create.isPending} onClick={() => setPicker("cwd")}>
                  <FolderOpen className="size-3.5" />{t($ => $.workspaces.choose_cwd)}
                </Button>
              </div>
              <div className="flex min-w-0 items-start gap-2 text-sm">
                <CornerDownRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <p className={cwd === "." ? "text-muted-foreground" : "break-all font-mono text-xs leading-5"}>{cwd === "." ? t($ => $.workspaces.cwd_same_root) : cwd}</p>
              </div>
              {cwd !== "." && <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" disabled={create.isPending} onClick={() => setCwd(".")}>{t($ => $.workspaces.cwd_reset)}</Button>}
            </div>
          </section>

          <section className="space-y-3 border-t pt-5" aria-labelledby={`${prefix}-details`}>
            <h3 id={`${prefix}-details`} className="flex items-center gap-2.5 text-sm font-semibold">
              <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">2</span>{t($ => $.workspaces.details_title)}
            </h3>
            <label className="block space-y-2 text-xs font-medium" htmlFor={`${prefix}-name`}><span>{t($ => $.workspaces.name)}</span>
              <Input id={`${prefix}-name`} value={name} onChange={event => setName(event.target.value)} required maxLength={120} disabled={create.isPending} placeholder={t($ => $.workspaces.name_placeholder)} />
            </label>
          </section>

          <details className="group border-t pt-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground [&::-webkit-details-marker]:hidden">
              <SlidersHorizontal className="size-4" />{t($ => $.workspaces.context_options)}<ChevronRight className="ml-auto size-4 transition-transform group-open:rotate-90" />
            </summary>
            <div className="space-y-4 pt-5">
              <label className="block space-y-2 text-xs font-medium" htmlFor={`${prefix}-context`}><span>{t($ => $.workspaces.context_paths)}</span>
                <Textarea id={`${prefix}-context`} value={context} onChange={event => setContext(event.target.value)} placeholder={t($ => $.workspaces.context_placeholder)} rows={3} className="font-mono text-xs" disabled={create.isPending} />
              </label>
              <label className="block space-y-2 text-xs font-medium" htmlFor={`${prefix}-env`}><span>{t($ => $.workspaces.env_file)}</span>
                <Input id={`${prefix}-env`} value={envFile} onChange={event => setEnvFile(event.target.value)} placeholder=".env.local" className="font-mono text-xs" disabled={create.isPending} />
              </label>
              <p className="text-xs leading-5 text-muted-foreground">{t($ => $.workspaces.context_hint)}</p>
            </div>
          </details>
          {create.error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{create.error.message}</p>}
        </div>
        <div className="flex items-center justify-end border-t bg-muted/20 px-5 py-4 sm:px-6">
          <Button type="submit" disabled={create.isPending || !name.trim() || !executionPath}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{t($ => $.workspaces.register)}
          </Button>
        </div>
      </form>

      <aside className="space-y-5 rounded-xl bg-muted/40 p-5">
        <div className="space-y-2"><h3 className="text-sm font-semibold">{t($ => $.workspaces.preview_title)}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{t($ => $.workspaces.preview_hint)}</p>
        </div>
        <div className="space-y-4 rounded-lg border bg-background p-4">
          <div className="space-y-1.5"><p className="text-xs text-muted-foreground">{t($ => $.workspaces.root)}</p>
            <p className="break-all font-mono text-xs leading-5">{root || t($ => $.workspaces.preview_empty)}</p>
          </div>
          <div className="space-y-1.5 border-t pt-3"><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowRight className="size-3" />{t($ => $.workspaces.preview_cwd)}</p>
            <p className="break-all font-mono text-xs leading-5" role="status">{executionPath || t($ => $.workspaces.preview_empty)}</p>
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t($ => $.workspaces.reuse_hint)}</p>
      </aside>
    </div>}

    {message && <p role="status" className="rounded-lg border border-success/20 bg-success/5 px-4 py-3 text-sm text-success">{message}</p>}
    {archive.error && <p role="alert" className="text-sm text-destructive">{archive.error.message}</p>}
    <section className="space-y-4 border-t pt-6">
      <div className="flex items-center gap-2"><h3 className="text-sm font-semibold">{t($ => $.workspaces.saved_title)}</h3>
        {!query.isPending && <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{workspaces.length}</span>}
      </div>
      {query.isError ? <p role="alert" className="text-sm text-destructive">{t($ => $.workspaces.load_failed)}</p>
        : query.isPending ? <p className="text-sm text-muted-foreground">{t($ => $.workspaces.loading)}</p>
        : workspaces.length === 0 ? <p className="text-sm text-muted-foreground">{t($ => $.workspaces.empty)}</p>
        : <div className="divide-y rounded-xl border">{workspaces.map(workspace => <div key={workspace.id} className="flex flex-wrap items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5">
          <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-1"><p className="truncate text-sm font-medium">{workspace.name}</p>
            <p className="break-all font-mono text-xs leading-5 text-muted-foreground">{runtimeWorkspaceDirectory(workspace.root_path, workspace.cwd) || workspace.root_path}</p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"><span className={`size-1.5 rounded-full ${workspace.status === "available" ? "bg-success" : "bg-muted-foreground"}`} />{t($ => workspace.status === "available" ? $.workspaces.available : $.workspaces.unavailable)}</span>
          {canManage && <Button type="button" size="sm" variant="ghost" disabled={archive.isPending}
            onClick={() => { setMessage(""); archive.mutate(workspace.id, { onSuccess: () => setMessage(t($ => $.workspaces.archived)) }); }}>
            <Archive className="size-3.5" />{t($ => $.workspaces.archive)}
          </Button>}
        </div>)}</div>}
      <p className="max-w-3xl text-xs leading-5 text-muted-foreground">{t($ => $.workspaces.lifecycle_hint)}</p>
    </section>

    {picker && <RuntimeDirectoryDialog key={picker} runtimeId={runtime.id} machineName={machineName} online={online}
      initialPath={picker === "root" ? root || "~" : executionPath || root}
      boundary={picker === "cwd" ? root : undefined} onClose={() => setPicker(null)}
      onSelect={directory => {
        if (picker === "root") {
          if (directory !== root) setCwd(".");
          setRoot(directory);
          if (!name.trim()) setName(runtimeDirectoryName(directory));
        } else {
          const relative = relativeRuntimeDirectory(root, directory);
          if (relative === null) return;
          setCwd(relative);
        }
        setPicker(null);
      }} />}
  </div>;
}
