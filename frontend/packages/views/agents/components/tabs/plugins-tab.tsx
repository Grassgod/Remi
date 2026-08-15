"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Loader2,
  Plus,
  Puzzle,
  Settings2,
  Trash2,
} from "lucide-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Agent } from "@multiremi/core/types";
import type {
  AgentPlugin,
  AgentPluginBinding,
  AgentPluginProvider,
  AgentPluginVersion,
  AgentPluginVersionPolicy,
} from "@multiremi/core/plugins";
import {
  agentPluginBindingsOptions,
  pluginListOptions,
  pluginRuntimeStatesOptions,
  pluginVersionsOptions,
  useCreateAgentPluginBinding,
  useDeleteAgentPluginBinding,
  useUpdateAgentPluginBinding,
} from "@multiremi/core/plugins";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { PluginReadinessList } from "../../../plugins/components/plugin-readiness-list";
import { useT } from "../../../i18n";

const EMPTY_BINDINGS: AgentPluginBinding[] = [];

function mergeVersions(
  plugin: AgentPlugin | null,
  history: AgentPluginVersion[],
): AgentPluginVersion[] {
  const candidates = [
    ...history,
    plugin?.activeVersion,
    plugin?.candidateVersion,
  ].filter((version): version is AgentPluginVersion => Boolean(version));
  return candidates.filter(
    (version, index) =>
      candidates.findIndex((candidate) => candidate.id === version.id) === index,
  );
}

