"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, AlertCircle, Eye, EyeOff, Save, Sparkles, Waypoints } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Label } from "@multiremi/ui/components/ui/label";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { Input } from "@multiremi/ui/components/ui/input";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useCurrentWorkspace } from "@multiremi/core/paths";
import { runtimeModelsKeys } from "@multiremi/core/runtimes";
import { memberListOptions, workspaceKeys } from "@multiremi/core/workspace/queries";
import { api } from "@multiremi/core/api";
import type { RelayConfigResponse, RelayEngineConfig } from "@multiremi/core/api";
import type { Workspace } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { ClaudeMark, OpenAIMark } from "./engine-marks";

type Engine = "claude" | "codex";
type ProgressSummaryTransport = "auto" | "api" | "cli" | "openai";

interface ProgressSummarySettings {
  transport: ProgressSummaryTransport;
  model: string;
  openAiModel: string;
}

interface IssueAutoTitleSettings {
  enabled: boolean;
  model: string;
}

const ENGINE_PLACEHOLDER: Record<Engine, string> = {
  claude: '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://…"\n  }\n}',
  codex: 'model_provider = "OpenAI"\n\n[model_providers.OpenAI]\nbase_url = "https://…/v1"\nwire_api = "responses"\nrequires_openai_auth = true',
};

const relayKeys = { config: (wsId: string) => ["relay-config", wsId] as const };

export function ModelGatewayTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const { data: members = [], isPending: membersPending } = useQuery(
    memberListOptions(wsId),
  );
  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";

  const {
    data: config,
    isPending: configPending,
    isError: configError,
    error: configErrorValue,
    refetch: refetchConfig,
  } = useQuery({
    queryKey: relayKeys.config(wsId),
    queryFn: () => api.getRelayConfig(wsId),
    enabled: !!wsId && canManage,
  });

  async function toggleDiscovery(next: boolean) {
    try {
      await api.setRelayDiscovery(wsId, next);
      qc.setQueryData(relayKeys.config(wsId), (old: RelayConfigResponse | undefined) =>
        old ? { ...old, modelDiscovery: next } : old,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.modelGateway.save_failed));
    }
  }

  // Membership decides whether this tab is a form or a denial. `members`
  // defaults to [] while the query is in flight, which reads as "no role" —
  // rendering the denial then would flash it at every owner/admin who
  // deep-links `?tab=model-gateway`. Wait for the query to settle first.
  if (membersPending) {
    return <ConfigSkeleton />;
  }

  if (!canManage) {
    return <p className="text-sm text-muted-foreground">{t(($) => $.modelGateway.insufficient)}</p>;
  }

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Waypoints className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.page.tabs.model_gateway)}
        </h2>
        <p className="text-sm text-muted-foreground">{t(($) => $.modelGateway.description)}</p>
      </section>

      {/* The editors are a full replace of the stored relay config, so they
          must never render seeded from a not-yet-loaded (or failed) response:
          saving a blank textarea would wipe the fleet's gateway. Loading is a
          skeleton, failure is an explicit error with retry — neither exposes
          a savable form. */}
      {configError ? (
        <ConfigLoadError
          error={configErrorValue}
          onRetry={() => void refetchConfig()}
        />
      ) : configPending || !config ? (
        <ConfigSkeleton />
      ) : (
        <>
          {/* Fleet-wide model discovery toggle */}
          <Card>
            <CardContent>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium">{t(($) => $.modelGateway.discovery_title)}</Label>
                  <p className="text-sm text-muted-foreground">{t(($) => $.modelGateway.discovery_desc)}</p>
                </div>
                <Switch
                  checked={config.modelDiscovery === true}
                  onCheckedChange={toggleDiscovery}
                />
              </div>
            </CardContent>
          </Card>

          {workspace ? <ProgressSummarySection workspace={workspace} /> : null}
          {workspace ? <IssueAutoTitleSection workspace={workspace} /> : null}

          <EngineSection engine="claude" config={config.claude ?? null} wsId={wsId} />
          <EngineSection engine="codex" config={config.codex ?? null} wsId={wsId} />

          <p className="text-xs text-muted-foreground">{t(($) => $.modelGateway.applied_note)}</p>
        </>
      )}
    </div>
  );
}

