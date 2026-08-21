"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import { repositoryListOptions } from "@multiremi/core/repositories";
import { scmConnectionsOptions, scmKeys } from "@multiremi/core/scm";
import type {
  CreateScmConnectionRequest,
  ScmConnection,
  ScmConnectionMode,
  ScmProvider,
  UpdateScmConnectionRequest,
} from "@multiremi/core/types";
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
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";
import { GitHubMark } from "./github-mark";

interface ConnectionDraft {
  name: string;
  provider: ScmProvider;
  mode: ScmConnectionMode;
  baseUrl: string;
  apiBaseUrl: string;
  accessToken: string;
  webhookSecret: string;
  pollIntervalSeconds: string;
  enabled: boolean;
  repositoryIds: string[];
}

function defaults(provider: ScmProvider): ConnectionDraft {
  return {
    name: provider === "github" ? "GitHub" : "Codebase",
    provider,
    mode: "poll",
    baseUrl: provider === "github" ? "https://github.com" : "https://code.byted.org",
    apiBaseUrl:
      provider === "github" ? "https://api.github.com" : "https://codebase-api.byted.org/v2",
    accessToken: "",
    webhookSecret: "",
    pollIntervalSeconds: "60",
    enabled: true,
    repositoryIds: [],
  };
}

function fromConnection(connection: ScmConnection): ConnectionDraft {
  return {
    name: connection.name,
    provider: connection.provider,
    mode: connection.mode,
    baseUrl: connection.baseUrl ?? "",
    apiBaseUrl: connection.apiBaseUrl ?? "",
    accessToken: "",
    webhookSecret: "",
    pollIntervalSeconds: String(connection.pollIntervalSeconds),
    enabled: connection.enabled,
    repositoryIds: connection.repositories.map((repository) => repository.repositoryId),
  };
}

