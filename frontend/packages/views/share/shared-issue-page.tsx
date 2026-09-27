"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CalendarDays,
  Clock3,
  Download,
  FileText,
  FolderGit2,
  Link2,
  Loader2,
  UserRound,
} from "lucide-react";
import type {
  AgentTask,
  SharedIssueActor,
  SharedIssueBundle,
  SharedTaskTracePage,
  TimelineEntry,
} from "@multiremi/core/types";
import { api } from "@multiremi/core/api";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Markdown } from "@multiremi/ui/markdown";
import { useT } from "../i18n";
import { PriorityIcon, StatusIcon } from "../issues/components";

export function SharedIssuePage({ token }: { token: string }) {
  const { t } = useT("issues");
  const query = useQuery({
    queryKey: ["shared-issue", token],
    queryFn: () => api.getSharedIssue(token),
    retry: false,
  });

  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t(($) => $.share.loading)}
      </div>
    );
  }

  if (query.isError || !query.data?.issue.id) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div className="max-w-md text-center">
          <Link2 className="mx-auto mb-4 size-6 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t(($) => $.share.unavailable_title)}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t(($) => $.share.unavailable_description)}
          </p>
        </div>
      </div>
    );
  }

  return <SharedIssueDocument bundle={query.data} token={token} />;
}

