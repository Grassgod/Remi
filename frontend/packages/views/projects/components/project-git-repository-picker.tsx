"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, Loader2, Plus, Search } from "lucide-react";
import { repositoryListOptions } from "@multiremi/core/repositories";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useCurrentWorkspace } from "@multiremi/core/paths";
import type {
  CreateProjectResourceRequest,
  GithubRepoResourceRef,
} from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  RepositoryOptionRow,
  type RepositoryOption,
} from "../../repositories/repository-option-row";
import { useT } from "../../i18n";

function repositoryNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const colon = trimmed.lastIndexOf(":");
  const separator = Math.max(slash, colon);
  return trimmed.slice(separator + 1).replace(/\.git$/i, "") || trimmed;
}

function fallbackRepository(url: string): RepositoryOption {
  return {
    id: `url:${url}`,
    name: repositoryNameFromUrl(url),
    url,
    description: null,
    default_branch: null,
  };
}

function repositoryResource(
  repository: RepositoryOption,
): CreateProjectResourceRequest {
  return {
    resource_type: "github_repo",
    resource_ref: {
      url: repository.url,
      ...(repository.default_branch
        ? { default_branch_hint: repository.default_branch }
        : {}),
    },
  };
}

export function ProjectGitRepositoryPicker({
  attachedResources,
  onAttach,
  onClose,
}: {
  attachedResources: CreateProjectResourceRequest[];
  onAttach: (
    resources: CreateProjectResourceRequest[],
  ) => Promise<readonly string[]>;
  onClose: () => void;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const { data, isLoading, isError } = useQuery(repositoryListOptions(wsId));
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Map<string, RepositoryOption>>(
    () => new Map(),
  );
  const [customOpen, setCustomOpen] = useState(false);
  const [customUrl, setCustomUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const attachedUrls = useMemo(
    () =>
      new Set(
        attachedResources
          .filter((resource) => resource.resource_type === "github_repo")
          .map(
            (resource) => (resource.resource_ref as GithubRepoResourceRef).url,
          ),
      ),
    [attachedResources],
  );

  const repositories = useMemo<RepositoryOption[]>(() => {
    if (data?.repositories) return data.repositories;
    if (!isError) return [];
    return (workspace?.repos ?? []).map((repository) =>
      fallbackRepository(repository.url),
    );
  }, [data?.repositories, isError, workspace?.repos]);

  const visibleRepositories = useMemo(() => {
    const byUrl = new Map(
      repositories.map((repository) => [repository.url, repository]),
    );
    for (const repository of pending.values()) {
      if (!byUrl.has(repository.url)) byUrl.set(repository.url, repository);
    }

    const query = search.trim().toLowerCase();
    return [...byUrl.values()]
      .filter((repository) => {
        if (!query) return true;
        return [
          repository.name,
          repository.url,
          repository.description,
          repository.default_branch,
        ]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(query));
      })
      .sort((a, b) => {
        const attachedOrder =
          Number(attachedUrls.has(a.url)) - Number(attachedUrls.has(b.url));
        return attachedOrder || a.name.localeCompare(b.name);
      });
  }, [attachedUrls, pending, repositories, search]);

  const toggleRepository = (repository: RepositoryOption) => {
    if (attachedUrls.has(repository.url)) return;
    setPending((current) => {
      const next = new Map(current);
      if (next.has(repository.url)) next.delete(repository.url);
      else next.set(repository.url, repository);
      return next;
    });
  };

  const addCustomUrl = () => {
    const url = customUrl.trim();
    if (!url) return;
    const repository =
      repositories.find((candidate) => candidate.url === url) ??
      fallbackRepository(url);
    if (!attachedUrls.has(url)) {
      setPending((current) => new Map(current).set(url, repository));
    }
    setCustomUrl("");
    setCustomOpen(false);
  };

  const submit = async () => {
    const selected = [...pending.values()];
    if (selected.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const attached = new Set(
        await onAttach(selected.map(repositoryResource)),
      );
      setPending((current) => {
        const next = new Map(current);
        for (const url of attached) next.delete(url);
        return next;
      });
      if (attached.size === selected.length) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-[390px] max-w-[calc(100vw-2rem)]">
      <div className="flex items-center justify-between gap-3 px-3 pb-2 pt-3">
        <h4 className="text-sm font-medium">
          {t(($) => $.repo_source.git_heading)}
        </h4>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t(($) => $.repo_source.attached_count, {
            count: attachedUrls.size,
          })}
        </span>
      </div>

      <div className="relative mx-3 mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t(($) => $.repo_source.search_placeholder)}
          placeholder={t(($) => $.repo_source.search_placeholder)}
          className="h-9 pl-8 text-sm"
          autoFocus
        />
      </div>

      <div className="mx-3 max-h-72 overflow-y-auto rounded-md border">
        {isLoading && repositories.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t(($) => $.repo_source.loading)}
          </div>
        ) : isError && repositories.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t(($) => $.repo_source.load_error)}
          </p>
        ) : visibleRepositories.length > 0 ? (
          visibleRepositories.map((repository) => {
            const attached = attachedUrls.has(repository.url);
            return (
              <RepositoryOptionRow
                key={repository.url}
                repository={repository}
                checked={attached || pending.has(repository.url)}
                disabled={attached}
                statusLabel={
                  attached ? t(($) => $.repo_source.attached_badge) : undefined
                }
                onToggle={() => toggleRepository(repository)}
              />
            );
          })
        ) : (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {search.trim()
              ? t(($) => $.repo_source.search_empty)
              : t(($) => $.repo_source.git_empty)}
          </p>
        )}
      </div>

      <div className="px-3 py-2">
        {customOpen ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addCustomUrl();
            }}
          >
            <Input
              value={customUrl}
              onChange={(event) => setCustomUrl(event.target.value)}
              placeholder={t(($) => $.repo_source.url_placeholder)}
              aria-label={t(($) => $.repo_source.url_placeholder)}
              className="h-8 min-w-0 flex-1 text-xs"
              autoFocus
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="h-8 shrink-0 px-3 text-xs"
              disabled={!customUrl.trim()}
            >
              {t(($) => $.repo_source.url_add)}
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCustomOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Link2 className="size-3.5" />
            {t(($) => $.repo_source.custom_url_toggle)}
            <Plus className="size-3" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5">
        <span className="text-xs text-muted-foreground">
          {t(($) => $.repo_source.selected_count, { count: pending.size })}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 px-3 text-xs"
            onClick={onClose}
            disabled={submitting}
          >
            {t(($) => $.repo_source.cancel)}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 min-w-20 px-3 text-xs"
            onClick={submit}
            disabled={pending.size === 0 || submitting}
          >
            {submitting && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {submitting
              ? t(($) => $.repo_source.attaching)
              : t(($) => $.repo_source.attach_selected, {
                  count: pending.size,
                })}
          </Button>
        </div>
      </div>
    </div>
  );
}
