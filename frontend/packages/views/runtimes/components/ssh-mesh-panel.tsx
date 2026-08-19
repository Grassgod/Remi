"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Network,
  RefreshCw,
  RotateCw,
  Server,
  ServerCog,
  ShieldAlert,
  Terminal,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { ApiContractError, ApiError } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWSEvent } from "@multiremi/core/realtime";
import {
  runtimeKeys,
  sshMeshOptions,
  useRotateSshMeshKey,
  useSetSshMeshEnabled,
  useTestSshMeshConnection,
  type SshMeshRuntime,
} from "@multiremi/core/runtimes";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@multiremi/ui/components/ui/alert-dialog";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { cn } from "@multiremi/ui/lib/utils";
import { useT, useTimeAgo } from "../../i18n";

interface SshMeshPanelProps {
  sourceDaemonId: string | null;
  sourceName: string;
}

export function SshMeshPanel({
  sourceDaemonId,
  sourceName,
}: SshMeshPanelProps) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const toggleId = useId();
  const sourceSelectId = useId();
  const [emergencyDisableOpen, setEmergencyDisableOpen] = useState(false);
  const [sourceOverride, setSourceOverride] = useState<{
    defaultSourceId: string | null;
    nodeId: string;
  } | null>(null);
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const lastHeartbeatRefreshRef = useRef(0);
  const membersQuery = useQuery(memberListOptions(wsId));
  const member = membersQuery.data?.find(
    (candidate) => candidate.user_id === user?.id,
  );
  const canManage = member?.role === "owner" || member?.role === "admin";
  const meshQuery = useQuery({
    ...sshMeshOptions(wsId),
    enabled: Boolean(wsId && canManage),
  });
  const toggleMutation = useSetSshMeshEnabled(wsId);
  const rotateMutation = useRotateSshMeshKey(wsId);
  const testMutation = useTestSshMeshConnection(wsId);

  const actionErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof ApiContractError) {
      return t(($) => $.ssh_mesh.error_invalid_response);
    }
    if (error instanceof ApiError) {
      const body = error.body && typeof error.body === "object"
        ? error.body as Record<string, unknown>
        : null;
      if (
        error.status === 409 &&
        body?.code === "ssh_mesh_expiring_daemon_credentials"
      ) {
        return t(($) => $.ssh_mesh.error_expiring_credentials);
      }
      if (error.status === 403) {
        return t(($) => $.ssh_mesh.error_forbidden);
      }
      if (error.status === 409) {
        return t(($) => $.ssh_mesh.error_conflict);
      }
      if (error.status === 503) {
        return t(($) => $.ssh_mesh.error_server_setup);
      }
      return fallback;
    }
    if (error instanceof TypeError) {
      return t(($) => $.ssh_mesh.error_network);
    }
    return fallback;
  };

  const refreshFromDaemonEvent = useCallback(() => {
    const now = Date.now();
    if (now - lastHeartbeatRefreshRef.current < 10_000) return;
    lastHeartbeatRefreshRef.current = now;
    queryClient.invalidateQueries({ queryKey: runtimeKeys.sshMesh(wsId) });
  }, [queryClient, wsId]);
  useWSEvent("daemon:heartbeat", refreshFromDaemonEvent);
  useWSEvent("daemon:register", refreshFromDaemonEvent);
  useWSEvent("daemon:retired", refreshFromDaemonEvent);

  if (membersQuery.isPending) return <SshMeshSkeleton />;

  if (membersQuery.isError) {
    return (
      <PanelLoadError
        title={t(($) => $.ssh_mesh.permission_load_failed_title)}
        hint={t(($) => $.ssh_mesh.permission_load_failed_hint)}
        retryLabel={t(($) => $.ssh_mesh.retry)}
        retrying={membersQuery.isFetching}
        onRetry={() => void membersQuery.refetch()}
      />
    );
  }

  if (!canManage) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <ShieldAlert className="size-8 text-muted-foreground/40" />
        <p className="mt-3 text-sm font-medium">
          {t(($) => $.ssh_mesh.manage_only_title)}
        </p>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          {t(($) => $.ssh_mesh.manage_only_hint)}
        </p>
      </div>
    );
  }

  if (meshQuery.isPending) return <SshMeshSkeleton />;

  if (meshQuery.isError || !meshQuery.data) {
    return (
      <PanelLoadError
        title={t(($) => $.ssh_mesh.load_failed_title)}
        hint={t(($) => $.ssh_mesh.load_failed_hint)}
        retryLabel={t(($) => $.ssh_mesh.retry)}
        retrying={meshQuery.isFetching}
        onRetry={() => void meshQuery.refetch()}
      />
    );
  }

  const overview = meshQuery.data;
  const nodes = overview.nodes;
  const platformNodes = nodes.filter((node) => node.node_type === "control_plane");
  const runtimeNodes = nodes.filter((node) => node.node_type === "runtime");
  const otherNodes = nodes.filter(
    (node) => node.node_type !== "control_plane" && node.node_type !== "runtime",
  );
  const requestedSourceId = sourceOverride?.defaultSourceId === sourceDaemonId
    ? sourceOverride.nodeId
    : sourceDaemonId;
  const source = nodes.find((node) => node.node_id === requestedSourceId)
    ?? platformNodes[0]
    ?? nodes[0];
  const sourceNodeId = source?.node_id ?? null;
  const sourceLabel = source ? nodeLabel(source) : sourceName;
  const peers = nodes.filter((node) => node.node_id !== sourceNodeId);
  const sourceIsTesting =
    !!source && source.desired_probe_revision > source.probe_revision;
  const rotationInProgress = overview.rotation_state === "rolling_out";
  const canProbe = Boolean(
    source &&
    source.status === "ready" &&
    peers.length > 0 &&
    !rotationInProgress &&
    !sourceIsTesting &&
    !toggleMutation.isPending &&
    !rotateMutation.isPending &&
    !testMutation.isPending,
  );

  const submitToggle = (enabled: boolean, invalidateKeys = false) => {
    toggleMutation.mutate({
      enabled,
      ...(invalidateKeys ? { invalidateKeys: true } : {}),
    }, {
      onSuccess: () =>
        toast.success(
          enabled
            ? t(($) => $.ssh_mesh.toast_enabled)
            : t(($) => $.ssh_mesh.toast_disabled),
        ),
      onError: (error) =>
        toast.error(
          actionErrorMessage(
            error,
            t(($) => $.ssh_mesh.toast_toggle_failed),
          ),
        ),
    });
  };

  const toggleMesh = (enabled: boolean) => {
    if (!enabled && rotationInProgress) {
      setEmergencyDisableOpen(true);
      return;
    }
    submitToggle(enabled);
  };

  const confirmEmergencyDisable = () => {
    setEmergencyDisableOpen(false);
    submitToggle(false, true);
  };

  const testConnection = (targetDaemonId?: string) => {
    if (!sourceNodeId || !canProbe) return;
    testMutation.mutate(
      { sourceDaemonId: sourceNodeId, targetDaemonId },
      {
        onSuccess: () => toast.success(t(($) => $.ssh_mesh.toast_test_started)),
        onError: (error) =>
          toast.error(
            actionErrorMessage(
              error,
              t(($) => $.ssh_mesh.toast_test_failed),
            ),
          ),
      },
    );
  };

  const toggleControl = (
    <Switch
      id={toggleId}
      checked={overview.enabled === true}
      disabled={toggleMutation.isPending || rotateMutation.isPending}
      onCheckedChange={toggleMesh}
    />
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="border-b px-5 py-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Network className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">
                {t(($) => $.ssh_mesh.title)}
              </h3>
              {overview.enabled && (
                <StatusBadge status={overview.rotation_state === "rolling_out" ? "syncing" : "ready"} />
              )}
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              {overview.enabled
                ? t(($) => $.ssh_mesh.enabled_hint)
                : t(($) => $.ssh_mesh.disabled_hint)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
            <label htmlFor={toggleId}>
              {t(($) => $.ssh_mesh.enabled_label)}
            </label>
            {toggleControl}
          </div>
        </div>

        {overview.enabled && (
          <div className="mt-4 flex flex-col gap-3 border-t pt-4 lg:flex-row lg:items-center lg:justify-between">
            <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-muted-foreground">
                  {t(($) => $.ssh_mesh.fingerprint)}
                </dt>
                <dd className="mt-0.5 truncate font-mono" title={overview.fingerprint ?? undefined}>
                  {overview.fingerprint ?? t(($) => $.ssh_mesh.not_available)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t(($) => $.ssh_mesh.key_version)}
                </dt>
                <dd className="mt-0.5 font-mono tabular-nums">
                  {t(($) => $.ssh_mesh.key_version_value, {
                    version: overview.key_version,
                  })}
                  <span className="ml-2 text-muted-foreground">
                    {t(($) => $.ssh_mesh.config_revision, {
                      revision: shortRevision(overview.config_revision),
                    })}
                  </span>
                </dd>
              </div>
            </dl>

            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      toggleMutation.isPending ||
                      rotationInProgress ||
                      rotateMutation.isPending
                    }
                  />
                }
              >
                {overview.rotation_state === "rolling_out" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5" />
                )}
                {overview.rotation_state === "rolling_out"
                  ? t(($) => $.ssh_mesh.rotation_progress, {
                      ready: overview.rotation_ready_nodes,
                      total: overview.rotation_total_nodes,
                    })
                  : t(($) => $.ssh_mesh.rotate)}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t(($) => $.ssh_mesh.rotate_title)}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t(($) => $.ssh_mesh.rotate_description)}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>
                    {t(($) => $.ssh_mesh.cancel)}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      rotateMutation.mutate(undefined, {
                        onSuccess: () =>
                          toast.success(t(($) => $.ssh_mesh.toast_rotation_started)),
                        onError: (error) =>
                          toast.error(
                            actionErrorMessage(
                              error,
                              t(($) => $.ssh_mesh.toast_rotation_failed),
                            ),
                          ),
                      })
                    }
                  >
                    {t(($) => $.ssh_mesh.rotate_confirm)}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </section>

      {overview.enabled && (
        <>
          <MeshNodeSection
            title={t(($) => $.ssh_mesh.platform_nodes_title)}
            hint={t(($) => $.ssh_mesh.platform_nodes_hint)}
            empty={t(($) => $.ssh_mesh.platform_nodes_empty)}
            nodes={platformNodes}
            sourceNodeId={sourceNodeId}
          />

          <MeshNodeSection
            title={t(($) => $.ssh_mesh.runtime_nodes_title)}
            hint={t(($) => $.ssh_mesh.runtime_nodes_hint)}
            empty={t(($) => $.ssh_mesh.runtime_nodes_empty)}
            nodes={runtimeNodes}
            sourceNodeId={sourceNodeId}
          />

          {otherNodes.length > 0 && (
            <MeshNodeSection
              title={t(($) => $.ssh_mesh.other_nodes_title)}
              hint={t(($) => $.ssh_mesh.other_nodes_hint)}
              empty={t(($) => $.ssh_mesh.other_nodes_empty)}
              nodes={otherNodes}
              sourceNodeId={sourceNodeId}
            />
          )}

          <section>
            <div className="flex flex-col gap-3 px-5 py-3 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                  {t(($) => $.ssh_mesh.connectivity_title)}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(($) => $.ssh_mesh.connectivity_hint)}
                </p>
              </div>
              <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-end lg:w-auto">
                <div className="min-w-0 flex-1 space-y-1 lg:w-72">
                  <label
                    htmlFor={sourceSelectId}
                    className="text-xs text-muted-foreground"
                  >
                    {t(($) => $.ssh_mesh.test_source)}
                  </label>
                  <Select
                    value={sourceNodeId ?? ""}
                    onValueChange={(nodeId) => {
                      if (!nodeId) return;
                      setSourceOverride({ defaultSourceId: sourceDaemonId, nodeId });
                    }}
                  >
                    <SelectTrigger id={sourceSelectId} className="w-full">
                      <SelectValue placeholder={t(($) => $.ssh_mesh.source_missing)}>
                        {source ? (
                          <>
                            <NodeTypeIcon nodeType={source.node_type} />
                            <span className="truncate">{sourceLabel}</span>
                          </>
                        ) : null}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start" alignItemWithTrigger={false}>
                      {platformNodes.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>{t(($) => $.ssh_mesh.platform_nodes_title)}</SelectLabel>
                          {platformNodes.map((node) => (
                            <MeshSourceOption key={node.node_id} node={node} />
                          ))}
                        </SelectGroup>
                      )}
                      {runtimeNodes.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>{t(($) => $.ssh_mesh.runtime_nodes_title)}</SelectLabel>
                          {runtimeNodes.map((node) => (
                            <MeshSourceOption key={node.node_id} node={node} />
                          ))}
                        </SelectGroup>
                      )}
                      {otherNodes.length > 0 && (
                        <SelectGroup>
                          <SelectLabel>{t(($) => $.ssh_mesh.other_nodes_title)}</SelectLabel>
                          {otherNodes.map((node) => (
                            <MeshSourceOption key={node.node_id} node={node} />
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={!canProbe}
                  onClick={() => testConnection()}
                >
                  {sourceIsTesting ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {sourceIsTesting
                    ? t(($) => $.ssh_mesh.testing)
                    : t(($) => $.ssh_mesh.test_all)}
                </Button>
              </div>
            </div>

            {!source ? (
              <EmptyRow text={t(($) => $.ssh_mesh.source_missing)} />
            ) : peers.length === 0 ? (
              <EmptyRow text={t(($) => $.ssh_mesh.no_peers)} />
            ) : (
              <ul className="divide-y border-t">
                {peers.map((peer) => {
                  const result = source.peer_tests.find(
                    (candidate) => candidate.node_id === peer.node_id,
                  );
                  const testingPeer =
                    testMutation.isPending &&
                    testMutation.variables?.sourceDaemonId === sourceNodeId &&
                    testMutation.variables?.targetDaemonId === peer.node_id;
                  return (
                    <PeerConnectionRow
                      key={peer.node_id}
                      source={source}
                      peer={peer}
                      result={result}
                      testing={testingPeer || sourceIsTesting}
                      disabled={!canProbe}
                      onTest={() => testConnection(peer.node_id)}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}

      <AlertDialog
        open={emergencyDisableOpen}
        onOpenChange={setEmergencyDisableOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <ShieldAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t(($) => $.ssh_mesh.emergency_disable_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.ssh_mesh.emergency_disable_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs text-foreground">
            <li>{t(($) => $.ssh_mesh.emergency_disable_revoke_keys)}</li>
            <li>{t(($) => $.ssh_mesh.emergency_disable_break_trust)}</li>
            <li>{t(($) => $.ssh_mesh.emergency_disable_new_key)}</li>
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={toggleMutation.isPending}>
              {t(($) => $.ssh_mesh.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={toggleMutation.isPending}
              onClick={confirmEmergencyDisable}
            >
              {t(($) => $.ssh_mesh.emergency_disable_confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MeshNodeSection({
  title,
  hint,
  empty,
  nodes,
  sourceNodeId,
}: {
  title: string;
  hint: string;
  empty: string;
  nodes: SshMeshRuntime[];
  sourceNodeId: string | null;
}) {
  return (
    <section className="border-b">
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">
            {title}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {nodes.length}
        </span>
      </div>
      {nodes.length === 0 ? (
        <EmptyRow text={empty} />
      ) : (
        <ul className="divide-y border-t">
          {nodes.map((node) => (
            <MeshNodeRow
              key={node.node_id}
              node={node}
              selected={node.node_id === sourceNodeId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MeshNodeRow({
  node,
  selected,
}: {
  node: SshMeshRuntime;
  selected: boolean;
}) {
  const { t } = useT("runtimes");
  const timeAgo = useTimeAgo();
  const endpoint = node.addresses[0] ?? node.hostname;
  const endpointLabel = node.ssh_user && endpoint
    ? `${node.ssh_user}@${endpoint}${node.port === 22 ? "" : `:${node.port}`}`
    : t(($) => $.ssh_mesh.not_available);

  return (
    <li className={cn("px-5 py-3", selected && "bg-accent/40")}>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
            <NodeTypeIcon nodeType={node.node_type} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">
                {nodeLabel(node)}
              </span>
              <NodeTypeBadge nodeType={node.node_type} />
              {selected && (
                <Badge variant="secondary">
                  {t(($) => $.ssh_mesh.selected_source)}
                </Badge>
              )}
              <StatusBadge status={node.status} />
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="truncate font-mono">{endpointLabel}</span>
              {node.last_reported_at && (
                <span>{timeAgo(node.last_reported_at)}</span>
              )}
            </div>
            {node.last_error && (
              <p className="mt-1 truncate text-xs text-destructive" title={node.last_error}>
                {node.last_error}
              </p>
            )}
          </div>
        </div>
        <div className="min-w-0 shrink-0 text-left sm:text-right">
          <div className="truncate font-mono text-xs">
            <span className="mr-1 text-muted-foreground">
              {t(($) => $.ssh_mesh.ssh_alias)}
            </span>
            {node.ssh_alias
              ? `ssh ${node.ssh_alias}`
              : t(($) => $.ssh_mesh.not_available)}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {t(($) => $.ssh_mesh.runtime_revision, {
              version: node.key_version ?? "--",
              revision: shortRevision(node.config_revision),
            })}
          </div>
        </div>
      </div>
    </li>
  );
}

function PeerConnectionRow({
  source,
  peer,
  result,
  testing,
  disabled,
  onTest,
}: {
  source: SshMeshRuntime;
  peer: SshMeshRuntime;
  result: SshMeshRuntime["peer_tests"][number] | undefined;
  testing: boolean;
  disabled: boolean;
  onTest: () => void;
}) {
  const { t } = useT("runtimes");
  const timeAgo = useTimeAgo();
  const failed = result && result.status !== "ready";

  return (
    <li className="flex min-w-0 items-center gap-3 px-5 py-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
        <Terminal className="size-3.5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="flex min-w-0 items-center gap-1.5 text-sm font-medium"
            aria-label={t(($) => $.ssh_mesh.direction, {
              source: nodeLabel(source),
              target: nodeLabel(peer),
            })}
            title={t(($) => $.ssh_mesh.direction, {
              source: nodeLabel(source),
              target: nodeLabel(peer),
            })}
          >
            <span className="truncate">{nodeLabel(source)}</span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{nodeLabel(peer)}</span>
          </span>
          <NodeTypeBadge nodeType={peer.node_type} />
          {testing ? (
            <Badge variant="secondary">
              <LoaderCircle className="animate-spin" />
              {t(($) => $.ssh_mesh.testing)}
            </Badge>
          ) : (
            <StatusBadge status={result?.status ?? "unknown"} />
          )}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate font-mono">
            {peer.ssh_alias ? `ssh ${peer.ssh_alias}` : t(($) => $.ssh_mesh.not_available)}
          </span>
          {result?.latency_ms != null && (
            <span>{t(($) => $.ssh_mesh.latency, { latency: result.latency_ms })}</span>
          )}
          {result?.checked_at && (
            <span className="inline-flex items-center gap-1">
              <Clock3 className="size-3" />
              {timeAgo(result.checked_at)}
            </span>
          )}
        </div>
        {result?.error && (
          <p className="mt-1 truncate text-xs text-destructive" title={result.error}>
            {result.error}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={onTest}
        aria-label={t(($) => $.ssh_mesh.test_direction, {
          source: nodeLabel(source),
          target: nodeLabel(peer),
        })}
      >
        <RefreshCw className="size-3.5" />
        {failed ? t(($) => $.ssh_mesh.retry) : t(($) => $.ssh_mesh.test)}
      </Button>
    </li>
  );
}

function MeshSourceOption({ node }: { node: SshMeshRuntime }) {
  return (
    <SelectItem value={node.node_id}>
      <NodeTypeIcon nodeType={node.node_type} />
      <span className="truncate">{nodeLabel(node)}</span>
    </SelectItem>
  );
}

function NodeTypeIcon({ nodeType }: { nodeType: string }) {
  const Icon = nodeType === "control_plane" ? ServerCog : Server;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function NodeTypeBadge({ nodeType }: { nodeType: string }) {
  const { t } = useT("runtimes");
  const label = nodeType === "control_plane"
    ? t(($) => $.ssh_mesh.node_type.control_plane)
    : nodeType === "runtime"
      ? t(($) => $.ssh_mesh.node_type.runtime)
      : t(($) => $.ssh_mesh.node_type.unknown);
  return <Badge variant="outline">{label}</Badge>;
}

function nodeLabel(node: SshMeshRuntime): string {
  return node.name ?? node.hostname ?? node.node_id;
}

function PanelLoadError({
  title,
  hint,
  retryLabel,
  retrying,
  onRetry,
}: {
  title: string;
  hint: string;
  retryLabel: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <AlertCircle className="size-8 text-destructive/70" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">{hint}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-4"
        disabled={retrying}
        onClick={onRetry}
      >
        <RefreshCw className={cn("size-3.5", retrying && "animate-spin")} />
        {retryLabel}
      </Button>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useT("runtimes");
  const label = (() => {
    switch (status) {
      case "disabled":
        return t(($) => $.ssh_mesh.status.disabled);
      case "syncing":
        return t(($) => $.ssh_mesh.status.syncing);
      case "ready":
        return t(($) => $.ssh_mesh.status.ready);
      case "setup_required":
        return t(($) => $.ssh_mesh.status.setup_required);
      case "blocked":
        return t(($) => $.ssh_mesh.status.blocked);
      case "error":
        return t(($) => $.ssh_mesh.status.error);
      case "offline":
        return t(($) => $.ssh_mesh.status.offline);
      case "unreachable":
        return t(($) => $.ssh_mesh.status.unreachable);
      case "host_key_mismatch":
        return t(($) => $.ssh_mesh.status.host_key_mismatch);
      case "auth_failed":
        return t(($) => $.ssh_mesh.status.auth_failed);
      default:
        return t(($) => $.ssh_mesh.status.unknown);
    }
  })();
  const Icon = status === "ready"
    ? CheckCircle2
    : status === "syncing"
      ? LoaderCircle
      : status === "offline" || status === "unreachable"
        ? WifiOff
        : status === "unknown" || status === "disabled"
          ? Clock3
          : AlertCircle;
  const destructive = [
    "blocked",
    "error",
    "unreachable",
    "host_key_mismatch",
    "auth_failed",
  ].includes(status);

  return (
    <Badge
      variant={destructive ? "destructive" : "outline"}
      className={cn(
        status === "ready" && "border-success/30 bg-success/10 text-success",
        status === "syncing" && "border-warning/30 bg-warning/10 text-warning-foreground",
      )}
    >
      <Icon className={cn(status === "syncing" && "animate-spin")} />
      {label}
    </Badge>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="border-t px-5 py-10 text-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}

function shortRevision(revision: string | null): string {
  if (!revision) return "--";
  return revision.length > 10 ? revision.slice(0, 10) : revision;
}

function SshMeshSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden" aria-busy="true">
      <div className="space-y-3 border-b px-5 py-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-full max-w-lg" />
      </div>
      <div className="space-y-3 px-5 py-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  );
}
