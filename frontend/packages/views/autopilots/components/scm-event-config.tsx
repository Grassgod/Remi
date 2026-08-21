"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, GitPullRequest } from "lucide-react";
import { scmCapabilitiesOptions, scmConnectionsOptions } from "@multiremi/core/scm";
import { useWorkspaceId } from "@multiremi/core/hooks";
import type {
  AutopilotScmEventConfig,
  CanonicalScmEventType,
  ScmCapabilitiesResponse,
  ScmConnection,
  ScmSyncStream,
} from "@multiremi/core/types";
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { useT } from "../../i18n";

const EVENT_GROUPS: Array<{
  key: "changes" | "collaboration" | "delivery";
  events: CanonicalScmEventType[];
}> = [
  {
    key: "changes",
    events: [
      "change.opened",
      "change.updated",
      "change.reopened",
      "change.merged",
      "change.closed",
    ],
  },
  {
    key: "collaboration",
    events: [
      "comment.created",
      "comment.updated",
      "comment.deleted",
      "review.submitted",
      "review.dismissed",
    ],
  },
  {
    key: "delivery",
    events: [
      "pipeline.started",
      "pipeline.completed",
      "push.observed",
      "default_branch.updated",
    ],
  },
];

const EVENT_STREAM: Record<CanonicalScmEventType, ScmSyncStream> = {
  "change.opened": "change_requests",
  "change.updated": "change_requests",
  "change.closed": "change_requests",
  "change.reopened": "change_requests",
  "change.merged": "change_requests",
  "comment.created": "comments",
  "comment.updated": "comments",
  "comment.deleted": "comments",
  "review.submitted": "reviews",
  "review.dismissed": "reviews",
  "pipeline.started": "pipelines",
  "pipeline.completed": "pipelines",
  "default_branch.updated": "default_branch",
  "push.observed": "default_branch",
};

const BRANCH_FILTERABLE_EVENTS = new Set<CanonicalScmEventType>([
  "change.opened",
  "change.updated",
  "change.closed",
  "change.reopened",
  "change.merged",
  "pipeline.started",
  "pipeline.completed",
  "default_branch.updated",
  "push.observed",
]);

export function getDefaultScmEventConfig(): AutopilotScmEventConfig {
  return {
    resource: "scm",
    events: ["change.merged"],
    connectionId: null,
    repositoryIds: [],
    branch: null,
  };
}

export function serializeScmEventConfig(config: AutopilotScmEventConfig): string {
  return JSON.stringify({
    resource: "scm",
    events: [...config.events].sort(),
    connectionId: config.connectionId ?? null,
    repositoryIds: [...(config.repositoryIds ?? [])].sort(),
    branch: config.branch?.trim() || null,
  });
}

