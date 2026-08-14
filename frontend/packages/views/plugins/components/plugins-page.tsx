"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  Plus,
  Puzzle,
  Search,
} from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  AgentPlugin,
  AgentPluginProvider,
  AgentPluginRuntimeState,
} from "@multiremi/core/plugins";
import {
  pluginListOptions,
  pluginRuntimeStatesOptions,
} from "@multiremi/core/plugins";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@multiremi/ui/components/ui/tabs";
import { AppLink, useNavigation } from "../../navigation";
import { EmptyState } from "../../common/empty-state";
import { PageHeader } from "../../layout/page-header";
import { useT, useTimeAgo } from "../../i18n";
import { PluginImportDialog } from "./plugin-import-dialog";
import { PluginReadinessList } from "./plugin-readiness-list";

const PROVIDERS: AgentPluginProvider[] = ["claude", "codex"];

function PluginRow({
  plugin,
  runtimeQuery,
}: {
  plugin: AgentPlugin;
  runtimeQuery: {
    data?: AgentPluginRuntimeState[];
    isLoading: boolean;
    error: Error | null;
  };
}) {
  const { t } = useT("plugins");
  const paths = useWorkspacePaths();
  const timeAgo = useTimeAgo();
  const version = plugin.activeVersion?.version;
  const states = runtimeQuery.data ?? [];

  return (
    <li className="grid min-w-0 gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.9fr)] lg:gap-8">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <Puzzle className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <AppLink
              href={paths.pluginDetail(plugin.id)}
              className="truncate text-sm font-medium hover:underline"
            >
              {plugin.name}
            </AppLink>
            <Badge variant="outline" className="capitalize">
              {t(($) => $.provider[plugin.provider])}
            </Badge>
            {version ? (
              <span className="font-mono text-xs text-muted-foreground">
                {t(($) => $.list.version, { version })}
              </span>
            ) : (
              <span className="text-xs text-warning">
                {t(($) => $.list.no_version)}
              </span>
            )}
          </div>
          {plugin.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {plugin.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{t(($) => $.list.bindings, { count: plugin.bindingCount })}</span>
            {plugin.updatedAt && (
              <span>
                {t(($) => $.list.updated, { when: timeAgo(plugin.updatedAt) })}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="min-w-0 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
        <p className="mb-1.5 text-[11px] font-medium uppercase text-muted-foreground">
          {t(($) => $.list.runtimes)}
        </p>
        <PluginReadinessList
          pluginId={plugin.id}
          states={states}
          isLoading={runtimeQuery.isLoading}
          error={runtimeQuery.error}
          compact
        />
      </div>
    </li>
  );
}

export function PluginsPage() {
  const { t } = useT("plugins");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const [provider, setProvider] = useState<AgentPluginProvider>("claude");
  const [search, setSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const {
    data: plugins = [],
    isLoading,
    error,
    refetch,
  } = useQuery(pluginListOptions(wsId, provider));

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return plugins;
    return plugins.filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(query) ||
        plugin.description.toLowerCase().includes(query),
    );
  }, [plugins, search]);

  const runtimeQueries = useQueries({
    queries: filtered.map((plugin) =>
      pluginRuntimeStatesOptions(wsId, plugin.id),
    ),
  });

  const providerLabel = t(($) => $.provider[provider]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="justify-between px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Puzzle className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h1 className="text-sm font-medium">{t(($) => $.page.title)}</h1>
          {plugins.length > 0 && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
              {plugins.length}
            </span>
          )}
          <p className="ml-2 hidden truncate text-xs text-muted-foreground md:block">
            {t(($) => $.page.tagline)}
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setImportOpen(true)}>
          <Plus />
          {t(($) => $.page.import_action)}
        </Button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-6">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">
          <div className="flex shrink-0 flex-col gap-3 border-b px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <Tabs
              value={provider}
              onValueChange={(value) =>
                setProvider(value as AgentPluginProvider)
              }
            >
              <TabsList aria-label={t(($) => $.page.title)}>
                {PROVIDERS.map((value) => (
                  <TabsTrigger key={value} value={value} className="px-3">
                    {t(($) => $.provider[value])}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(($) => $.page.search_placeholder)}
                className="h-8 w-full pl-8"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="space-y-4 p-4">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-32 w-full" />
                ))}
              </div>
            ) : error ? (
              <EmptyState
                variant="status"
                tone="destructive"
                icon={AlertCircle}
                title={t(($) => $.list.load_error_title)}
                description={
                  error instanceof Error && error.message
                    ? error.message
                    : t(($) => $.list.load_error_description)
                }
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refetch()}
                  >
                    {t(($) => $.list.retry_action)}
                  </Button>
                }
              />
            ) : plugins.length === 0 ? (
              <EmptyState
                icon={Puzzle}
                title={t(($) => $.list.empty_title, {
                  provider: providerLabel,
                })}
                description={t(($) => $.list.empty_description, {
                  provider: providerLabel,
                })}
                action={
                  <Button
                    type="button"
                    size="sm"
                    className="mt-5"
                    onClick={() => setImportOpen(true)}
                  >
                    <Plus />
                    {t(($) => $.page.import_action)}
                  </Button>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                variant="status"
                icon={Search}
                title={t(($) => $.list.no_results_title)}
                description={t(($) => $.list.no_results_description)}
              />
            ) : (
              <ul className="divide-y">
                {filtered.map((plugin, index) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    runtimeQuery={{
                      data: runtimeQueries[index]?.data,
                      isLoading: runtimeQueries[index]?.isLoading ?? false,
                      error: runtimeQueries[index]?.error ?? null,
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <PluginImportDialog
        provider={provider}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(plugin) => navigation.push(paths.pluginDetail(plugin.id))}
      />
    </div>
  );
}
