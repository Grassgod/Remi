"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Play, QrCode, RefreshCw, Square, Trash2 } from "lucide-react";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import {
  feishuBotCandidatesOptions,
  feishuBotOptions,
  feishuBotStatusOptions,
} from "@multiremi/core/feishu-bot/queries";
import {
  useDeleteFeishuBot,
  useDeployFeishuBot,
  useSaveFeishuBot,
  useStopFeishuBot,
  useTestFeishuBot,
} from "@multiremi/core/feishu-bot/mutations";
import { feishuBotStatusTone } from "@multiremi/core/feishu-bot/status";
import type {
  FeishuBotCandidates,
  FeishuBotConfig,
  FeishuBotDomain,
  FeishuBotSecretOp,
  FeishuBotStatusSnapshot,
  UpsertFeishuBotRequest,
} from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
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
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";
import { FeishuBotRegistrationDialog, type ClaimedRegistration } from "./feishu-bot-registration-dialog";

/**
 * Workspace Feishu concierge (MUL-206).
 *
 * Replaces four environment variables on the daemon machine —
 * `MULTIREMI_WORKSPACE_ID`, `MULTIREMI_BOT_AGENT_ID`, `FEISHU_APP_ID`,
 * `FEISHU_APP_SECRET` — with a form an admin can reach from a browser.
 *
 * Two things this component is careful about:
 *
 * - **Secrets are write-only.** Nothing here ever renders a stored secret,
 *   because the server never sends one. A configured credential shows as a
 *   four-character hint; an empty input means "keep what is stored", so
 *   changing the Agent cannot silently wipe the app secret.
 * - **Status is read, never inferred.** `deploying → online` happens on the
 *   daemon's next heartbeat, so the badge polls rather than guessing from the
 *   last action the admin took.
 */
