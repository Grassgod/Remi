"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban, GitBranch } from "lucide-react";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { projectListOptions } from "@multiremi/core/projects/queries";
import { repositoryListOptions } from "@multiremi/core/repositories/queries";
import type { ScheduleTargets } from "@multiremi/core/types";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
import { Input } from "@multiremi/ui/components/ui/input";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { useT } from "../../i18n";

export function emptyScheduleTargets(): ScheduleTargets {
  return { projects: { all: false, ids: [] }, repositories: { all: false, ids: [] } };
}

export function hasScheduleTargets(value: ScheduleTargets | null): boolean {
  return Boolean(value && (value.projects.all || value.repositories.all || value.projects.ids.length || value.repositories.ids.length));
}

export function ScheduleTargetsSection({ value, onChange, required = false }: {
  value: ScheduleTargets | null;
  onChange: (value: ScheduleTargets | null) => void;
  required?: boolean;
}) {
  const { t } = useT("autopilots");
  const wsId = useWorkspaceId();
  const projects = useQuery(projectListOptions(wsId));
  const repositories = useQuery(repositoryListOptions(wsId));
  const [query, setQuery] = useState("");
  const groups = [
    { key: "projects" as const, title: t(($) => $.schedule_targets.projects), icon: FolderKanban,
      items: (projects.data ?? []).filter((project) => !project.archived_at).map((project) => ({ id: project.id, name: project.title })),
      loading: projects.isLoading, error: projects.isError },
    { key: "repositories" as const, title: t(($) => $.schedule_targets.repositories), icon: GitBranch,
      items: repositories.data?.repositories ?? [], loading: repositories.isLoading, error: repositories.isError },
  ];
  return <div className="space-y-3">
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={value !== null} disabled={required} onCheckedChange={(checked) => onChange(checked ? emptyScheduleTargets() : null)} />
      {t(($) => $.schedule_targets.enabled)}
    </label>
    {value && <>
      <Input aria-label={t(($) => $.schedule_targets.search)} placeholder={t(($) => $.schedule_targets.search)} value={query} onChange={(event) => setQuery(event.target.value)} />
      {groups.map(({ key, title, icon: Icon, items, loading, error }) => {
        const selection = value[key];
        const filtered = items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
        const missing = selection.ids.filter((id) => !items.some((item) => item.id === id));
        return <fieldset key={key} className="min-w-0 space-y-2">
          <legend className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4" />{title}</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={selection.all} onCheckedChange={(checked) => onChange({ ...value, [key]: { all: checked === true, ids: [] } })} />
            {t(($) => $.schedule_targets.all)}
          </label>
          {!selection.all && <div className="max-h-40 overflow-y-auto rounded-md border p-2 space-y-2">
            {loading ? <span className="text-xs text-muted-foreground">{t(($) => $.schedule_targets.loading)}</span>
              : error ? <span role="alert" className="text-xs text-destructive">{t(($) => $.schedule_targets.error)}</span>
              : filtered.length === 0 && missing.length === 0 ? <span className="text-xs text-muted-foreground">{t(($) => $.schedule_targets.empty)}</span> : null}
            {[...filtered, ...missing.map((id) => ({ id, name: `${t(($) => $.schedule_targets.unavailable)}: ${id}` }))].map((item) => <label key={item.id} className="flex min-w-0 items-center gap-2 text-sm">
              <Checkbox checked={selection.ids.includes(item.id)} onCheckedChange={(checked) => onChange({ ...value, [key]: { all: false, ids: checked ? [...selection.ids, item.id] : selection.ids.filter((id) => id !== item.id) } })} />
              <span className="truncate" title={item.name}>{item.name}</span>
            </label>)}
          </div>}
        </fieldset>;
      })}
      <label className="block space-y-1 text-sm">
        <span>{t(($) => $.schedule_targets.prompt)}</span>
        <Textarea value={value.prompt ?? ""} onChange={(event) => onChange({ ...value, prompt: event.target.value })} rows={3} />
      </label>
      {!hasScheduleTargets(value) && <p role="alert" className="text-xs text-destructive">{t(($) => $.schedule_targets.required)}</p>}
    </>}
  </div>;
}