function SharedIssueDocument({ bundle, token }: { bundle: SharedIssueBundle; token: string }) {
  const { t } = useT("issues");
  const { issue } = bundle;
  const actorName = (type: string | null, id: string | null) => {
    if (!type || !id) return "-";
    return bundle.actors.find((actor) => actor.type === type && actor.id === id)?.name ?? id;
  };
  const expires = formatDateTime(bundle.share.expires_at);

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{t(($) => $.share.shared_issue)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{t(($) => $.share.read_only)}</Badge>
            <span className="hidden sm:inline">{t(($) => $.share.expires, { date: expires })}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl grid-cols-1 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <article className="min-w-0 px-5 py-8 sm:px-8 lg:border-r lg:py-10">
          <div className="mb-8">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <StatusIcon status={issue.status} className="size-4" />
              <span>{issue.identifier}</span>
              {bundle.project && <span>/ {bundle.project.title}</span>}
            </div>
            <h1 className="text-2xl font-semibold leading-tight sm:text-3xl">{issue.title}</h1>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock3 className="size-3.5" />
                {formatDateTime(issue.updated_at)}
              </span>
              <span>{t(($) => $.share.views, { count: bundle.share.view_count })}</span>
            </div>
          </div>

          <DocumentSection title={t(($) => $.share.description)}>
            {issue.description ? (
              <div className="text-sm leading-7">
                <Markdown>{issue.description}</Markdown>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t(($) => $.share.no_description)}</p>
            )}
          </DocumentSection>

          {(issue.attachments?.length ?? 0) > 0 && (
            <DocumentSection title={t(($) => $.share.attachments)}>
              <div className="divide-y rounded-md border">
                {issue.attachments!.map((attachment) => (
                  <a
                    key={attachment.id}
                    href={attachment.download_url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50"
                  >
                    <Download className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(attachment.size_bytes)}</span>
                  </a>
                ))}
              </div>
            </DocumentSection>
          )}

          {bundle.children.length > 0 && (
            <DocumentSection title={t(($) => $.share.sub_issues)}>
              <div className="divide-y border-y">
                {bundle.children.map((child) => (
                  <div key={child.id} className="flex min-w-0 items-center gap-3 py-2.5 text-sm">
                    <StatusIcon status={child.status} className="size-4 shrink-0" />
                    <span className="shrink-0 text-muted-foreground">{child.identifier}</span>
                    <span className="truncate">{child.title}</span>
                  </div>
                ))}
              </div>
            </DocumentSection>
          )}

          {bundle.session_results.length > 0 && (
            <DocumentSection title={t(($) => $.share.results)}>
              <div className="space-y-6">
                {bundle.session_results.map((result) => (
                  <div key={result.id} className="border-l-2 pl-4">
                    <div className="mb-2 text-sm font-medium">{result.title || t(($) => $.detail.result_untitled)}</div>
                    <div className="text-sm leading-6"><Markdown>{result.body}</Markdown></div>
                  </div>
                ))}
              </div>
            </DocumentSection>
          )}

          {(bundle.sessions.length > 0 || bundle.tasks.length > 0) && (
            <DocumentSection title={t(($) => $.share.sessions)}>
              <div className="space-y-7">
                {bundle.sessions.map((session) => (
                  <section key={session.id}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="truncate text-sm font-medium">{session.title}</h3>
                      <span className="shrink-0 text-xs text-muted-foreground">{session.status}</span>
                    </div>
                    {session.summary && <p className="mb-3 text-sm text-muted-foreground">{session.summary}</p>}
                    <div className="space-y-2 border-l pl-4">
                      {session.events.map((event) => (
                        <div key={event.id} className="text-sm">
                          <div className="mb-0.5 text-xs text-muted-foreground">
                            {actorName(event.author_type, event.author_id)} · {formatDateTime(event.created_at)}
                          </div>
                          <Markdown mode="minimal">{event.body}</Markdown>
                        </div>
                      ))}
                      {session.tasks.map((task) => (
                        <SharedTask key={task.id} task={task} actors={bundle.actors} token={token} />
                      ))}
                    </div>
                  </section>
                ))}
                {bundle.tasks.map((task) => (
                  <SharedTask key={task.id} task={task} actors={bundle.actors} token={token} />
                ))}
              </div>
            </DocumentSection>
          )}

          <DocumentSection title={t(($) => $.share.timeline)} last>
            {bundle.timeline.length > 0 ? (
              <div className="space-y-5">
                {bundle.timeline.map((entry) => (
                  <SharedTimelineEntry
                    key={entry.id}
                    entry={entry}
                    actor={findActor(bundle.actors, entry.actor_type, entry.actor_id)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t(($) => $.share.no_activity)}</p>
            )}
          </DocumentSection>
        </article>

        <aside className="px-5 py-8 sm:px-8 lg:px-6 lg:py-10">
          <h2 className="mb-4 text-sm font-medium">{t(($) => $.share.details)}</h2>
          <dl className="space-y-4 text-sm">
            <DetailRow label={t(($) => $.share.status)}>
              <span className="inline-flex items-center gap-2">
                <StatusIcon status={issue.status} className="size-4" />
                {t(($) => $.status[issue.status])}
              </span>
            </DetailRow>
            <DetailRow label={t(($) => $.share.priority)}>
              <span className="inline-flex items-center gap-2">
                <PriorityIcon priority={issue.priority} />
                {t(($) => $.priority[issue.priority])}
              </span>
            </DetailRow>
            <DetailRow label={t(($) => $.share.assignee)}>
              <span className="inline-flex min-w-0 items-center gap-2">
                {issue.assignee_type === "agent" ? <Bot className="size-4" /> : <UserRound className="size-4" />}
                <span className="truncate">{actorName(issue.assignee_type, issue.assignee_id)}</span>
              </span>
            </DetailRow>
            {bundle.project && (
              <DetailRow label={t(($) => $.share.project)}>{bundle.project.title}</DetailRow>
            )}
            {(issue.start_date || issue.due_date) && (
              <DetailRow label={t(($) => $.actions.due_date)}>
                <span className="inline-flex items-center gap-2">
                  <CalendarDays className="size-4" />
                  {issue.start_date ?? "-"} / {issue.due_date ?? "-"}
                </span>
              </DetailRow>
            )}
          </dl>

          {bundle.issue_workspace && (
            <div className="mt-8 border-t pt-6">
              <h2 className="mb-3 text-sm font-medium">{t(($) => $.share.worktree)}</h2>
              <div className="space-y-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="size-4" />
                  <span className="min-w-0 truncate">{bundle.issue_workspace.branch_name}</span>
                </div>
                {bundle.issue_workspace.repos.map((repo) => (
                  <div key={repo.repo_url} className="min-w-0 truncate pl-6">{repo.repo_name}</div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function DocumentSection({
  title,
  children,
  last = false,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section className={last ? "py-7" : "border-b py-7"}>
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function SharedTimelineEntry({
  entry,
  actor,
}: {
  entry: TimelineEntry;
  actor: SharedIssueActor | null;
}) {
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-3">
      <div className="mt-1.5 size-2 rounded-full bg-muted-foreground/40" />
      <div className="min-w-0">
        <div className="mb-1 text-xs text-muted-foreground">
          {(actor?.name ?? entry.actor_id) || "System"} · {formatDateTime(entry.created_at)}
        </div>
        {entry.type === "comment" ? (
          <div className="text-sm leading-6"><Markdown mode="minimal">{entry.content ?? ""}</Markdown></div>
        ) : (
          <p className="text-sm">{entry.action ?? "Activity"}</p>
        )}
      </div>
    </div>
  );
}

export function SharedTask({
  task,
  actors,
  token,
}: {
  task: AgentTask;
  actors: SharedIssueActor[];
  token: string;
}) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const trace = useQuery({
    queryKey: ["shared-task-trace", token, task.id, requestVersion],
    enabled: open,
    retry: false,
    queryFn: async () => {
      const events: SharedTaskTracePage["events"] = [];
      let afterSeq = 0;
      for (;;) {
        const page = await api.getSharedTaskTrace(token, task.id, afterSeq);
        if (page.state !== "ok") return { events, state: page.state, runtimeName: page.runtime_name };
        events.push(...page.events);
        if (page.eof) return { events, state: "ok" as const, runtimeName: page.runtime_name };
        if (page.next_after_seq <= afterSeq) throw new Error("trace cursor did not advance");
        afterSeq = page.next_after_seq;
      }
    },
  });
  const agent = findActor(actors, "agent", task.agent_id);
  const state = trace.data?.state;
  const stateText = state === "unreachable"
    ? t(($) => $.share.trace_unreachable, { name: trace.data?.runtimeName ?? "?" })
    : state === "lost" ? t(($) => $.share.trace_lost)
    : state === "backfilling" ? t(($) => $.share.trace_backfilling)
    : null;
  return (
    <details className="border-y py-2 text-sm" onToggle={(event) => {
      const expanded = event.currentTarget.open;
      setOpen(expanded);
      if (expanded) setRequestVersion((version) => version + 1);
    }}>
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <Bot className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{agent?.name ?? task.agent_id}</span>
        <span className="text-xs text-muted-foreground">{task.status}</span>
      </summary>
      <div className="mt-3 space-y-3 pl-6">
        {open && trace.isPending && <p>{t(($) => $.share.trace_loading)}</p>}
        {open && trace.isError && <p>{t(($) => $.share.trace_failed)}</p>}
        {open && stateText && <p>{stateText}</p>}
        {open && trace.data?.events.map((event, index) => (
          <div key={String(event.seq ?? index)} className="overflow-hidden">
            <div className="mb-1 text-[11px] uppercase text-muted-foreground">{event.type}</div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs">
              {messageText(traceEventToMessage(event))}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

export function traceEventToMessage(event: SharedTaskTracePage["events"][number]): Record<string, unknown> {
  return {
    seq: event.seq,
    type: event.type,
    content: event.content ?? null,
    output: event.output ?? null,
    input: event.input ?? null,
    meta: event.meta ?? null,
  };
}

function findActor(actors: SharedIssueActor[], type: string, id: string | null): SharedIssueActor | null {
  if (!id) return null;
  return actors.find((actor) => actor.type === type && actor.id === id) ?? null;
}

export function messageText(message: Record<string, unknown>): string {
  for (const key of ["content", "output", "text", "body", "input"]) {
    const value = message[key];
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(message, null, 2);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