export function ScmEventConfigSection({
  config,
  onChange,
}: {
  config: AutopilotScmEventConfig;
  onChange: (config: AutopilotScmEventConfig) => void;
}) {
  const { t } = useT("autopilots");
  const workspaceId = useWorkspaceId();
  const { data } = useQuery(scmConnectionsOptions(workspaceId));
  const { data: capabilities } = useQuery(scmCapabilitiesOptions());
  const connections = data?.connections.filter((connection) => connection.enabled) ?? [];
  const selectedConnection = connections.find(
    (connection) => connection.id === config.connectionId,
  );
  const selectedConnectionLabel = selectedConnection
    ? formatConnectionLabel(selectedConnection)
    : t(($) => $.dialog.scm_event.all_connections);
  const repositoryOptions = useMemo(() => {
    const source = selectedConnection ? [selectedConnection] : connections;
    const byId = new Map<string, { id: string; name: string; url: string }>();
    for (const connection of source) {
      for (const repository of connection.repositories) {
        byId.set(repository.repositoryId, {
          id: repository.repositoryId,
          name: repository.name,
          url: repository.repositoryUrl,
        });
      }
    }
    return [...byId.values()];
  }, [connections, selectedConnection]);
  const scopedConnections = useMemo(() => {
    const candidates = selectedConnection ? [selectedConnection] : connections;
    const repositoryIds = config.repositoryIds ?? [];
    if (!repositoryIds.length) return candidates;
    return candidates.filter((connection) => connection.repositories.some(
      (repository) => repositoryIds.includes(repository.repositoryId),
    ));
  }, [config.repositoryIds, connections, selectedConnection]);
  const availableEvents = useMemo(() => new Set(
    EVENT_GROUPS.flatMap((group) => group.events).filter((event) =>
      !capabilities || (
        scopedConnections.length > 0
        && scopedConnections.every((connection) =>
          connectionSupportsEvent(connection, event, capabilities))
      )),
  ), [capabilities, scopedConnections]);

  const toggleEvent = (event: CanonicalScmEventType, checked: boolean) => {
    const events = checked
      ? [...new Set([...config.events, event])]
      : config.events.filter((candidate) => candidate !== event);
    onChange({
      ...config,
      events,
      branch: events.every((candidate) => BRANCH_FILTERABLE_EVENTS.has(candidate))
        ? config.branch
        : null,
    });
  };
  const toggleRepository = (repositoryId: string, checked: boolean) => {
    const current = config.repositoryIds ?? [];
    onChange({
      ...config,
      repositoryIds: checked
        ? [...new Set([...current, repositoryId])]
        : current.filter((candidate) => candidate !== repositoryId),
    });
  };

  return (
    <div className="space-y-3">
      <Field label={t(($) => $.dialog.scm_event.connection_label)}>
        <Select
          value={config.connectionId ?? "__all__"}
          onValueChange={(value) =>
            onChange({
              ...config,
              connectionId: value === "__all__" ? null : value,
              repositoryIds: [],
            })
          }
        >
          <SelectTrigger className="w-full bg-background">
            <SelectValue>{() => selectedConnectionLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t(($) => $.dialog.scm_event.all_connections)}</SelectItem>
            {connections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {formatConnectionLabel(connection)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label={t(($) => $.dialog.scm_event.repositories_label)}>
        <div className="max-h-36 overflow-y-auto rounded-md border bg-background">
          {repositoryOptions.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">
              {t(($) => $.dialog.scm_event.no_repositories)}
            </p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-xs">
                <Checkbox
                  checked={(config.repositoryIds ?? []).length === 0}
                  onCheckedChange={() => onChange({ ...config, repositoryIds: [] })}
                />
                <span className="font-medium">{t(($) => $.dialog.scm_event.all_repositories)}</span>
              </label>
              {repositoryOptions.map((repository) => (
                <label key={repository.id} className="flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 last:border-b-0 hover:bg-muted/40">
                  <Checkbox
                    checked={(config.repositoryIds ?? []).includes(repository.id)}
                    onCheckedChange={(checked) => toggleRepository(repository.id, checked)}
                  />
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-xs">{repository.name}</span>
                </label>
              ))}
            </>
          )}
        </div>
      </Field>

      <Field label={t(($) => $.dialog.scm_event.events_label)}>
        <div className="space-y-2 rounded-md border bg-background p-2.5">
          {EVENT_GROUPS.map((group) => (
            <div key={group.key}>
              <p className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                {t(($) => $.dialog.scm_event.groups[group.key])}
              </p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                {group.events.map((event) => (
                  <label key={event} className="flex min-w-0 cursor-pointer items-center gap-2 text-xs">
                    <Checkbox
                      checked={config.events.includes(event)}
                      disabled={!availableEvents.has(event) && !config.events.includes(event)}
                      onCheckedChange={(checked) => toggleEvent(event, checked)}
                    />
                    <span className={availableEvents.has(event) ? "truncate" : "truncate text-muted-foreground/60"}>
                      {t(($) => $.dialog.scm_event.events[event])}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Field>

      {config.events.length > 0
        && config.events.every((event) => BRANCH_FILTERABLE_EVENTS.has(event)) && (
        <Field label={t(($) => $.dialog.scm_event.branch_label)}>
          <div className="relative">
            <GitPullRequest className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="bg-background pl-9"
              value={config.branch ?? ""}
              onChange={(event) => onChange({ ...config, branch: event.target.value || null })}
              placeholder={t(($) => $.dialog.scm_event.branch_placeholder)}
            />
          </div>
        </Field>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(($) => $.dialog.scm_event.hint)}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>{children}</div>;
}

function formatConnectionLabel(connection: Pick<ScmConnection, "name" | "provider">): string {
  return `${connection.name} · ${connection.provider === "github" ? "GitHub" : "Codebase"}`;
}

function connectionSupportsEvent(
  connection: ScmConnection,
  event: CanonicalScmEventType,
  capabilities: ScmCapabilitiesResponse,
): boolean {
  const stream = capabilities.providers[connection.provider].streams[EVENT_STREAM[event]];
  const polls = connection.mode !== "webhook" && stream.poll;
  const receivesWebhook = connection.mode !== "poll" && stream.webhook;
  if (event === "comment.deleted") return receivesWebhook;
  return polls || receivesWebhook;
}
