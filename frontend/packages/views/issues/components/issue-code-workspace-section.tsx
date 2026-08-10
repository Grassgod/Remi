"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, FolderGit2, GitBranch, Server, TriangleAlert } from "lucide-react";
import { issueWorkspaceOptions } from "@multiremi/core/issues/queries";
import type { IssueWorkspaceStatus } from "@multiremi/core/types";
import { useT } from "../../i18n";

export function IssueCodeWorkspaceSection({ issueId }: { issueId: string }) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(true);
  const { data: workspace } = useQuery(issueWorkspaceOptions(issueId));
  if (!workspace) return null;

  const copy = (value: string) => void navigator.clipboard?.writeText(value);
  const statusLabel = t(($) => $.detail.workspace_status[workspace.status]);

  return (
    <div>
      <button
        type="button"
        className={`mb-2 flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen((value) => !value)}
      >
        {t(($) => $.detail.section_code_workspace)}
        <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 pl-2 text-xs">
          <WorkspaceRow icon={<StatusIcon status={workspace.status} />} label={t(($) => $.detail.workspace_status_label)}>
            <span>{statusLabel}</span>
          </WorkspaceRow>
          <WorkspaceRow icon={<GitBranch className="size-3.5" />} label={t(($) => $.detail.workspace_branch)}>
            <CopyValue value={workspace.branch_name} onCopy={copy} />
          </WorkspaceRow>
          <WorkspaceRow icon={<Server className="size-3.5" />} label={t(($) => $.detail.workspace_runtime)}>
            <span className={workspace.runtime_status === "offline" ? "text-destructive" : "truncate text-muted-foreground"}>
              {workspace.runtime_name ?? workspace.runtime_id ?? t(($) => $.detail.workspace_unknown)}
            </span>
          </WorkspaceRow>
          <WorkspaceRow icon={<FolderGit2 className="size-3.5" />} label={t(($) => $.detail.workspace_path)}>
            <CopyValue value={workspace.root_path} onCopy={copy} />
          </WorkspaceRow>
          {workspace.repos.length > 0 && (
            <div className="border-t border-border/60 pt-2">
              <div className="mb-1.5 text-[11px] text-muted-foreground">
                {t(($) => $.detail.workspace_repositories, { count: workspace.repos.length })}
              </div>
              <div className="space-y-2">
                {workspace.repos.map((repo) => (
                  <div key={repo.repo_url} className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {repo.status === "error" ? (
                        <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                      ) : (
                        <FolderGit2 className={`size-3.5 shrink-0 ${repo.dirty ? "text-amber-600" : "text-muted-foreground"}`} />
                      )}
                      <span className="truncate font-medium">{repo.repo_name}</span>
                      {repo.dirty && <span className="shrink-0 text-[10px] text-amber-700">{t(($) => $.detail.workspace_dirty)}</span>}
                    </div>
                    <div className="ml-5 mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={repo.worktree_path}>
                      {repo.worktree_path}
                    </div>
                    {repo.error && <div className="ml-5 mt-0.5 text-[10px] text-destructive">{repo.error}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[14px_64px_minmax(0,1fr)] items-center gap-1.5 text-muted-foreground">
      {icon}
      <span>{label}</span>
      <div className="min-w-0 text-foreground">{children}</div>
    </div>
  );
}

function CopyValue({ value, onCopy }: { value: string; onCopy: (value: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-[10px]" title={value}>{value}</span>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          onCopy(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

function StatusIcon({ status }: { status: IssueWorkspaceStatus }) {
  if (status === "error" || status === "runtime_offline") return <TriangleAlert className="size-3.5 text-destructive" />;
  const color = status === "dirty" ? "bg-amber-500" : status === "in_use" || status === "preparing" ? "bg-blue-500" : "bg-emerald-500";
  return <span className={`size-2.5 justify-self-center rounded-full ${color}`} />;
}
