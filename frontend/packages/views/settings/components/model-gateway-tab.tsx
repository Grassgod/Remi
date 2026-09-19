"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, AlertCircle, Eye, EyeOff, Plus, Radar, Save, SlidersHorizontal, Sparkles, Waypoints } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
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
import type { RelayConfigResponse, RelayEngineConfig, RelayEngineProbe, RelayReasoningLevelModel } from "@multiremi/core/api";
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

const relayKeys = {
  config: (wsId: string) => ["relay-config", wsId] as const,
  reasoningLevels: (wsId: string, engine: Engine) => ["relay-reasoning-levels", wsId, engine] as const,
};

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

          <EngineSection
            engine="claude"
            config={config.claude ?? null}
            wsId={wsId}
            discoveryEnabled={config.modelDiscovery === true}
          />
          <EngineSection
            engine="codex"
            config={config.codex ?? null}
            wsId={wsId}
            discoveryEnabled={config.modelDiscovery === true}
          />

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

function EngineSection({ engine, config, wsId, discoveryEnabled }: {
  engine: Engine;
  config: RelayEngineConfig;
  wsId: string;
  discoveryEnabled: boolean;
}) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const [fragment, setFragment] = useState(config?.fragment ?? "");
  const [token, setToken] = useState("");
  const [tokenDirty, setTokenDirty] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<RelayEngineProbe | null>(null);

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

  // Probing discovers the gateway's models and effort metadata in place of the
  // hourly stale-refresh, so the fleet model dropdown must refetch afterwards.
  async function runProbe() {
    setProbing(true);
    setProbe(null);
    try {
      const result = await api.probeRelayEngine(wsId, engine);
      setProbe(result);
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
      // A fresh snapshot can list models that were never there before, so the
      // per-model reasoning-level rows reload too. Manual declarations survive
      // the probe on the server side.
      await qc.invalidateQueries({ queryKey: relayKeys.reasoningLevels(wsId, engine) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.modelGateway.probe_failed));
    } finally {
      setProbing(false);
    }
  }

  const probeSummary = (() => {
    if (!probe) return null;
    const total = probe.models.length;
    const supported = probe.models.filter(
      (model) => (model.thinking?.supported_levels.length ?? 0) > 0,
    );
    const failed = probe.models.filter((model) => model.thinking?.status === "error").length;
    const levels = [...new Set(supported.flatMap((model) => model.thinking?.supported_levels ?? []))]
      .map((level) => level.value);
    const effort = supported.length > 0
      ? t(($) => $.modelGateway.probe_effort_supported, {
          levels: levels.join(", "),
          supported: supported.length,
          total,
        })
      : failed > 0
        ? t(($) => $.modelGateway.probe_effort_error)
        : t(($) => $.modelGateway.probe_effort_none);
    return `${t(($) => $.modelGateway.probe_models, { count: total })} · ${effort}`;
  })();

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
          {probe?.error ? (
            <p className="text-xs text-destructive" role="alert">{probe.error}</p>
          ) : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            {probeSummary ? (
              <p className="mr-auto text-xs text-muted-foreground" role="status">{probeSummary}</p>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={runProbe}
              disabled={probing || !discoveryEnabled}
              title={discoveryEnabled ? undefined : t(($) => $.modelGateway.probe_disabled)}
            >
              <Radar className="h-3 w-3" />
              {probing ? t(($) => $.modelGateway.probing) : t(($) => $.modelGateway.probe)}
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              <Save className="h-3 w-3" />
              {saving ? t(($) => $.modelGateway.saving) : t(($) => $.modelGateway.save)}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ReasoningLevelsSection engine={engine} wsId={wsId} />
    </section>
  );
}

// The Select cannot carry an empty string value; the "no default" option
// uses this sentinel and maps back to "".
const REASONING_DEFAULT_NONE = "__none__";

// ---------------------------------------------------------------------------
// Per-model reasoning levels. Sources rank gateway > runtime > manual > family:
// a manual declaration only fills a gap, and when a higher-ranked source wins
// the row says so instead of hiding the conflict. Levels are never invented —
// a model with no declaration reads as "not declared".
// ---------------------------------------------------------------------------

function ReasoningLevelsSection({ engine, wsId }: { engine: Engine; wsId: string }) {
  const { t } = useT("settings");
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: relayKeys.reasoningLevels(wsId, engine),
    queryFn: () => api.getRelayReasoningLevels(wsId, engine),
  });

  const [adding, setAdding] = useState(false);

  const models = data?.models ?? [];
  const allowedLevels = data?.allowed_levels ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
            {t(($) => $.modelGateway.reasoning_title)}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.modelGateway.reasoning_description)}
          </p>
        </div>
        {/* A declaration is a statement about the engine, not probe output, so
            it stays configurable when the snapshot is empty, stale or gone. */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={adding}
          onClick={() => setAdding((value) => !value)}
        >
          <Plus className="h-3 w-3" />
          {adding
            ? t(($) => $.modelGateway.reasoning_add_close)
            : t(($) => $.modelGateway.reasoning_add_model)}
        </Button>
      </div>
      <Card>
        <CardContent className="space-y-3">
          {isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : isError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-destructive">
                {t(($) => $.modelGateway.reasoning_load_failed)}
                {error instanceof Error ? `: ${error.message}` : ""}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
                {t(($) => $.modelGateway.try_again)}
              </Button>
            </div>
          ) : (
            <>
              {adding ? (
                <AddReasoningLevelForm
                  engine={engine}
                  wsId={wsId}
                  allowedLevels={allowedLevels}
                  onDone={() => setAdding(false)}
                />
              ) : null}
              {models.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.modelGateway.reasoning_empty)}
                </p>
              ) : (
                <ul className="divide-y">
                  {models.map((model) => (
                    <ReasoningLevelRow
                      key={`${model.model_id}:${model.manual?.updated_at ?? "none"}`}
                      engine={engine}
                      wsId={wsId}
                      model={model}
                      allowedLevels={allowedLevels}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// A declaration does not depend on the probe snapshot, so this form takes a
// model id nobody discovered. Same PUT as a row editor: the server stores the
// declaration first and reports back whether it can take effect.
function AddReasoningLevelForm({ engine, wsId, allowedLevels, onDone }: {
  engine: Engine;
  wsId: string;
  allowedLevels: string[];
  onDone: () => void;
}) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const [modelId, setModelId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [defaultLevel, setDefaultLevel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const model = modelId.trim();

  function toggleLevel(level: string, checked: boolean) {
    const next = checked
      ? [...selected, level]
      : selected.filter((value) => value !== level);
    setSelected(next);
    if (defaultLevel && !next.includes(defaultLevel)) setDefaultLevel("");
  }

  async function submit() {
    if (!model || selected.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.putRelayReasoningLevel(wsId, engine, {
        model,
        levels: selected,
        ...(defaultLevel ? { default_level: defaultLevel } : {}),
      });
      await qc.invalidateQueries({ queryKey: relayKeys.reasoningLevels(wsId, engine) });
      // The declaration feeds the agent model/effort selection, so the fleet
      // catalog must refetch as well.
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
      toast.success(t(($) => $.modelGateway.reasoning_saved));
      onDone();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t(($) => $.modelGateway.reasoning_save_failed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div className="space-y-1.5">
        <Label htmlFor={`reasoning-model-${engine}`} className="text-xs font-medium">
          {t(($) => $.modelGateway.reasoning_add_model_label)}
        </Label>
        <Input
          id={`reasoning-model-${engine}`}
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder={t(($) => $.modelGateway.reasoning_add_model_placeholder)}
          className="font-mono text-xs sm:max-w-xs"
          spellCheck={false}
          disabled={saving}
        />
      </div>
      <ReasoningLevelFields
        idPrefix={`add-${engine}`}
        allowedLevels={allowedLevels}
        selected={selected}
        defaultLevel={defaultLevel}
        disabled={saving}
        onToggle={toggleLevel}
        onDefaultChange={setDefaultLevel}
      />
      {saveError ? (
        <p role="alert" className="text-xs text-destructive">{saveError}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void submit()}
          disabled={saving || !model || selected.length === 0}
        >
          {saving
            ? t(($) => $.modelGateway.reasoning_saving)
            : t(($) => $.modelGateway.reasoning_save)}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={saving}>
          {t(($) => $.modelGateway.reasoning_add_close)}
        </Button>
      </div>
    </div>
  );
}

function ReasoningLevelFields({ idPrefix, allowedLevels, selected, defaultLevel, disabled, onToggle, onDefaultChange }: {
  idPrefix: string;
  allowedLevels: string[];
  selected: string[];
  defaultLevel: string;
  disabled: boolean;
  onToggle: (level: string, checked: boolean) => void;
  onDefaultChange: (level: string) => void;
}) {
  const { t } = useT("settings");
  const defaultId = `reasoning-default-${idPrefix}`;

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs font-medium">
          {t(($) => $.modelGateway.reasoning_levels_label)}
        </Label>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {allowedLevels.map((level) => (
            <label key={level} className="flex cursor-pointer items-center gap-2 font-mono text-xs">
              <Checkbox
                checked={selected.includes(level)}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle(level, checked === true)}
              />
              {level}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={defaultId} className="text-xs font-medium">
          {t(($) => $.modelGateway.reasoning_default_label)}
        </Label>
        <Select
          value={defaultLevel || REASONING_DEFAULT_NONE}
          onValueChange={(value) => onDefaultChange(!value || value === REASONING_DEFAULT_NONE ? "" : value)}
          disabled={disabled}
        >
          <SelectTrigger id={defaultId} className="w-full sm:max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={REASONING_DEFAULT_NONE}>
              {t(($) => $.modelGateway.reasoning_default_none)}
            </SelectItem>
            {selected.map((level) => (
              <SelectItem key={level} value={level}>{level}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

function ReasoningLevelRow({ engine, wsId, model, allowedLevels }: {
  engine: Engine;
  wsId: string;
  model: RelayReasoningLevelModel;
  allowedLevels: string[];
}) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(model.manual?.levels ?? []);
  const [defaultLevel, setDefaultLevel] = useState<string>(model.manual?.default_level ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const effective = model.effective;
  // The server's `state` keeps a stored-but-inert declaration from rendering as
  // if it were in force: `outranked` keeps the existing conflict hint, and
  // `blocked` states the exact reason the declaration cannot apply.
  const outranked = model.manual?.state === "outranked";
  const blocked = model.manual?.state === "blocked";
  function blockedReason(): string {
    const code = model.manual?.state_code;
    if (code === "not_in_execution_catalog") {
      return t(($) => $.modelGateway.reasoning_blocked_not_in_execution_catalog);
    }
    if (code === "execution_catalog_unknown") {
      return t(($) => $.modelGateway.reasoning_blocked_execution_catalog_unknown);
    }
    if (code === "not_in_catalog") {
      return t(($) => $.modelGateway.reasoning_blocked_not_in_catalog);
    }
    return t(($) => $.modelGateway.reasoning_blocked_unknown_reason);
  }
  const effectiveSource = effective?.source === "gateway"
    ? t(($) => $.modelGateway.reasoning_source_gateway)
    : effective?.source === "runtime"
      ? t(($) => $.modelGateway.reasoning_source_runtime)
      : effective?.source === "manual"
        ? t(($) => $.modelGateway.reasoning_source_manual)
        : effective?.source === "family"
          ? t(($) => $.modelGateway.reasoning_source_family)
          : t(($) => $.modelGateway.reasoning_source_none);
  const effectiveStatus = effective?.status === "supported"
    ? t(($) => $.modelGateway.reasoning_status_supported)
    : effective?.status === "unsupported"
      ? t(($) => $.modelGateway.reasoning_status_unsupported)
      : effective?.status === "error"
        ? t(($) => $.modelGateway.reasoning_status_error)
        : t(($) => $.modelGateway.reasoning_status_unknown);

  function toggleLevel(level: string, checked: boolean) {
    const next = checked
      ? [...selected, level]
      : selected.filter((value) => value !== level);
    setSelected(next);
    if (defaultLevel && !next.includes(defaultLevel)) setDefaultLevel("");
  }

  // `levels: []` clears the declaration (the server answers with the refreshed
  // listing plus `deleted: true`), so the same path serves both buttons.
  async function persist(levels: string[]) {
    setSaving(true);
    setSaveError(null);
    try {
      await api.putRelayReasoningLevel(wsId, engine, {
        model: model.model_id,
        levels,
        ...(levels.length > 0 && defaultLevel ? { default_level: defaultLevel } : {}),
      });
      await qc.invalidateQueries({ queryKey: relayKeys.reasoningLevels(wsId, engine) });
      // Declared levels feed the agent model/effort selection, so the fleet
      // catalog must refetch as well.
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
      toast.success(levels.length > 0
        ? t(($) => $.modelGateway.reasoning_saved)
        : t(($) => $.modelGateway.reasoning_cleared));
      setOpen(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t(($) => $.modelGateway.reasoning_save_failed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-xs font-medium">{model.label || model.model_id}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{model.model_id}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {effective ? (
              <>
                <Badge variant={effective.source === "manual" ? "secondary" : "outline"}>
                  {effectiveSource}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  {effectiveStatus} · {effective.supported_levels.length > 0
                    ? t(($) => $.modelGateway.reasoning_effect, {
                        levels: effective.supported_levels.map((level) => level.value).join(", "),
                      })
                    : t(($) => $.modelGateway.reasoning_effect_none)}
                </span>
              </>
            ) : model.manual ? null : (
              <span className="text-[11px] text-muted-foreground">
                {t(($) => $.modelGateway.reasoning_not_declared)}
              </span>
            )}
            {model.manual && model.manual.levels.length > 0 ? (
              <Badge variant="secondary">
                {t(($) => $.modelGateway.reasoning_manual_badge, {
                  levels: model.manual.levels.join(", "),
                })}
              </Badge>
            ) : null}
            {blocked ? (
              <Badge variant="destructive">
                {t(($) => $.modelGateway.reasoning_state_blocked)}
              </Badge>
            ) : null}
          </div>
          {outranked ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-400" role="status">
              {t(($) => $.modelGateway.reasoning_conflict, { source: effectiveSource })}
            </p>
          ) : null}
          {blocked ? (
            <p className="text-[11px] text-destructive" role="status">
              {blockedReason()}
            </p>
          ) : null}
          {model.manual && (model.manual.updated_by || model.manual.updated_at) ? (
            <p className="text-[11px] text-muted-foreground">
              {t(($) => $.modelGateway.reasoning_manual_meta, {
                user: model.manual.updated_by ?? "—",
                time: model.manual.updated_at ?? "—",
              })}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <SlidersHorizontal className="h-3 w-3" />
          {open
            ? t(($) => $.modelGateway.reasoning_close)
            : t(($) => $.modelGateway.reasoning_edit)}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-3 rounded-md border bg-muted/30 p-3">
          <ReasoningLevelFields
            idPrefix={`${engine}-${model.model_id}`}
            allowedLevels={allowedLevels}
            selected={selected}
            defaultLevel={defaultLevel}
            disabled={saving}
            onToggle={toggleLevel}
            onDefaultChange={setDefaultLevel}
          />
          {saveError ? (
            <p role="alert" className="text-xs text-destructive">{saveError}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void persist(selected)}
              disabled={saving || selected.length === 0}
            >
              {saving
                ? t(($) => $.modelGateway.reasoning_saving)
                : t(($) => $.modelGateway.reasoning_save)}
            </Button>
            {model.manual ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void persist([])}
                disabled={saving}
              >
                {t(($) => $.modelGateway.reasoning_clear)}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
