"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban } from "lucide-react";
import type {
  AutopilotSystemEventConfig,
  IssueStatus,
} from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { projectListOptions } from "@multiremi/core/projects/queries";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { ProjectPicker } from "../../projects/components/project-picker";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useT } from "../../i18n";

const STATUS_VALUES: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

export function getDefaultSystemEventConfig(): AutopilotSystemEventConfig {
  return {
    resource: "issue",
    event: "status_changed",
    conditions: [{ field: "status", operator: "becomes", value: "done" }],
    project_id: null,
  };
}

export function serializeSystemEventConfig(config: AutopilotSystemEventConfig): string {
  return JSON.stringify({
    resource: config.resource,
    event: config.event,
    conditions: config.conditions,
    project_id: config.project_id ?? null,
  });
}

export function SystemEventConfigSection({
  config,
  onChange,
}: {
  config: AutopilotSystemEventConfig;
  onChange: (config: AutopilotSystemEventConfig) => void;
}) {
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === config.project_id) ?? null,
    [config.project_id, projects],
  );
  const condition = config.conditions[0] ?? getDefaultSystemEventConfig().conditions[0]!;

  const updateCondition = (updates: Partial<typeof condition>) => {
    onChange({
      ...config,
      conditions: [{ ...condition, ...updates }],
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label={t(($) => $.dialog.system_event.resource_label)}>
          <StaticValue>{t(($) => $.dialog.system_event.resource_issue)}</StaticValue>
        </Field>
        <Field label={t(($) => $.dialog.system_event.event_label)}>
          <StaticValue>{t(($) => $.dialog.system_event.event_status_changed)}</StaticValue>
        </Field>
      </div>

      <Field label={t(($) => $.dialog.system_event.condition_label)}>
        <div className="grid grid-cols-[1fr_1fr_1.15fr] gap-1.5">
          <StaticValue>{t(($) => $.dialog.system_event.field_status)}</StaticValue>
          <StaticValue>{t(($) => $.dialog.system_event.operator_becomes)}</StaticValue>
          <Select
            value={condition.value}
            onValueChange={(value) => updateCondition({ value: value as IssueStatus })}
          >
            <SelectTrigger className="w-full bg-background px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_VALUES.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(($) => $.dialog.system_event.statuses[status])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Field>

      <Field label={t(($) => $.dialog.system_event.project_scope_label)}>
        <ProjectPicker
          projectId={config.project_id ?? null}
          onUpdate={(updates) => onChange({ ...config, project_id: updates.project_id ?? null })}
          align="start"
          triggerRender={
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-accent/40"
            >
              {selectedProject ? (
                <ProjectIcon project={selectedProject} size="md" />
              ) : (
                <span className="inline-flex size-5 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <FolderKanban className="size-3.5" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {selectedProject?.title ?? t(($) => $.dialog.system_event.all_projects)}
              </span>
            </button>
          }
        />
      </Field>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(($) => $.dialog.system_event.hint)}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function StaticValue({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center rounded-md border bg-muted/30 px-3 py-2 text-sm">
      {children}
    </div>
  );
}
