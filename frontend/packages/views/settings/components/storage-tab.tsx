"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, HardDrive, Save } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import {
  STORAGE_SETTINGS_BOUNDS,
  STORAGE_SETTINGS_DEFAULTS,
  useUpdateWorkspaceStorage,
  workspaceStorageDaemonsOptions,
  workspaceStorageOptions,
  type StorageSettings,
  type StorageSettingsPatch,
  type WorkspaceStorageResponse,
} from "@multiremi/core/storage";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { DaemonStorageCard } from "../../runtimes/components/daemon-storage-card";
import { useT } from "../../i18n";

const HOUR_MS = 60 * 60 * 1000;
const MIB = 1024 * 1024;

type FieldKey = keyof StorageSettings;
type FieldUnit = "hours" | "mb" | "days" | "count";

// The wire keeps milliseconds and bytes; people edit hours and megabytes.
const FIELDS: ReadonlyArray<{ key: FieldKey; unit: FieldUnit; factor: number; integer: boolean }> = [
  { key: "ttl_ms", unit: "hours", factor: HOUR_MS, integer: false },
  { key: "automation_ttl_ms", unit: "hours", factor: HOUR_MS, integer: false },
  { key: "max_retained", unit: "count", factor: 1, integer: true },
  { key: "orphan_ttl_ms", unit: "hours", factor: HOUR_MS, integer: false },
  { key: "snapshot_max_bytes", unit: "mb", factor: MIB, integer: false },
  { key: "chat_idle_days", unit: "days", factor: 1, integer: true },
];

type FieldError = "required" | "integer" | "range" | null;

function fieldValue(raw: string, field: (typeof FIELDS)[number]): { value: number | null; error: FieldError } {
  if (raw.trim() === "") return { value: null, error: "required" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { value: null, error: "required" };
  if (field.integer && !Number.isInteger(parsed)) return { value: null, error: "integer" };
  const value = Math.round(parsed * field.factor);
  const { min, max } = STORAGE_SETTINGS_BOUNDS[field.key];
  return { value, error: value < min || value > max ? "range" : null };
}

function toDisplay(value: number, field: (typeof FIELDS)[number]): string {
  return String(Number((value / field.factor).toFixed(2)));
}

function displayValues(settings: StorageSettings): Record<FieldKey, string> {
  return Object.fromEntries(
    FIELDS.map((field) => [field.key, toDisplay(settings[field.key], field)]),
  ) as Record<FieldKey, string>;
}

export function StorageTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const user = useAuthStore((state) => state.user);
  const members = useQuery(memberListOptions(wsId));

  if (members.isPending) return <StorageSkeleton />;
  if (members.isError) {
    return <LoadError onRetry={() => void members.refetch()} />;
  }
  const currentMember = members.data.find((member) => member.user_id === user?.id) ?? null;
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.page.tabs.storage)}
        </h2>
        <p className="text-sm text-muted-foreground">{t(($) => $.storage.description)}</p>
      </section>
      <MachinesSection wsId={wsId} canManage={canManage} />
      <PolicySection wsId={wsId} canManage={canManage} />
    </div>
  );
}

function MachinesSection({ wsId, canManage }: { wsId: string; canManage: boolean }) {
  const { t } = useT("settings");
  const daemons = useQuery(workspaceStorageDaemonsOptions(wsId));

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t(($) => $.storage.machines_title)}</h3>
      {daemons.isPending ? (
        <Skeleton className="h-56 w-full" aria-busy="true" />
      ) : daemons.isError ? (
        <LoadError onRetry={() => void daemons.refetch()} />
      ) : daemons.data.daemons.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t(($) => $.storage.no_machines)}</p>
      ) : (
        <div className="space-y-4">
          {daemons.data.daemons.map((daemon) => (
            <DaemonStorageCard key={daemon.daemon_id} daemon={daemon} canManage={canManage} />
          ))}
        </div>
      )}
    </section>
  );
}