function IssueAutoTitleSection({ workspace }: { workspace: Workspace }) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const resolved = readIssueAutoTitleSettings(workspace.settings);
  const [enabled, setEnabled] = useState(resolved.enabled);
  const [model, setModel] = useState(resolved.model);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = readIssueAutoTitleSettings(workspace.settings);
    setEnabled(next.enabled);
    setModel(next.model);
  }, [workspace.settings]);

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateWorkspace(workspace.id, {
        settings: {
          ...(workspace.settings ?? {}),
          issue_auto_title: {
            enabled,
            model: model.trim() || "gpt-5.6-luna",
          },
        },
      });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((candidate) => candidate.id === updated.id ? updated : candidate),
      );
      toast.success(t(($) => $.modelGateway.auto_title_saved));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.modelGateway.save_failed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.modelGateway.auto_title_title)}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => $.modelGateway.auto_title_description)}
        </p>
      </div>
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="issue-auto-title-enabled">
                {t(($) => $.modelGateway.auto_title_enabled_label)}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t(($) => $.modelGateway.auto_title_enabled_hint)}
              </p>
            </div>
            <Switch
              id="issue-auto-title-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-auto-title-model">
              {t(($) => $.modelGateway.auto_title_model_label)}
            </Label>
            <Input
              id="issue-auto-title-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder="gpt-5.6-luna"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {t(($) => $.modelGateway.auto_title_model_hint)}
            </p>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="button" size="sm" onClick={save} disabled={saving}>
              <Save className="h-3.5 w-3.5" />
              {saving
                ? t(($) => $.modelGateway.saving)
                : t(($) => $.modelGateway.auto_title_save)}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function ProgressSummarySection({ workspace }: { workspace: Workspace }) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const resolved = readProgressSummarySettings(workspace.settings);
  const [transport, setTransport] = useState<ProgressSummaryTransport>(resolved.transport);
  const [model, setModel] = useState(resolved.model);
  const [openAiModel, setOpenAiModel] = useState(resolved.openAiModel);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = readProgressSummarySettings(workspace.settings);
    setTransport(next.transport);
    setModel(next.model);
    setOpenAiModel(next.openAiModel);
  }, [workspace.settings]);

  async function save() {
    setSaving(true);
    try {
      const progressSummary: Record<string, string> = { transport };
      const normalizedModel = model.trim();
      const normalizedOpenAiModel = openAiModel.trim();
      if (normalizedModel) progressSummary.model = normalizedModel;
      if (normalizedOpenAiModel) progressSummary.openai_model = normalizedOpenAiModel;
      const updated = await api.updateWorkspace(workspace.id, {
        settings: {
          ...(workspace.settings ?? {}),
          progress_summary: progressSummary,
        },
      });
      qc.setQueryData(workspaceKeys.list(), (old: Workspace[] | undefined) =>
        old?.map((candidate) => candidate.id === updated.id ? updated : candidate),
      );
      toast.success(t(($) => $.modelGateway.progress_saved));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.modelGateway.save_failed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.modelGateway.progress_title)}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => $.modelGateway.progress_description)}
        </p>
      </div>
      <Card>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="progress-summary-transport">
              {t(($) => $.modelGateway.progress_transport_label)}
            </Label>
            <Select
              value={transport}
              onValueChange={(value) => setTransport(value as ProgressSummaryTransport)}
            >
              <SelectTrigger id="progress-summary-transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t(($) => $.modelGateway.progress_transport_auto)}</SelectItem>
                <SelectItem value="openai">{t(($) => $.modelGateway.progress_transport_openai)}</SelectItem>
                <SelectItem value="api">{t(($) => $.modelGateway.progress_transport_api)}</SelectItem>
                <SelectItem value="cli">{t(($) => $.modelGateway.progress_transport_cli)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="progress-summary-openai-model">
                {t(($) => $.modelGateway.progress_openai_model_label)}
              </Label>
              <Input
                id="progress-summary-openai-model"
                value={openAiModel}
                onChange={(event) => setOpenAiModel(event.target.value)}
                placeholder="gpt-5.6-luna"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t(($) => $.modelGateway.progress_openai_model_hint)}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="progress-summary-claude-model">
                {t(($) => $.modelGateway.progress_claude_model_label)}
              </Label>
              <Input
                id="progress-summary-claude-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="claude-haiku-4-5-20251001"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t(($) => $.modelGateway.progress_claude_model_hint)}
              </p>
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <Button type="button" size="sm" onClick={save} disabled={saving}>
              <Save className="h-3.5 w-3.5" />
              {saving
                ? t(($) => $.modelGateway.saving)
                : t(($) => $.modelGateway.progress_save)}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function readProgressSummarySettings(
  settings: Record<string, unknown> | undefined,
): ProgressSummarySettings {
  const raw = settings?.progress_summary;
  const progress = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const transport = typeof progress.transport === "string"
    && ["auto", "api", "cli", "openai"].includes(progress.transport)
    ? progress.transport as ProgressSummaryTransport
    : "auto";
  return {
    transport,
    model: typeof progress.model === "string" ? progress.model : "",
    openAiModel: typeof progress.openai_model === "string" ? progress.openai_model : "",
  };
}

