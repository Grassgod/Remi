"use client";

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileJson2,
  History,
  Loader2,
  Puzzle,
  RotateCcw,
  Upload,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentPluginVersion } from "@multiremi/core/plugins";
import {
  pluginDetailOptions,
  pluginRuntimeStatesOptions,
  pluginVersionsOptions,
  useActivateAgentPluginVersion,
  useRollbackAgentPluginVersion,
} from "@multiremi/core/plugins";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
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
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { EmptyState } from "../../common/empty-state";
import { useT, useTimeAgo } from "../../i18n";
import { PluginImportDialog } from "./plugin-import-dialog";
import { PluginReadinessList } from "./plugin-readiness-list";

type VersionAction = {
  kind: "activate" | "rollback";
  version: AgentPluginVersion;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function VersionPanel({
  label,
  version,
}: {
  label: string;
  version: AgentPluginVersion | null;
}) {
  const { t } = useT("plugins");
  return (
    <div className="min-w-0 border-b px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <dt className="text-[11px] font-medium uppercase text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1">
        {version ? (
          <div className="min-w-0 space-y-1">
            <span className="font-mono text-sm font-medium">
              {version.version}
            </span>
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={version.artifactDigest}>
              {version.artifactDigest}
            </p>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t(($) => $.detail.no_active_version)}
          </span>
        )}
      </dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <dt className="text-[11px] font-medium uppercase text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-sm" title={String(value)}>
        {value || "-"}
      </dd>
    </div>
  );
}