function PolicySection({ wsId, canManage }: { wsId: string; canManage: boolean }) {
  const { t } = useT("settings");
  const policy = useQuery(workspaceStorageOptions(wsId));

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t(($) => $.storage.policy_title)}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t(($) => $.storage.policy_description)}</p>
      </div>
      {policy.isPending ? (
        <Skeleton className="h-72 w-full" aria-busy="true" />
      ) : policy.isError ? (
        <LoadError onRetry={() => void policy.refetch()} />
      ) : (
        <PolicyForm
          // Remount on every saved revision so the inputs restart from the server's values.
          key={JSON.stringify(policy.data)}
          wsId={wsId}
          policy={policy.data}
          canManage={canManage}
        />
      )}
    </section>
  );
}

function PolicyForm({
  wsId,
  policy,
  canManage,
}: {
  wsId: string;
  policy: WorkspaceStorageResponse;
  canManage: boolean;
}) {
  const { t } = useT("settings");
  const update = useUpdateWorkspaceStorage(wsId);
  const [initial, setInitial] = useState(() => displayValues(policy.settings));
  const [draft, setDraft] = useState(initial);
  // Fields whose override is being dropped; they are sent as null on Save.
  const [resets, setResets] = useState<ReadonlySet<FieldKey>>(new Set());

  const parsed = FIELDS.map((field) => ({ field, ...fieldValue(draft[field.key], field) }));
  // Only fields the person edited are sent; the display rounds, so comparing
  // converted values would mark an untouched field as changed.
  const patch: StorageSettingsPatch = {};
  for (const { field, value } of parsed) {
    if (resets.has(field.key)) patch[field.key] = null;
    else if (value !== null && draft[field.key] !== initial[field.key]) patch[field.key] = value;
  }
  const invalid = parsed.some(({ error }) => error !== null);
  const changed = Object.keys(patch).length > 0;

  function edit(key: FieldKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setResets((current) => new Set([...current].filter((reset) => reset !== key)));
  }

  function resetToDefault(field: (typeof FIELDS)[number]) {
    setDraft((current) => ({ ...current, [field.key]: toDisplay(STORAGE_SETTINGS_DEFAULTS[field.key], field) }));
    setResets((current) => new Set(current).add(field.key));
  }

  function save() {
    update.mutate(patch, {
      onSuccess: (saved) => {
        const next = displayValues(saved.settings);
        setInitial(next);
        setDraft(next);
        setResets(new Set());
        toast.success(t(($) => $.storage.saved));
      },
      onError: (error) =>
        toast.error(error instanceof Error ? error.message : t(($) => $.storage.save_failed)),
    });
  }

  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {parsed.map(({ field, error }) => {
            const { key } = field;
            const { min, max } = STORAGE_SETTINGS_BOUNDS[key];
            const overridden = policy.overrides[key] !== undefined;
            return (
              <div key={key} className="space-y-2">
                <Label htmlFor={`storage-${key}`}>{t(($) => $.storage.fields[key].label)}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`storage-${key}`}
                    type="number"
                    step="any"
                    inputMode="decimal"
                    value={draft[key]}
                    disabled={!canManage}
                    aria-invalid={error !== null}
                    onChange={(event) => edit(key, event.target.value)}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {t(($) => $.storage.units[field.unit])}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.storage.fields[key].hint)}{" "}
                  {t(($) => $.storage.default_value, {
                    value: toDisplay(STORAGE_SETTINGS_DEFAULTS[key], field),
                    unit: t(($) => $.storage.units[field.unit]),
                  })}
                </p>
                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {t(($) => $.storage.validation[error], {
                      min: toDisplay(min, field),
                      max: toDisplay(max, field),
                      unit: t(($) => $.storage.units[field.unit]),
                    })}
                  </p>
                )}
                {canManage && overridden && !resets.has(key) && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => resetToDefault(field)}
                  >
                    {t(($) => $.storage.reset_default)}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {canManage ? (
          <div className="flex justify-end">
            <Button onClick={save} disabled={update.isPending || invalid || !changed}>
              <Save className="h-4 w-4" />
              {update.isPending ? t(($) => $.storage.saving) : t(($) => $.storage.save)}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t(($) => $.storage.read_only)}</p>
        )}
      </CardContent>
    </Card>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("settings");
  return (
    <div role="alert" className="space-y-3 py-8 text-center">
      <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
      <p className="text-sm font-medium">{t(($) => $.storage.load_failed)}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t(($) => $.storage.retry_load)}
      </Button>
    </div>
  );
}

function StorageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" data-testid="storage-skeleton">
      <Skeleton className="h-5 w-44" />
      <Skeleton className="h-56 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