function readIssueAutoTitleSettings(
  settings: Record<string, unknown> | undefined,
): IssueAutoTitleSettings {
  const raw = settings?.issue_auto_title;
  const autoTitle = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    enabled: typeof autoTitle.enabled === "boolean" ? autoTitle.enabled : true,
    model: typeof autoTitle.model === "string" && autoTitle.model.trim()
      ? autoTitle.model
      : "gpt-5.6-luna",
  };
}

function ConfigSkeleton() {
  return (
    <div className="space-y-8" data-testid="model-gateway-skeleton" aria-busy="true">
      <Card>
        <CardContent>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-full max-w-lg" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        </CardContent>
      </Card>
      {[0, 1].map((i) => (
        <section key={i} className="space-y-3">
          <Skeleton className="h-4 w-20" />
          <Card>
            <CardContent className="space-y-3">
              <Skeleton className="h-[120px] w-full" />
              <Skeleton className="h-9 w-full" />
            </CardContent>
          </Card>
        </section>
      ))}
    </div>
  );
}

function ConfigLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useT("settings");
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center"
    >
      <AlertCircle className="h-6 w-6 text-destructive" />
      <div>
        <p className="text-sm font-medium">{t(($) => $.modelGateway.load_failed)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {error instanceof Error
            ? error.message
            : t(($) => $.modelGateway.load_failed_default)}
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t(($) => $.modelGateway.try_again)}
      </Button>
    </div>
  );
}

function EngineSection({ engine, config, wsId }: { engine: Engine; config: RelayEngineConfig; wsId: string }) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const [fragment, setFragment] = useState(config?.fragment ?? "");
  const [token, setToken] = useState("");
  const [tokenDirty, setTokenDirty] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed the editor when the server value arrives/changes and the user hasn't started editing.
  useEffect(() => {
    setFragment(config?.fragment ?? "");
  }, [config?.fragment]);

  const hasToken = config?.hasToken === true;
  const Mark = engine === "claude" ? ClaudeMark : OpenAIMark;

  async function save() {
    setSaving(true);
    try {
      const tokenOp = tokenDirty ? (token ? "set" : "clear") : "keep";
      await api.updateRelayConfig(wsId, engine, { fragment, token_op: tokenOp, auth_token: token });
      await qc.invalidateQueries({ queryKey: relayKeys.config(wsId) });
      // The save awaited gateway discovery, so the fleet catalog is fresh — refetch the
      // model dropdown so it reflects the new gateway without a manual page refresh.
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
      setTokenDirty(false);
      setToken("");
      setRevealed(false);
      toast.success(t(($) => $.modelGateway.saved));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.modelGateway.save_failed));
    } finally {
      setSaving(false);
    }
  }

  async function reveal() {
    if (revealed) {
      setRevealed(false);
      setToken("");
      setTokenDirty(false);
      return;
    }
    try {
      const value = await api.revealRelayToken(wsId, engine);
      setToken(value);
      setRevealed(true);
      setTokenDirty(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.modelGateway.save_failed));
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Mark className="h-4 w-4" />
        {engine === "claude" ? "Claude" : "Codex"}
      </h3>
      <Card>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t(($) => $.modelGateway.fragment_label)}</Label>
            <Textarea
              value={fragment}
              onChange={(e) => setFragment(e.target.value)}
              placeholder={ENGINE_PLACEHOLDER[engine]}
              spellCheck={false}
              className="mt-1 font-mono text-xs min-h-[120px] resize-y"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t(($) => $.modelGateway.token_label)}</Label>
            <div className="mt-1 flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={revealed ? "text" : "password"}
                  value={tokenDirty || revealed ? token : ""}
                  placeholder={hasToken ? "••••••••••••••••" : ""}
                  onChange={(e) => { setToken(e.target.value); setTokenDirty(true); }}
                  className="pr-8 font-mono text-xs"
                />
                {hasToken && (
                  <button
                    type="button"
                    onClick={reveal}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={revealed ? t(($) => $.modelGateway.hide) : t(($) => $.modelGateway.reveal)}
                  >
                    {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {engine === "claude" ? t(($) => $.modelGateway.claude_hint) : t(($) => $.modelGateway.codex_hint)}
            </p>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button size="sm" onClick={save} disabled={saving}>
              <Save className="h-3 w-3" />
              {saving ? t(($) => $.modelGateway.saving) : t(($) => $.modelGateway.save)}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
