"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import type { OrganizerMode, WorkspaceOrganizerSettings } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@multiremi/ui/components/ui/radio-group";
import { toast } from "sonner";
import { useT } from "../../i18n";

export const workspaceOrganizerSettingsKey = (workspaceId: string) =>
  ["workspace-organizer-settings", workspaceId] as const;

interface OrganizerSettingsSectionProps {
  workspaceId: string;
  canManage: boolean;
}

export function OrganizerSettingsSection({
  workspaceId,
  canManage,
}: OrganizerSettingsSectionProps) {
  const { t } = useT("settings");
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: workspaceOrganizerSettingsKey(workspaceId),
    queryFn: () => api.getWorkspaceOrganizerSettings(workspaceId),
  });
  const currentMode = settingsQuery.data?.mode ?? "report_only";
  const [draftMode, setDraftMode] = useState<OrganizerMode>(currentMode);

  useEffect(() => {
    setDraftMode(currentMode);
  }, [currentMode]);

  const mutation = useMutation({
    mutationFn: (mode: OrganizerMode) =>
      api.updateWorkspaceOrganizerSettings(workspaceId, mode),
    onSuccess: (next) => {
      queryClient.setQueryData<WorkspaceOrganizerSettings>(
        workspaceOrganizerSettingsKey(workspaceId),
        next,
      );
      toast.success(t(($) => $.organizer.saved));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t(($) => $.organizer.save_failed));
    },
  });

  const disabled = !canManage || settingsQuery.isPending || mutation.isPending;

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.organizer.title)}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.organizer.description)}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-4">
          <RadioGroup
            value={draftMode}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === "report_only" || value === "act") setDraftMode(value);
            }}
            aria-label={t(($) => $.organizer.mode_label)}
          >
            <ModeOption
              id="organizer-report-only"
              value="report_only"
              label={t(($) => $.organizer.report_only_label)}
              description={t(($) => $.organizer.report_only_description)}
              disabled={disabled}
            />
            <ModeOption
              id="organizer-act"
              value="act"
              label={t(($) => $.organizer.act_label)}
              description={t(($) => $.organizer.act_description)}
              disabled={disabled}
            />
          </RadioGroup>

          {settingsQuery.isError && (
            <div className="flex items-center justify-between gap-3 border-t pt-3">
              <p className="text-xs text-destructive">{t(($) => $.organizer.load_failed)}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void settingsQuery.refetch()}
              >
                {t(($) => $.organizer.retry)}
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              {canManage
                ? t(($) => $.organizer.audit_hint)
                : t(($) => $.organizer.read_only)}
            </p>
            <Button
              size="sm"
              disabled={disabled || settingsQuery.isError || draftMode === currentMode}
              onClick={() => mutation.mutate(draftMode)}
            >
              {mutation.isPending
                ? t(($) => $.organizer.saving)
                : t(($) => $.organizer.save)}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function ModeOption({
  id,
  value,
  label,
  description,
  disabled,
}: {
  id: string;
  value: OrganizerMode;
  label: string;
  description: string;
  disabled: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-data-checked:border-foreground/30 has-data-checked:bg-muted/40 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60"
    >
      <RadioGroupItem
        id={id}
        value={value}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}