export function ScmConnectionsSection({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery(scmConnectionsOptions(workspaceId));
  const { data: repositoriesResponse } = useQuery(repositoryListOptions(workspaceId));
  const connections = data?.connections ?? [];
  const repositories = repositoriesResponse?.repositories ?? [];
  const [editing, setEditing] = useState<ScmConnection | "new" | null>(null);
  const [draft, setDraft] = useState<ConnectionDraft>(() => defaults("github"));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ScmConnection | null>(null);
  const existingConnection = editing && editing !== "new" ? editing : null;
  const compatibleRepositories = useMemo(
    () => repositories.filter((repository) =>
      repository.source === "unknown" || repository.source === draft.provider),
    [draft.provider, repositories],
  );

  const openCreate = () => {
    setDraft(defaults("github"));
    setEditing("new");
  };
  const openEdit = (connection: ScmConnection) => {
    setDraft(fromConnection(connection));
    setEditing(connection);
  };
  const updateDraft = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const webhookUrl = useMemo(() => {
    if (!editing || editing === "new") return null;
    const configuredBase = api.getBaseUrl();
    const base = (
      configuredBase || (typeof window !== "undefined" ? window.location.origin : "")
    ).replace(/\/$/u, "");
    return `${base}/api/webhooks/scm/${editing.id}`;
  }, [editing]);

  const handleSave = async () => {
    if (!editing || saving || !draft.name.trim()) return;
    setSaving(true);
    try {
      const pollIntervalSeconds = Math.max(15, Number(draft.pollIntervalSeconds) || 60);
      if (editing === "new") {
        const input: CreateScmConnectionRequest = {
          name: draft.name.trim(),
          provider: draft.provider,
          mode: draft.mode,
          baseUrl: draft.baseUrl.trim() || undefined,
          apiBaseUrl: draft.apiBaseUrl.trim() || undefined,
          accessToken: draft.accessToken.trim() || undefined,
          webhookSecret: draft.webhookSecret.trim() || undefined,
          pollIntervalSeconds,
          enabled: draft.enabled,
          repositoryIds: draft.repositoryIds,
        };
        await api.createScmConnection(workspaceId, input);
      } else {
        const input: UpdateScmConnectionRequest = {
          name: draft.name.trim(),
          mode: draft.mode,
          baseUrl: draft.baseUrl.trim() || null,
          apiBaseUrl: draft.apiBaseUrl.trim() || null,
          pollIntervalSeconds,
          enabled: draft.enabled,
          ...(draft.accessToken.trim() ? { accessToken: draft.accessToken.trim() } : {}),
          ...(draft.webhookSecret.trim() ? { webhookSecret: draft.webhookSecret.trim() } : {}),
        };
        await api.updateScmConnection(workspaceId, editing.id, input);
        const previousIds = new Set(
          editing.repositories.map((repository) => repository.repositoryId),
        );
        const nextIds = new Set(draft.repositoryIds);
        await Promise.all([
          ...draft.repositoryIds
            .filter((repositoryId) => !previousIds.has(repositoryId))
            .map((repositoryId) =>
              api.bindScmRepository(workspaceId, editing.id, repositoryId),
            ),
          ...editing.repositories
            .filter((repository) => !nextIds.has(repository.repositoryId))
            .map((repository) =>
              api.unbindScmRepository(workspaceId, editing.id, repository.repositoryId),
            ),
        ]);
      }
      await queryClient.invalidateQueries({ queryKey: scmKeys.all(workspaceId) });
      setEditing(null);
      toast.success(t(($) => $.github.scm.toast_saved));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.github.scm.toast_save_failed),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await api.deleteScmConnection(workspaceId, deleting.id);
      await queryClient.invalidateQueries({ queryKey: scmKeys.all(workspaceId) });
      setDeleting(null);
      toast.success(t(($) => $.github.scm.toast_deleted));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.github.scm.toast_delete_failed),
      );
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.github.scm.title)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.github.scm.description)}
          </p>
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={openCreate}>
            <Plus className="size-3.5" />
            {t(($) => $.github.scm.add_connection)}
          </Button>
        )}
      </div>

      {isLoading ? (
        <Card><CardContent className="text-sm text-muted-foreground">{t(($) => $.github.scm.loading)}</CardContent></Card>
      ) : connections.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">{t(($) => $.github.scm.empty_title)}</p>
              <p className="text-xs text-muted-foreground">{t(($) => $.github.scm.empty_description)}</p>
            </div>
            {canManage && <Button size="sm" onClick={openCreate}>{t(($) => $.github.scm.add_connection)}</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {connections.map((connection) => (
            <Card key={connection.id}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <ProviderIcon provider={connection.provider} />
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{connection.name}</p>
                      <Badge variant="outline">{providerLabel(connection.provider)}</Badge>
                      <ModeBadge mode={connection.mode} />
                      {!connection.enabled && <Badge variant="secondary">{t(($) => $.github.scm.disabled)}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t(($) => $.github.scm.repository_count, { count: connection.repositories.length })}
                      {" · "}
                      {connection.accessTokenSet
                        ? t(($) => $.github.scm.token_configured, { hint: connection.accessTokenHint ?? "" })
                        : t(($) => $.github.scm.token_missing)}
                    </p>
                    {connection.repositories.length > 0 && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {connection.repositories.slice(0, 5).map((repository) => (
                          <span key={repository.id} className="inline-flex items-center gap-1">
                            <GitBranch className="size-3" />{repository.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1">
                    <Button size="icon-sm" variant="ghost" onClick={() => openEdit(connection)} title={t(($) => $.github.scm.edit)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => setDeleting(connection)} title={t(($) => $.github.scm.delete)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && !saving && setEditing(null)}>
        <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? t(($) => $.github.scm.create_title) : t(($) => $.github.scm.edit_title)}</DialogTitle>
            <DialogDescription>{t(($) => $.github.scm.dialog_description)}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label>{t(($) => $.github.scm.provider)}</Label>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
                {(["github", "codebase"] as const).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    disabled={editing !== "new"}
                    onClick={() => setDraft((current) => ({
                      ...defaults(provider),
                      repositoryIds: current.repositoryIds.filter((repositoryId) => {
                        const repository = repositories.find((candidate) => candidate.id === repositoryId);
                        return repository?.source === "unknown" || repository?.source === provider;
                      }),
                    }))}
                    className={cn(
                      "flex h-9 items-center justify-center gap-2 rounded text-sm",
                      draft.provider === provider ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
                      editing !== "new" && "cursor-not-allowed",
                    )}
                  >
                    <ProviderIcon provider={provider} compact />
                    {providerLabel(provider)}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t(($) => $.github.scm.name)}>
                <Input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} />
              </Field>
              <Field label={t(($) => $.github.scm.mode)}>
                <Select value={draft.mode} onValueChange={(value) => updateDraft("mode", value as ScmConnectionMode)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="poll">{t(($) => $.github.scm.modes.poll)}</SelectItem>
                    <SelectItem value="webhook">{t(($) => $.github.scm.modes.webhook)}</SelectItem>
                    <SelectItem value="hybrid">{t(($) => $.github.scm.modes.hybrid)}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t(($) => $.github.scm.base_url)}>
                <Input value={draft.baseUrl} onChange={(event) => updateDraft("baseUrl", event.target.value)} />
              </Field>
              <Field label={t(($) => $.github.scm.api_base_url)}>
                <Input value={draft.apiBaseUrl} onChange={(event) => updateDraft("apiBaseUrl", event.target.value)} />
              </Field>
            </div>

            <Field label={t(($) => $.github.scm.access_token)} hint={existingConnection?.accessTokenSet ? t(($) => $.github.scm.secret_keep_hint) : undefined}>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input type="password" autoComplete="new-password" className="pl-9" value={draft.accessToken} onChange={(event) => updateDraft("accessToken", event.target.value)} placeholder={existingConnection?.accessTokenSet ? existingConnection.accessTokenHint ?? "••••••••" : t(($) => $.github.scm.access_token_placeholder)} />
              </div>
            </Field>

            {(draft.mode === "poll" || draft.mode === "hybrid") && (
              <Field label={t(($) => $.github.scm.poll_interval)} hint={t(($) => $.github.scm.poll_hint)}>
                <Input type="number" min={15} max={3600} value={draft.pollIntervalSeconds} onChange={(event) => updateDraft("pollIntervalSeconds", event.target.value)} />
              </Field>
            )}

            {(draft.mode === "webhook" || draft.mode === "hybrid") && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-start gap-2">
                  <Webhook className="mt-0.5 size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{t(($) => $.github.scm.webhook_title)}</p>
                    {webhookUrl && <code className="mt-1 block truncate text-xs text-muted-foreground">{webhookUrl}</code>}
                  </div>
                </div>
                <Field label={t(($) => $.github.scm.webhook_secret)} hint={existingConnection?.webhookSecretSet ? t(($) => $.github.scm.secret_keep_hint) : undefined}>
                  <Input type="password" autoComplete="new-password" value={draft.webhookSecret} onChange={(event) => updateDraft("webhookSecret", event.target.value)} placeholder={existingConnection?.webhookSecretSet ? existingConnection.webhookSecretHint ?? "••••••••" : t(($) => $.github.scm.webhook_secret_placeholder)} />
                </Field>
              </div>
            )}

            <div className="space-y-2">
              <Label>{t(($) => $.github.scm.repositories)}</Label>
              <div className="max-h-44 overflow-y-auto rounded-md border">
                {compatibleRepositories.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">{t(($) => $.github.scm.no_repositories)}</p>
                ) : compatibleRepositories.map((repository) => {
                  const checked = draft.repositoryIds.includes(repository.id);
                  return (
                    <label key={repository.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/40">
                      <Checkbox checked={checked} onCheckedChange={(value) => updateDraft("repositoryIds", value ? [...draft.repositoryIds, repository.id] : draft.repositoryIds.filter((id) => id !== repository.id))} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{repository.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{repository.url}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
              <div><p className="text-sm font-medium">{t(($) => $.github.scm.enabled)}</p><p className="text-xs text-muted-foreground">{t(($) => $.github.scm.enabled_hint)}</p></div>
              <Switch checked={draft.enabled} onCheckedChange={(value) => updateDraft("enabled", value)} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>{t(($) => $.github.scm.cancel)}</Button>
            <Button onClick={handleSave} disabled={saving || !draft.name.trim()}>{saving ? t(($) => $.github.scm.saving) : t(($) => $.github.scm.save)}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.github.scm.delete_title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.github.scm.delete_description, { name: deleting?.name ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.github.scm.cancel)}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t(($) => $.github.scm.delete)}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>;
}

function providerLabel(provider: ScmProvider): string {
  return provider === "github" ? "GitHub" : "Codebase";
}

function ProviderIcon({ provider, compact = false }: { provider: ScmProvider; compact?: boolean }) {
  const className = compact ? "size-4" : "size-5";
  return provider === "github" ? (
    <GitHubMark className={className} />
  ) : (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-md border bg-muted/40", compact ? "size-5" : "size-9")}>
      <GitBranch className={className} />
    </span>
  );
}

function ModeBadge({ mode }: { mode: ScmConnectionMode }) {
  const { t } = useT("settings");
  const Icon = mode === "webhook" ? Webhook : RefreshCw;
  return <Badge variant="secondary" className="gap-1"><Icon className="size-3" />{t(($) => $.github.scm.modes[mode])}</Badge>;
}
