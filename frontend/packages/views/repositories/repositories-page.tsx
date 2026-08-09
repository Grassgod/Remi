"use client";

import { useMemo, useState } from "react";
import { GitBranch, GitFork, Plus, Search, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import {
  repositoryListOptions,
  useRemoveWorkspaceRepository,
} from "@multiremi/core/repositories";
import type {
  WorkspaceRepository,
  WorkspaceRepositorySource,
} from "@multiremi/core/types";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { useT } from "../i18n";
import { PageHeader } from "../layout/page-header";
import { GitHubMark } from "../settings/components/github-mark";
import { ImportRepositoryDialog } from "./import-repository-dialog";

type RepositoryFilter = "all" | WorkspaceRepositorySource;

const EMPTY_REPOSITORIES: WorkspaceRepository[] = [];
const TABLE_GRID =
  "grid min-w-[820px] grid-cols-[minmax(220px,1.2fr)_110px_130px_minmax(180px,1fr)_120px_44px]";

function formatImportedDate(value: string | null): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "--";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function RepositoriesPage() {
  const { t } = useT("repositories");
  const workspaceId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id);
  const { data: repositoryResponse, isLoading } = useQuery(
    repositoryListOptions(workspaceId),
  );
  const { data: members = [] } = useQuery(memberListOptions(workspaceId));
  const repositories = repositoryResponse?.repositories ?? EMPTY_REPOSITORIES;
  const removeRepository = useRemoveWorkspaceRepository(workspaceId);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RepositoryFilter>("all");
  const [importOpen, setImportOpen] = useState(false);
  const [repositoryToRemove, setRepositoryToRemove] =
    useState<WorkspaceRepository | null>(null);

  const currentMember = members.find((member) => member.user_id === userId);
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";

  const filteredRepositories = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return repositories.filter((repository) => {
      if (filter !== "all" && repository.source !== filter) return false;
      if (!normalizedSearch) return true;
      return [repository.name, repository.url, repository.description]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalizedSearch));
    });
  }, [filter, repositories, search]);

  const handleRemove = async () => {
    if (!repositoryToRemove || removeRepository.isPending) return;
    try {
      await removeRepository.mutateAsync(repositoryToRemove.id);
      toast.success(t(($) => $.toast.removed));
      setRepositoryToRemove(null);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.toast.remove_failed),
      );
    }
  };

  const filters: Array<{ value: RepositoryFilter; label: string }> = [
    { value: "all", label: t(($) => $.filters.all) },
    { value: "github", label: t(($) => $.sources.github) },
    { value: "codebase", label: t(($) => $.sources.codebase) },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="justify-between px-5">
        <div className="flex min-w-0 items-center gap-2">
          <GitFork className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="text-sm font-medium">{t(($) => $.page.title)}</h1>
          {!isLoading && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {repositories.length}
            </span>
          )}
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <Plus className="size-3.5" />
            {t(($) => $.page.import_repository)}
          </Button>
        )}
      </PageHeader>

      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="relative min-w-0 flex-1 sm:max-w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(($) => $.page.search_placeholder)}
            aria-label={t(($) => $.page.search_placeholder)}
            className="pl-8"
          />
        </div>

        <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
          {filters.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
              className={cn(
                "h-7 rounded px-2.5 text-xs font-medium transition-colors",
                filter === item.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="min-w-[820px]">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className={cn(TABLE_GRID, "h-12 items-center gap-3 border-b px-5")}>
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-20" />
                <span />
              </div>
            ))}
          </div>
        ) : repositories.length === 0 ? (
          <div className="flex h-full min-h-72 flex-col items-center justify-center px-6 text-center text-muted-foreground">
            <GitFork className="mb-3 size-10 opacity-30" />
            <p className="text-sm font-medium text-foreground">{t(($) => $.empty.title)}</p>
            <p className="mt-1 max-w-md text-sm">{t(($) => $.empty.description)}</p>
            {canManage && (
              <Button size="sm" variant="outline" className="mt-4" onClick={() => setImportOpen(true)}>
                <Plus className="size-3.5" />
                {t(($) => $.empty.action)}
              </Button>
            )}
          </div>
        ) : filteredRepositories.length === 0 ? (
          <div className="flex h-full min-h-72 flex-col items-center justify-center text-muted-foreground">
            <Search className="mb-3 size-9 opacity-30" />
            <p className="text-sm">{t(($) => $.empty.search)}</p>
          </div>
        ) : (
          <div className="min-w-[820px]">
            <div className={cn(TABLE_GRID, "sticky top-0 z-10 h-9 items-center gap-3 border-b bg-background px-5 text-xs font-medium text-muted-foreground")}>
              <span>{t(($) => $.table.repository)}</span>
              <span>{t(($) => $.table.source)}</span>
              <span>{t(($) => $.table.default_branch)}</span>
              <span>{t(($) => $.table.description)}</span>
              <span>{t(($) => $.table.imported)}</span>
              <span />
            </div>

            {filteredRepositories.map((repository) => (
              <div
                key={repository.id}
                className={cn(TABLE_GRID, "group min-h-14 items-center gap-3 border-b px-5 text-sm hover:bg-accent/30")}
              >
                <div className="min-w-0 py-2">
                  <div className="truncate font-medium">{repository.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground" title={repository.url}>
                    {repository.url}
                  </div>
                </div>
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                    {repository.source === "github" ? (
                      <GitHubMark className="size-3" />
                    ) : (
                      <GitBranch className="size-3" />
                    )}
                    {repository.source === "github"
                      ? t(($) => $.sources.github)
                      : repository.source === "codebase"
                        ? t(($) => $.sources.codebase)
                        : t(($) => $.sources.git)}
                  </span>
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {repository.default_branch ? (
                    <>
                      <GitBranch className="size-3 shrink-0" />
                      <span className="truncate">{repository.default_branch}</span>
                    </>
                  ) : (
                    "--"
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground" title={repository.description ?? undefined}>
                  {repository.description || "--"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatImportedDate(repository.imported_at)}
                </div>
                <div className="flex justify-end">
                  {canManage && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t(($) => $.remove.action_aria, { name: repository.name })}
                            className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                            onClick={() => setRepositoryToRemove(repository)}
                          />
                        }
                      >
                        <Trash2 className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipContent>{t(($) => $.remove.action)}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {canManage && (
        <ImportRepositoryDialog
          workspaceId={workspaceId}
          open={importOpen}
          onOpenChange={setImportOpen}
        />
      )}

      <AlertDialog
        open={repositoryToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removeRepository.isPending) setRepositoryToRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.remove.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.remove.description, {
                name: repositoryToRemove?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeRepository.isPending}>
              {t(($) => $.remove.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleRemove}
              disabled={removeRepository.isPending}
            >
              {removeRepository.isPending
                ? t(($) => $.remove.removing)
                : t(($) => $.remove.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
