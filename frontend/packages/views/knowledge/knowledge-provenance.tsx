"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  Boxes,
  CircleDot,
  GitCommitHorizontal,
  History,
  List,
  Sparkles,
} from "lucide-react";
import { knowledgeRunOptions } from "@multiremi/core/knowledge";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type {
  KnowledgeCompilationOutput,
  KnowledgeCompilationSource,
} from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { ActorAvatar } from "../common/actor-avatar";
import { AppLink } from "../navigation";
import { useT } from "../i18n";

function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function SourceItem({ source }: { source: KnowledgeCompilationSource }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const submission = source.submission;
  const issue = submission?.source_issue;
  const commit = submission?.source_revision
    ?? metadataText(source.metadata, "after_sha")
    ?? metadataText(source.metadata, "before_sha");
  const label = submission
    ? `${submission.source_type} · ${submission.id}`
    : source.submission_id ?? source.source_ref ?? source.source_type;

  return (
    <li className="min-w-0 border-l pl-3">
      <div className="truncate text-xs font-medium" title={label}>{label}</div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {issue && (
          <AppLink href={paths.issueDetail(issue.id)} className="hover:text-foreground hover:underline">
            {issue.key || issue.title || issue.id}
          </AppLink>
        )}
        {submission?.source_task_id && (
          <span title={submission.source_task_id}>
            {t(($) => $.knowledge.provenance_task)} {submission.source_task_id}
          </span>
        )}
        {submission?.author_agent_id && (
          <span className="flex items-center gap-1">
            <ActorAvatar actorType="agent" actorId={submission.author_agent_id} size={14} />
            {submission.author_agent?.name || submission.author_agent_id}
          </span>
        )}
        {commit && (
          <span className="flex items-center gap-1 font-mono" title={commit}>
            <GitCommitHorizontal className="size-3" />
            {commit.slice(0, 12)}
          </span>
        )}
      </div>
    </li>
  );
}

function OutputItem({ output, runProjectId, runRepositoryId }: {
  output: KnowledgeCompilationOutput;
  runProjectId: string | null;
  runRepositoryId: string | null;
}) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const label = output.artifact?.title || output.artifact?.path || output.doc_id
    || t(($) => $.knowledge.provenance_no_artifact);
  const href = output.artifact
    ? output.artifact_scope === "repository_wiki" && runRepositoryId
      ? paths.repositoryWikiPage(runRepositoryId, output.artifact.path || output.artifact.id)
      : runProjectId
        ? paths.projectWikiPage(runProjectId, output.artifact.id)
        : null
    : null;
  const content = (
    <>
      <span className="truncate" title={label}>{label}</span>
      {output.version !== null && (
        <span className="shrink-0 text-muted-foreground">{t(($) => $.knowledge.version_short, { version: output.version })}</span>
      )}
    </>
  );

  return (
    <li className="flex min-w-0 items-center gap-1.5 text-xs">
      <Badge variant="outline" className="shrink-0 font-normal">{output.action}</Badge>
      {href ? (
        <AppLink href={href} className="flex min-w-0 items-center gap-1 hover:underline">
          {content}
        </AppLink>
      ) : (
        <span className="flex min-w-0 items-center gap-1">{content}</span>
      )}
    </li>
  );
}

export function KnowledgeProvenance({ compilationRunId }: { compilationRunId?: string | null }) {
  const { t } = useT("projects");
  const workspaceId = useWorkspaceId();
  const query = useQuery(knowledgeRunOptions(workspaceId, compilationRunId));

  if (!compilationRunId) {
    return (
      <div className="mt-4 flex items-center gap-2 border-y bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        <History className="size-4 shrink-0" />
        <Badge variant="outline">{t(($) => $.knowledge.history_unverified)}</Badge>
        <span>{t(($) => $.knowledge.history_unverified_hint)}</span>
      </div>
    );
  }

  if (query.isPending) {
    return <Skeleton className="mt-4 h-24 w-full" data-testid="provenance-loading" />;
  }

  if (query.isError || !query.data?.run?.id) {
    return (
      <div className="mt-4 flex items-center gap-2 border-y bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        <CircleDot className="size-4 shrink-0" />
        <Badge variant="outline">{t(($) => $.knowledge.provenance_unknown)}</Badge>
        <span>{t(($) => $.knowledge.provenance_unavailable)}</span>
      </div>
    );
  }

  const { run, sources, outputs } = query.data;
  return (
    <section className="mt-4 border-y bg-muted/20 px-3 py-3" aria-label={t(($) => $.knowledge.provenance_title)}>
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-muted-foreground" />
        <h2 className="text-xs font-medium">{t(($) => $.knowledge.provenance_title)}</h2>
        <Badge variant="secondary" className="font-mono font-normal">{run.id}</Badge>
        <Badge variant="outline" className="font-normal">{run.status}</Badge>
      </div>

      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Bot className="size-3.5" />
            {t(($) => $.knowledge.provenance_agent)}
          </dt>
          <dd className="mt-1 truncate">
            {run.agent_id ? (
              <span className="inline-flex items-center gap-1.5">
                <ActorAvatar actorType="agent" actorId={run.agent_id} size={16} />
                {run.agent?.name || run.agent_id}
              </span>
            ) : t(($) => $.knowledge.provenance_manual)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Boxes className="size-3.5" />
            {t(($) => $.knowledge.provenance_skill)}
          </dt>
          <dd className="mt-1 truncate">
            {run.skill_names.length > 0
              ? run.skill_names.join(", ")
              : run.mode === "manual_edit"
                ? t(($) => $.knowledge.provenance_manual)
                : t(($) => $.knowledge.provenance_unknown)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{t(($) => $.knowledge.provenance_decision)}</dt>
          <dd className="mt-1 truncate" title={run.result_summary ?? run.mode}>
            {run.result_summary || run.mode}
          </dd>
        </div>
      </dl>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-xs font-medium">
            <List className="size-3.5 text-muted-foreground" />
            {t(($) => $.knowledge.provenance_sources)}
            <span className="font-normal tabular-nums text-muted-foreground">{sources.length}</span>
          </h3>
          {sources.length > 0 ? (
            <ul className="mt-2 space-y-2">{sources.map((source) => <SourceItem key={source.id} source={source} />)}</ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">{t(($) => $.knowledge.provenance_no_sources)}</p>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-xs font-medium">
            <Boxes className="size-3.5 text-muted-foreground" />
            {t(($) => $.knowledge.provenance_outputs)}
            <span className="font-normal tabular-nums text-muted-foreground">{outputs.length}</span>
          </h3>
          {outputs.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {outputs.map((output) => (
                <OutputItem
                  key={output.id}
                  output={output}
                  runProjectId={run.project_id}
                  runRepositoryId={run.repository_id}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">{t(($) => $.knowledge.provenance_no_outputs)}</p>
          )}
        </div>
      </div>
    </section>
  );
}