function AddPluginDialog({
  agentId,
  plugins,
  open,
  onOpenChange,
}: {
  agentId: string;
  plugins: AgentPlugin[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("plugins");
  const wsId = useWorkspaceId();
  const createBinding = useCreateAgentPluginBinding(wsId, agentId);
  const [pluginId, setPluginId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<AgentPluginVersionPolicy>("follow_active");
  const [versionId, setVersionId] = useState<string | null>(null);

  const plugin = plugins.find((item) => item.id === pluginId) ?? null;
  const versionsQuery = useQuery(pluginVersionsOptions(wsId, pluginId ?? ""));
  const versions = useMemo(
    () => mergeVersions(plugin, versionsQuery.data ?? []),
    [plugin, versionsQuery.data],
  );
  const selectedVersion =
    versions.find((version) => version.id === versionId) ?? null;
  const policyLabel =
    policy === "pinned"
      ? t(($) => $.agent.pinned)
      : t(($) => $.agent.follow_active);

  const reset = () => {
    setPluginId(null);
    setPolicy("follow_active");
    setVersionId(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && !createBinding.isPending) reset();
    onOpenChange(next);
  };

  const handleAttach = async () => {
    if (!pluginId || (policy === "pinned" && !versionId)) return;
    try {
      await createBinding.mutateAsync({
        pluginId,
        versionPolicy: policy,
        versionId: policy === "pinned" ? versionId : null,
        enabled: true,
      });
      toast.success(t(($) => $.agent.attach_success));
      reset();
      onOpenChange(false);
    } catch (cause) {
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : t(($) => $.agent.attach_failed),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t(($) => $.agent.add_dialog_title)}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t(($) => $.agent.add_dialog_description)}
          </DialogDescription>
        </DialogHeader>

        {plugins.length === 0 ? (
          <div className="rounded-md border border-dashed py-10 text-center text-xs text-muted-foreground">
            {t(($) => $.agent.no_compatible)}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="agent-plugin-select">
                {t(($) => $.agent.plugin_label)}
              </Label>
              <Select
                value={pluginId}
                onValueChange={(value) => {
                  setPluginId(value);
                  setVersionId(null);
                }}
              >
                <SelectTrigger id="agent-plugin-select" className="w-full">
                  <SelectValue placeholder={t(($) => $.agent.plugin_placeholder)}>
                    {plugin?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {plugins.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="agent-plugin-policy">
                {t(($) => $.agent.policy_label)}
              </Label>
              <Select
                value={policy}
                onValueChange={(value) => {
                  if (!value) return;
                  setPolicy(value as AgentPluginVersionPolicy);
                  if (value === "follow_active") setVersionId(null);
                }}
              >
                <SelectTrigger id="agent-plugin-policy" className="w-full">
                  <SelectValue>{policyLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="follow_active">
                    {t(($) => $.agent.follow_active)}
                  </SelectItem>
                  <SelectItem value="pinned">
                    {t(($) => $.agent.pinned)}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {policy === "pinned" && (
              <div className="space-y-1.5">
                <Label htmlFor="agent-plugin-version">
                  {t(($) => $.agent.version_label)}
                </Label>
                <Select value={versionId} onValueChange={setVersionId}>
                  <SelectTrigger id="agent-plugin-version" className="w-full">
                    <SelectValue placeholder={t(($) => $.agent.version_placeholder)}>
                      {selectedVersion?.version}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        {version.version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={createBinding.isPending}
            onClick={() => handleOpenChange(false)}
          >
            {t(($) => $.agent.cancel_action)}
          </Button>
          <Button
            type="button"
            disabled={
              createBinding.isPending ||
              !pluginId ||
              (policy === "pinned" && !versionId)
            }
            onClick={() => void handleAttach()}
          >
            {createBinding.isPending && <Loader2 className="animate-spin" />}
            {createBinding.isPending
              ? t(($) => $.agent.attaching_action)
              : t(($) => $.agent.attach_action)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPluginDialog({
  agentId,
  binding,
  open,
  onOpenChange,
}: {
  agentId: string;
  binding: AgentPluginBinding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("plugins");
  const wsId = useWorkspaceId();
  const updateBinding = useUpdateAgentPluginBinding(wsId, agentId);
  const versionsQuery = useQuery(
    pluginVersionsOptions(wsId, binding?.pluginId ?? ""),
  );
  const [policy, setPolicy] = useState<AgentPluginVersionPolicy>(
    binding?.versionPolicy ?? "follow_active",
  );
  const [versionId, setVersionId] = useState<string | null>(
    binding?.versionId ?? null,
  );

  useEffect(() => {
    if (!open || !binding) return;
    setPolicy(binding.versionPolicy);
    setVersionId(binding.versionId);
  }, [binding, open]);

  const versions = useMemo(
    () => mergeVersions(binding?.plugin ?? null, versionsQuery.data ?? []),
    [binding?.plugin, versionsQuery.data],
  );
  const selectedVersion =
    versions.find((version) => version.id === versionId) ?? null;
  const policyLabel =
    policy === "pinned"
      ? t(($) => $.agent.pinned)
      : t(($) => $.agent.follow_active);

  const handleSave = async () => {
    if (!binding || (policy === "pinned" && !versionId)) return;
    try {
      await updateBinding.mutateAsync({
        bindingId: binding.id,
        input: {
          versionPolicy: policy,
          versionId: policy === "pinned" ? versionId : null,
        },
      });
      toast.success(t(($) => $.agent.update_success));
      onOpenChange(false);
    } catch (cause) {
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : t(($) => $.agent.update_failed),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t(($) => $.agent.edit_dialog_title, {
              plugin: binding?.plugin.name ?? "",
            })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t(($) => $.agent.edit_dialog_description)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-agent-plugin-policy">
              {t(($) => $.agent.policy_label)}
            </Label>
            <Select
              value={policy}
              onValueChange={(value) => {
                if (!value) return;
                setPolicy(value as AgentPluginVersionPolicy);
                if (value === "follow_active") setVersionId(null);
              }}
            >
              <SelectTrigger id="edit-agent-plugin-policy" className="w-full">
                <SelectValue>{policyLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="follow_active">
                  {t(($) => $.agent.follow_active)}
                </SelectItem>
                <SelectItem value="pinned">
                  {t(($) => $.agent.pinned)}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {policy === "pinned" && (
            <div className="space-y-1.5">
              <Label htmlFor="edit-agent-plugin-version">
                {t(($) => $.agent.version_label)}
              </Label>
              <Select value={versionId} onValueChange={setVersionId}>
                <SelectTrigger id="edit-agent-plugin-version" className="w-full">
                  <SelectValue
                    placeholder={t(($) => $.agent.version_placeholder)}
                  >
                    {selectedVersion?.version}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {versions.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      {version.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={updateBinding.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t(($) => $.agent.cancel_action)}
          </Button>
          <Button
            type="button"
            disabled={
              updateBinding.isPending ||
              (policy === "pinned" && !versionId)
            }
            onClick={() => void handleSave()}
          >
            {updateBinding.isPending && <Loader2 className="animate-spin" />}
            {updateBinding.isPending
              ? t(($) => $.agent.saving_action)
              : t(($) => $.agent.save_action)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PluginsTab({
  agent,
  provider,
  canEdit,
}: {
  agent: Agent;
  provider: AgentPluginProvider;
  canEdit: boolean;
}) {
  const { t } = useT("plugins");
  const wsId = useWorkspaceId();
  const [addOpen, setAddOpen] = useState(false);
  const [editingBinding, setEditingBinding] =
    useState<AgentPluginBinding | null>(null);
  const bindingsQuery = useQuery(agentPluginBindingsOptions(wsId, agent.id));
  const catalogQuery = useQuery(pluginListOptions(wsId, provider));
  const updateBinding = useUpdateAgentPluginBinding(wsId, agent.id);
  const deleteBinding = useDeleteAgentPluginBinding(wsId, agent.id);

  const bindings = bindingsQuery.data ?? EMPTY_BINDINGS;
  const runtimeQueries = useQueries({
    queries: bindings.map((binding) =>
      pluginRuntimeStatesOptions(wsId, binding.pluginId),
    ),
  });
  const attachedIds = useMemo(
    () => new Set(bindings.map((binding) => binding.pluginId)),
    [bindings],
  );
  const availablePlugins = useMemo(
    () =>
      (catalogQuery.data ?? []).filter(
        (plugin) =>
          plugin.provider === provider && !attachedIds.has(plugin.id),
      ),
    [catalogQuery.data, provider, attachedIds],
  );

  const handleEnabledChange = async (bindingId: string, enabled: boolean) => {
    try {
      await updateBinding.mutateAsync({ bindingId, input: { enabled } });
    } catch (cause) {
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : t(($) => $.agent.attach_failed),
      );
    }
  };

  const handleRemove = async (bindingId: string) => {
    try {
      await deleteBinding.mutateAsync(bindingId);
      toast.success(t(($) => $.agent.remove_success));
    } catch (cause) {
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : t(($) => $.agent.remove_failed),
      );
    }
  };

  if (bindingsQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t(($) => $.agent.intro)}
        </p>
        {canEdit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setAddOpen(true)}
          >
            <Plus />
            {t(($) => $.agent.add_action)}
          </Button>
        )}
      </div>

      {bindingsQuery.error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {t(($) => $.agent.load_error)}
        </div>
      ) : bindings.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-12 text-center">
          <Puzzle className="h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">
            {t(($) => $.agent.empty_title)}
          </p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t(($) => $.agent.empty_description)}
          </p>
          {canEdit && availablePlugins.length > 0 && (
            <Button
              type="button"
              size="sm"
              className="mt-4"
              onClick={() => setAddOpen(true)}
            >
              <Plus />
              {t(($) => $.agent.add_action)}
            </Button>
          )}
        </div>
      ) : (
        <ul className="divide-y rounded-md border">
          {bindings.map((binding, index) => {
            const runtimeQuery = runtimeQueries[index];
            return (
              <li key={binding.id} className="space-y-3 p-3">
                <div className="flex min-w-0 items-start gap-3">
                  <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {binding.plugin.name}
                      </span>
                      <Badge variant="outline" className="capitalize">
                        {t(($) => $.provider[binding.plugin.provider])}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {binding.resolvedVersion?.version ?? "-"}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {binding.versionPolicy === "pinned"
                        ? t(($) => $.agent.pinned)
                        : t(($) => $.agent.follow_active)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {binding.enabled
                        ? t(($) => $.agent.enabled)
                        : t(($) => $.agent.disabled)}
                    </span>
                    <Switch
                      size="sm"
                      checked={binding.enabled}
                      disabled={!canEdit || updateBinding.isPending}
                      onCheckedChange={(enabled) =>
                        void handleEnabledChange(binding.id, enabled)
                      }
                      aria-label={
                        binding.enabled
                          ? t(($) => $.agent.enabled)
                          : t(($) => $.agent.disabled)
                      }
                    />
                    {canEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        aria-label={t(($) => $.agent.configure_action)}
                        title={t(($) => $.agent.configure_action)}
                        onClick={() => setEditingBinding(binding)}
                      >
                        <Settings2 />
                      </Button>
                    )}
                    {canEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        disabled={deleteBinding.isPending}
                        aria-label={t(($) => $.agent.remove_action)}
                        title={t(($) => $.agent.remove_action)}
                        onClick={() => void handleRemove(binding.id)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>

                <PluginReadinessList
                  pluginId={binding.pluginId}
                  states={runtimeQuery?.data ?? []}
                  isLoading={runtimeQuery?.isLoading ?? false}
                  error={runtimeQuery?.error ?? null}
                  compact
                  allowRetry={canEdit}
                />
              </li>
            );
          })}
        </ul>
      )}

      <AddPluginDialog
        agentId={agent.id}
        plugins={availablePlugins}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
      <EditPluginDialog
        agentId={agent.id}
        binding={editingBinding}
        open={Boolean(editingBinding)}
        onOpenChange={(open) => {
          if (!open) setEditingBinding(null);
        }}
      />
    </div>
  );
}