export function PluginDetailPage({ pluginId }: { pluginId: string }) {
  const { t } = useT("plugins");
  const timeAgo = useTimeAgo();
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [importOpen, setImportOpen] = useState(false);
  const [versionAction, setVersionAction] = useState<VersionAction | null>(null);
  const detail = useQuery(pluginDetailOptions(wsId, pluginId));
  const versions = useQuery(pluginVersionsOptions(wsId, pluginId));
  const runtimes = useQuery(pluginRuntimeStatesOptions(wsId, pluginId));
  const activate = useActivateAgentPluginVersion(wsId, pluginId);
  const rollback = useRollbackAgentPluginVersion(wsId, pluginId);

  if (detail.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <BreadcrumbHeader
          segments={[
            { href: paths.plugins(), label: t(($) => $.detail.back_action) },
          ]}
          leaf={<Skeleton className="h-4 w-36" />}
        />
        <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full lg:col-span-2" />
        </div>
      </div>
    );
  }

  const plugin = detail.data;
  if (detail.error || !plugin?.id) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <BreadcrumbHeader
          segments={[
            { href: paths.plugins(), label: t(($) => $.detail.back_action) },
          ]}
          leaf={t(($) => $.detail.not_found_title)}
        />
        <EmptyState
          variant="status"
          tone={detail.error ? "destructive" : "muted"}
          icon={AlertCircle}
          title={
            detail.error
              ? t(($) => $.detail.load_error_title)
              : t(($) => $.detail.not_found_title)
          }
          description={
            detail.error instanceof Error && detail.error.message
              ? detail.error.message
              : detail.error
                ? t(($) => $.detail.load_error_description)
                : t(($) => $.detail.not_found_description)
          }
          action={
            detail.error ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void detail.refetch()}
              >
                {t(($) => $.detail.retry_action)}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const activeVersion = plugin.activeVersion;
  const candidateVersion = plugin.candidateVersion;
  const versionHistory = versions.data ?? [];
  const actionPending = activate.isPending || rollback.isPending;

  const handleVersionAction = async () => {
    if (!versionAction) return;
    try {
      if (versionAction.kind === "activate") {
        await activate.mutateAsync(versionAction.version.id);
        toast.success(t(($) => $.versions.activate_success));
      } else {
        await rollback.mutateAsync(versionAction.version.id);
        toast.success(t(($) => $.versions.rollback_success));
      }
      setVersionAction(null);
    } catch (cause) {
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : versionAction.kind === "activate"
            ? t(($) => $.versions.activate_failed)
            : t(($) => $.versions.rollback_failed),
      );
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BreadcrumbHeader
        segments={[
          { href: paths.plugins(), label: t(($) => $.detail.back_action) },
        ]}
        leaf={
          <span className="flex min-w-0 items-center gap-2">
            <Puzzle className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{plugin.name}</span>
            <Badge variant="outline" className="shrink-0 capitalize">
              {t(($) => $.provider[plugin.provider])}
            </Badge>
          </span>
        }
        actions={
          <Button type="button" size="sm" onClick={() => setImportOpen(true)}>
            <Upload />
            <span className="hidden sm:inline">
              {t(($) => $.versions.import_action)}
            </span>
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-6xl gap-5 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
          <section className="min-w-0 space-y-4">
            <div>
              <h1 className="text-lg font-semibold">{plugin.name}</h1>
              {plugin.description && (
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                  {plugin.description}
                </p>
              )}
            </div>

            <dl className="grid overflow-hidden rounded-md border sm:grid-cols-2">
              <VersionPanel
                label={t(($) => $.detail.active_version)}
                version={activeVersion}
              />
              <VersionPanel
                label={t(($) => $.detail.candidate_version)}
                version={candidateVersion}
              />
            </dl>

            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  <History className="h-4 w-4 text-muted-foreground" />
                  {t(($) => $.versions.title)}
                </h2>
                {!versions.isLoading && (
                  <span className="font-mono text-xs text-muted-foreground">
                    {versionHistory.length}
                  </span>
                )}
              </div>
              {versions.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ) : versions.error ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  <span className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {t(($) => $.versions.load_error)}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void versions.refetch()}
                  >
                    {t(($) => $.detail.retry_action)}
                  </Button>
                </div>
              ) : versionHistory.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                  {t(($) => $.versions.empty)}
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {versionHistory.map((version) => {
                    const isActive = version.id === plugin.activeVersionId;
                    const isCandidate = version.id === plugin.candidateVersionId;
                    return (
                      <li
                        key={version.id}
                        className="flex min-w-0 items-start gap-3 px-3 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-medium">
                              {version.version}
                            </span>
                            {isActive && (
                              <Badge className="border-transparent bg-success/10 text-success">
                                <CheckCircle2 />
                                {t(($) => $.versions.active_badge)}
                              </Badge>
                            )}
                            {isCandidate && (
                              <Badge variant="secondary">
                                {t(($) => $.versions.candidate_badge)}
                              </Badge>
                            )}
                          </div>
                          <p
                            className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                            title={version.artifactDigest}
                          >
                            {version.artifactDigest}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {t(($) => $.versions.meta, {
                              count: version.files.length,
                              size: formatBytes(version.artifactSize),
                              when: timeAgo(version.createdAt),
                            })}
                          </p>
                        </div>
                        {!isActive && isCandidate && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={actionPending}
                            onClick={() =>
                              setVersionAction({ kind: "activate", version })
                            }
                          >
                            <CheckCircle2 />
                            {t(($) => $.versions.activate_action)}
                          </Button>
                        )}
                        {!isActive && !isCandidate && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0"
                            disabled={actionPending}
                            onClick={() =>
                              setVersionAction({ kind: "rollback", version })
                            }
                          >
                            <RotateCcw />
                            {t(($) => $.versions.rollback_action)}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium">
                {t(($) => $.detail.source)}
              </h2>
              <dl className="grid divide-y rounded-md border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                <Fact
                  label={t(($) => $.detail.source_type)}
                  value={plugin.sourceType}
                />
                <Fact
                  label={t(($) => $.detail.source_ref)}
                  value={plugin.sourceRef || plugin.sourceUrl || "-"}
                />
              </dl>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium">
                {t(($) => $.detail.manifest)}
              </h2>
              {activeVersion ? (
                <pre className="max-h-[420px] overflow-auto rounded-md border bg-muted/30 p-4 font-mono text-xs leading-relaxed">
                  {JSON.stringify(activeVersion.manifest, null, 2)}
                </pre>
              ) : (
                <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                  {t(($) => $.detail.no_active_version)}
                </p>
              )}
            </section>
          </section>

          <aside className="min-w-0 space-y-5">
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-medium">
                  {t(($) => $.readiness.title)}
                </h2>
                <span className="font-mono text-xs text-muted-foreground">
                  {runtimes.data?.length ?? 0}
                </span>
              </div>
              <PluginReadinessList
                pluginId={plugin.id}
                states={runtimes.data ?? []}
                isLoading={runtimes.isLoading}
                error={runtimes.error}
              />
            </section>

            <section>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
                <FileJson2 className="h-4 w-4 text-muted-foreground" />
                {t(($) => $.detail.active_version)}
              </h2>
              <dl className="divide-y rounded-md border">
                <Fact
                  label={t(($) => $.detail.bindings)}
                  value={plugin.bindingCount}
                />
                <Fact
                  label={t(($) => $.detail.files)}
                  value={activeVersion?.files.length ?? 0}
                />
                <Fact
                  label={t(($) => $.detail.artifact_size)}
                  value={formatBytes(activeVersion?.artifactSize ?? 0)}
                />
                <Fact
                  label={t(($) => $.detail.digest)}
                  value={activeVersion?.artifactDigest ?? "-"}
                />
              </dl>
            </section>

            {activeVersion &&
              Object.keys(activeVersion.requirements).length > 0 && (
                <section>
                  <h2 className="mb-2 text-sm font-medium">
                    {t(($) => $.detail.requirements)}
                  </h2>
                  <pre className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                    {JSON.stringify(activeVersion.requirements, null, 2)}
                  </pre>
                </section>
              )}
          </aside>
        </div>
      </div>

      <PluginImportDialog
        provider={plugin.provider}
        targetPlugin={plugin}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      <AlertDialog
        open={Boolean(versionAction)}
        onOpenChange={(open) => {
          if (!open && !actionPending) setVersionAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {versionAction?.kind === "activate"
                ? t(($) => $.versions.activate_confirm_title)
                : t(($) => $.versions.rollback_confirm_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {versionAction?.kind === "activate"
                ? t(($) => $.versions.activate_confirm_description, {
                    version: versionAction.version.version,
                  })
                : t(($) => $.versions.rollback_confirm_description, {
                    version: versionAction?.version.version ?? "",
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionPending}>
              {t(($) => $.versions.cancel_action)}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={actionPending}
              onClick={(event) => {
                event.preventDefault();
                void handleVersionAction();
              }}
            >
              {actionPending && <Loader2 className="animate-spin" />}
              {versionAction?.kind === "activate"
                ? t(($) => $.versions.activate_action)
                : t(($) => $.versions.rollback_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