export function FeishuBotSection() {
  const { t } = useT("settings");
  const workspaceId = useWorkspaceId();
  const user = useAuthStore((state) => state.user);

  const membersQuery = useQuery(memberListOptions(workspaceId));
  const members = membersQuery.data ?? [];
  const role = members.find((member) => member.user_id === user?.id)?.role;
  const canManage = role === "owner" || role === "admin";

  const botQuery = useQuery(feishuBotOptions(workspaceId));
  // The admin-only queries stay disabled for members so the page does not fire
  // three requests it already knows will come back 403.
  const statusQuery = useQuery(feishuBotStatusOptions(workspaceId, canManage));
  const candidatesQuery = useQuery(feishuBotCandidatesOptions(workspaceId, canManage));

  if (membersQuery.isPending || botQuery.isPending) {
    return <div className="h-32 animate-pulse rounded border bg-muted/30" />;
  }

  if (!canManage || botQuery.data?.role === "member") {
    const availability = botQuery.data?.role === "member"
      ? botQuery.data.availability
      : { configured: false, available: false, bot_name: null };
    return (
      <section className="space-y-3">
        <SectionHeader />
        <Card>
          <CardContent className="space-y-1">
            <p className="text-sm font-medium">
              {availability.available
                ? t(($) => $.feishu.concierge.member_available, {
                  name: availability.bot_name ?? t(($) => $.feishu.concierge.member_unnamed_bot),
                })
                : availability.configured
                  ? t(($) => $.feishu.concierge.member_unavailable)
                  : t(($) => $.feishu.concierge.member_not_configured)}
            </p>
            <p className="text-xs text-muted-foreground">{t(($) => $.feishu.concierge.member_hint)}</p>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <FeishuBotAdminPanel
      workspaceId={workspaceId}
      config={botQuery.data?.config ?? null}
      status={statusQuery.data ?? null}
      candidates={candidatesQuery.data ?? null}
      candidatesPending={candidatesQuery.isPending}
    />
  );
}

function SectionHeader() {
  const { t } = useT("settings");
  return (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">{t(($) => $.feishu.concierge.title)}</h2>
      <p className="max-w-2xl text-sm text-muted-foreground">
        {t(($) => $.feishu.concierge.description)}
      </p>
    </div>
  );
}

interface Draft {
  agentId: string;
  runtimeId: string;
  appId: string;
  domain: FeishuBotDomain;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  /** Set when the admin explicitly clears an optional secret. */
  clearVerificationToken: boolean;
  clearEncryptKey: boolean;
  /** Present after a successful scan; consumed by the next save. */
  registration: ClaimedRegistration | null;
}

const EMPTY_DRAFT: Draft = {
  agentId: "",
  runtimeId: "",
  appId: "",
  domain: "feishu",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
  clearVerificationToken: false,
  clearEncryptKey: false,
  registration: null,
};

function draftFromConfig(config: FeishuBotConfig | null): Draft {
  if (!config?.configured) return EMPTY_DRAFT;
  return {
    ...EMPTY_DRAFT,
    agentId: config.agent_id ?? "",
    runtimeId: config.runtime_id ?? "",
    appId: config.app_id,
    domain: config.domain,
  };
}

function FeishuBotAdminPanel({
  workspaceId,
  config,
  status,
  candidates,
  candidatesPending,
}: {
  workspaceId: string;
  config: FeishuBotConfig | null;
  status: FeishuBotStatusSnapshot | null;
  candidates: FeishuBotCandidates | null;
  candidatesPending: boolean;
}) {
  const { t } = useT("settings");
  const [draft, setDraft] = useState<Draft>(() => draftFromConfig(config));
  const [dirty, setDirty] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useSaveFeishuBot(workspaceId);
  const remove = useDeleteFeishuBot(workspaceId);
  const deploy = useDeployFeishuBot(workspaceId);
  const stop = useStopFeishuBot(workspaceId);
  const test = useTestFeishuBot(workspaceId);

  // A refetch must not stomp on half-typed input, so the server's copy only
  // seeds the form while the admin has not touched it.
  useEffect(() => {
    if (dirty) return;
    setDraft(draftFromConfig(config));
  }, [config, dirty]);

  function edit(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  const configured = config?.configured === true;
  const busy = save.isPending || remove.isPending || deploy.isPending || stop.isPending;
  const encryptionAvailable = candidates?.encryption_available !== false;
  const secretSatisfied = Boolean(
    draft.appSecret.trim() || draft.registration?.appSecretAvailable || config?.app_secret_configured,
  );
  const canSave = Boolean(draft.agentId && draft.runtimeId && draft.appId.trim())
    && secretSatisfied
    && encryptionAvailable
    && !busy;

  function buildRequest(): UpsertFeishuBotRequest {
    const request: UpsertFeishuBotRequest = {
      agent_id: draft.agentId,
      runtime_id: draft.runtimeId,
      app_id: draft.appId.trim(),
      domain: draft.domain,
      // Saving never flips the bot on or off — Deploy and Stop own that, so an
      // edit to a running bot keeps running and an edit to a stopped one does
      // not quietly go live.
      enabled: config?.enabled ?? false,
      app_secret_op: secretOp(draft.appSecret, false),
      verification_token_op: secretOp(draft.verificationToken, draft.clearVerificationToken),
      encrypt_key_op: secretOp(draft.encryptKey, draft.clearEncryptKey),
    };
    if (draft.appSecret.trim()) request.app_secret = draft.appSecret.trim();
    if (draft.verificationToken.trim()) request.verification_token = draft.verificationToken.trim();
    if (draft.encryptKey.trim()) request.encrypt_key = draft.encryptKey.trim();
    // A scanned credential never passes through the browser: the server holds
    // the secret against the session id and we only tell it to use that.
    if (draft.registration && !draft.appSecret.trim()) {
      request.app_secret_op = "registration";
      request.registration_session_id = draft.registration.sessionId;
    }
    return request;
  }

  async function handleSave() {
    if (!canSave) return;
    try {
      await save.mutateAsync(buildRequest());
      // Drop every typed secret the moment it is stored: the form must not go
      // on holding plaintext an admin can no longer see anyway.
      setDraft((current) => ({
        ...current,
        appSecret: "",
        verificationToken: "",
        encryptKey: "",
        clearVerificationToken: false,
        clearEncryptKey: false,
        registration: null,
      }));
      setDirty(false);
      toast.success(t(($) => $.feishu.concierge.toast_saved));
    } catch (error) {
      toast.error(errorText(error, t(($) => $.feishu.concierge.toast_save_failed)));
    }
  }

  async function handleTest() {
    try {
      const result = await test.mutateAsync({
        app_id: draft.appId.trim() || undefined,
        app_secret: draft.appSecret.trim() || undefined,
        domain: draft.domain,
        registration_session_id: draft.registration?.sessionId,
      });
      if (result.ok) {
        toast.success(t(($) => $.feishu.concierge.toast_test_ok, {
          name: result.bot_name ?? result.app_name ?? t(($) => $.feishu.concierge.member_unnamed_bot),
        }));
      } else {
        toast.error(result.error_message
          ?? t(($) => $.feishu.concierge.error_codes[errorKey(result.error_code)]));
      }
    } catch (error) {
      toast.error(errorText(error, t(($) => $.feishu.concierge.toast_test_failed)));
    }
  }

  async function run(action: () => Promise<unknown>, failure: string) {
    try {
      await action();
    } catch (error) {
      toast.error(errorText(error, failure));
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeader />
        <StatusBadge status={status?.status ?? (configured ? "stopped" : "not_configured")} />
      </header>

      {!encryptionAvailable && (
        <Notice tone="danger" text={t(($) => $.feishu.concierge.encryption_unavailable)} />
      )}

      <StatusPanel status={status} config={config} />

      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t(($) => $.feishu.concierge.agent_label)}</Label>
              <Select
                disabled={candidatesPending || busy}
                value={draft.agentId}
                onValueChange={(value) => value && edit({ agentId: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t(($) => $.feishu.concierge.agent_placeholder)} />
                </SelectTrigger>
                <SelectContent>
                  {(candidates?.agents ?? []).map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t(($) => $.feishu.concierge.agent_hint)}</p>
              {config?.agent_archived && (
                <p className="text-xs text-destructive">{t(($) => $.feishu.concierge.agent_archived)}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>{t(($) => $.feishu.concierge.runtime_label)}</Label>
              <Select
                disabled={candidatesPending || busy}
                value={draft.runtimeId}
                onValueChange={(value) => value && edit({ runtimeId: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t(($) => $.feishu.concierge.runtime_placeholder)} />
                </SelectTrigger>
                <SelectContent>
                  {(candidates?.runtimes ?? []).map((runtime) => (
                    // A Runtime that has not advertised the capability is shown
                    // but not selectable: hiding it would leave an admin
                    // wondering why their daemon is missing from the list.
                    <SelectItem key={runtime.id} value={runtime.id} disabled={!runtime.supports_config}>
                      {runtime.name}
                      {!runtime.supports_config
                        ? ` — ${t(($) => $.feishu.concierge.runtime_unsupported)}`
                        : !runtime.online
                          ? ` — ${t(($) => $.feishu.concierge.runtime_offline)}`
                          : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t(($) => $.feishu.concierge.runtime_hint)}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="feishu-bot-app-id">{t(($) => $.feishu.concierge.app_id_label)}</Label>
              <Input
                id="feishu-bot-app-id"
                value={draft.appId}
                disabled={busy}
                autoComplete="off"
                placeholder="cli_xxxxxxxxxxxxxxxx"
                onChange={(event) => edit({ appId: event.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t(($) => $.feishu.concierge.domain_label)}</Label>
              <Select
                disabled={busy}
                value={draft.domain}
                onValueChange={(value) => value && edit({ domain: value as FeishuBotDomain })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="feishu">{t(($) => $.feishu.concierge.domain_feishu)}</SelectItem>
                  <SelectItem value="lark">{t(($) => $.feishu.concierge.domain_lark)}</SelectItem>
                  <SelectItem value="bytedance">{t(($) => $.feishu.concierge.domain_bytedance)}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <SecretField
            id="feishu-bot-app-secret"
            label={t(($) => $.feishu.concierge.app_secret_label)}
            hint={config?.app_secret_hint ?? null}
            configured={config?.app_secret_configured === true}
            value={draft.appSecret}
            disabled={busy}
            required
            onChange={(value) => edit({ appSecret: value, registration: value ? null : draft.registration })}
          />
          {draft.registration && !draft.appSecret && (
            <Notice
              tone="progress"
              text={t(($) => $.feishu.concierge.registration_pending_save, { appId: draft.registration.appId })}
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <SecretField
              id="feishu-bot-verification-token"
              label={t(($) => $.feishu.concierge.verification_token_label)}
              hint={null}
              configured={config?.verification_token_configured === true}
              value={draft.verificationToken}
              disabled={busy || draft.clearVerificationToken}
              cleared={draft.clearVerificationToken}
              onClearToggle={() => edit({
                clearVerificationToken: !draft.clearVerificationToken,
                verificationToken: "",
              })}
              onChange={(value) => edit({ verificationToken: value })}
            />
            <SecretField
              id="feishu-bot-encrypt-key"
              label={t(($) => $.feishu.concierge.encrypt_key_label)}
              hint={null}
              configured={config?.encrypt_key_configured === true}
              value={draft.encryptKey}
              disabled={busy || draft.clearEncryptKey}
              cleared={draft.clearEncryptKey}
              onClearToggle={() => edit({ clearEncryptKey: !draft.clearEncryptKey, encryptKey: "" })}
              onChange={(value) => edit({ encryptKey: value })}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button size="sm" disabled={!canSave} onClick={() => void handleSave()}>
              {save.isPending ? t(($) => $.feishu.concierge.saving) : t(($) => $.feishu.concierge.save)}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={test.isPending || busy || !draft.appId.trim()}
              onClick={() => void handleTest()}
            >
              <RefreshCw className={cn("size-4", test.isPending && "animate-spin")} />
              {test.isPending ? t(($) => $.feishu.concierge.testing) : t(($) => $.feishu.concierge.test)}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setScanning(true)}>
              <QrCode className="size-4" />
              {t(($) => $.feishu.concierge.scan_to_create)}
            </Button>
            <div className="grow" />
            <Button
              variant="outline"
              size="sm"
              disabled={!configured || busy || dirty}
              title={dirty ? t(($) => $.feishu.concierge.save_first) : undefined}
              onClick={() => void run(
                () => deploy.mutateAsync(),
                t(($) => $.feishu.concierge.toast_deploy_failed),
              )}
            >
              <Play className="size-4" />
              {config?.enabled
                ? t(($) => $.feishu.concierge.redeploy)
                : t(($) => $.feishu.concierge.deploy)}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!configured || !config?.enabled || busy}
              onClick={() => void run(
                () => stop.mutateAsync(),
                t(($) => $.feishu.concierge.toast_stop_failed),
              )}
            >
              <Square className="size-4" />
              {t(($) => $.feishu.concierge.stop)}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={!configured || busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" />
              {t(($) => $.feishu.concierge.delete)}
            </Button>
          </div>
        </CardContent>
      </Card>

      <FeishuBotRegistrationDialog
        workspaceId={workspaceId}
        open={scanning}
        onOpenChange={setScanning}
        onClaimed={(claimed) => {
          edit({ registration: claimed, appId: claimed.appId, appSecret: "" });
          setScanning(false);
        }}
      />

      <AlertDialog open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.feishu.concierge.delete_confirm_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.feishu.concierge.delete_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              {t(($) => $.feishu.concierge.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                void run(
                  () => remove.mutateAsync(),
                  t(($) => $.feishu.concierge.toast_delete_failed),
                );
              }}
            >
              {t(($) => $.feishu.concierge.delete)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function StatusPanel({
  status,
  config,
}: {
  status: FeishuBotStatusSnapshot | null;
  config: FeishuBotConfig | null;
}) {
  const { t } = useT("settings");
  const timeAgo = useTimeAgo();
  if (!status) return null;

  const rows: Array<{ label: string; value: string }> = [
    {
      label: t(($) => $.feishu.concierge.status_runtime),
      value: status.runtime_name
        ?? config?.runtime_name
        ?? t(($) => $.feishu.concierge.status_none),
    },
    {
      label: t(($) => $.feishu.concierge.status_bot),
      value: status.bot_name ?? t(($) => $.feishu.concierge.status_none),
    },
    {
      label: t(($) => $.feishu.concierge.status_heartbeat),
      value: status.last_heartbeat_at
        ? timeAgo(status.last_heartbeat_at)
        : t(($) => $.feishu.concierge.status_none),
    },
    {
      // Applied vs desired is the one number that explains a stuck `deploying`:
      // the Runtime is still on an older revision of the config.
      label: t(($) => $.feishu.concierge.status_revision),
      value: `${status.applied_revision ?? "—"} / ${status.revision}`,
    },
  ];

  return (
    <div className="space-y-3">
      <dl className="grid gap-3 rounded border px-4 py-3 text-sm sm:grid-cols-4">
        {rows.map((row) => (
          <div key={row.label} className="space-y-0.5">
            <dt className="text-xs text-muted-foreground">{row.label}</dt>
            <dd className="truncate font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
      {status.stale_runtime_ids.length > 0 && (
        <Notice
          tone="warning"
          text={t(($) => $.feishu.concierge.stale_runtimes, {
            runtimes: status.stale_runtime_ids.join(", "),
          })}
        />
      )}
      {status.error_message && (
        <Notice
          tone="danger"
          text={`${t(($) => $.feishu.concierge.error_codes[errorKey(status.error_code)])}: ${status.error_message}`}
        />
      )}
      {!status.error_message && config?.last_test_error && (
        <Notice tone="warning" text={config.last_test_error} />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useT("settings");
  const tone = feishuBotStatusTone(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0",
        tone === "positive" && "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
        tone === "progress" && "border-sky-500/40 text-sky-600 dark:text-sky-400",
        tone === "warning" && "border-amber-500/40 text-amber-600 dark:text-amber-400",
        tone === "danger" && "border-destructive/40 text-destructive",
      )}
    >
      {t(($) => $.feishu.concierge.statuses[statusKey(status)])}
    </Badge>
  );
}

function SecretField({
  id,
  label,
  hint,
  configured,
  value,
  disabled,
  required,
  cleared,
  onChange,
  onClearToggle,
}: {
  id: string;
  label: string;
  hint: string | null;
  configured: boolean;
  value: string;
  disabled?: boolean;
  required?: boolean;
  cleared?: boolean;
  onChange: (value: string) => void;
  onClearToggle?: () => void;
}) {
  const { t } = useT("settings");
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {onClearToggle && configured && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onClearToggle}>
            {cleared ? t(($) => $.feishu.concierge.secret_keep) : t(($) => $.feishu.concierge.secret_clear)}
          </Button>
        )}
      </div>
      <Input
        id={id}
        type="password"
        value={value}
        disabled={disabled}
        autoComplete="new-password"
        placeholder={configured
          ? hint ?? t(($) => $.feishu.concierge.secret_stored)
          : required
            ? t(($) => $.feishu.concierge.secret_required)
            : t(($) => $.feishu.concierge.secret_optional)}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {cleared
          ? t(($) => $.feishu.concierge.secret_will_clear)
          : configured
            ? t(($) => $.feishu.concierge.secret_unchanged)
            : t(($) => $.feishu.concierge.secret_write_only)}
      </p>
    </div>
  );
}

function Notice({ tone, text }: { tone: "warning" | "danger" | "progress"; text: string }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded border px-3 py-2 text-xs",
        tone === "danger" && "border-destructive/40 bg-destructive/5 text-destructive",
        tone === "warning" && "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400",
        tone === "progress" && "border-sky-500/40 bg-sky-500/5 text-sky-700 dark:text-sky-400",
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

function secretOp(value: string, cleared: boolean): FeishuBotSecretOp {
  if (cleared) return "clear";
  return value.trim() ? "set" : "keep";
}

/** Unknown codes and statuses render through a generic label, never crash. */
const STATUS_KEYS = [
  "not_configured",
  "stopped",
  "deploying",
  "connecting",
  "online",
  "degraded",
  "failed",
  "runtime_offline",
] as const;

function statusKey(status: string): (typeof STATUS_KEYS)[number] {
  return STATUS_KEYS.includes(status as (typeof STATUS_KEYS)[number])
    ? (status as (typeof STATUS_KEYS)[number])
    : "not_configured";
}

const ERROR_KEYS = [
  "invalid_credentials",
  "insufficient_permissions",
  "agent_unavailable",
  "runtime_unavailable",
  "connector_start_failed",
  "network_unreachable",
  "unknown",
] as const;

function errorKey(code: string | null): (typeof ERROR_KEYS)[number] {
  return code && ERROR_KEYS.includes(code as (typeof ERROR_KEYS)[number])
    ? (code as (typeof ERROR_KEYS)[number])
    : "unknown";
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
