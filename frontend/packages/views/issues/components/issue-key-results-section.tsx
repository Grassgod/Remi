"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FileCheck2,
  FileOutput,
  FileText,
  GitMerge,
  Rocket,
  Scale,
} from "lucide-react";
import type { IssueSession, ProjectDocRef, SessionResult } from "@multiremi/core/types";
import {
  issueSessionResultsOptions,
  sessionResultKind,
  sessionResultRefs,
  type SessionResultKind,
} from "@multiremi/core/issues";
import { useActorName } from "@multiremi/core/workspace/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { ActorAvatar } from "../../common/actor-avatar";
import { DocRefs } from "../../common/doc-refs";
import { ReadonlyContent } from "../../editor";
import { useT, useTimeAgo } from "../../i18n";
import { getSessionDisplayName } from "../utils/session-display";

// Published Session results are the issue's durable output — the one thing an
// agent hands back that outlives its transcript. They live in the right
// properties panel (next to the execution log) as compact icon cards, and the
// activity timeline only carries a one-line "X published …" pointer at them.
//
// `metadata.kind` picks the icon and `metadata.refs` render as source badges;
// both are conventions an agent writes through the CLI, so both are read
// leniently in `@multiremi/core/issues` — an unknown kind lands on the generic
// icon rather than blanking the card. See docs/issue-key-results.md.

// Scroll target for the timeline's activity line.
export const KEY_RESULTS_SECTION_ID = "issue-key-results";

const KIND_ICON: Record<SessionResultKind, typeof FileOutput> = {
  mr: GitMerge,
  report: FileCheck2,
  deploy: Rocket,
  decision: Scale,
  doc: FileText,
  other: FileOutput,
};

function useKindLabel(kind: SessionResultKind): string {
  const { t } = useT("issues");
  switch (kind) {
    case "mr": return t(($) => $.detail.result_kind_mr);
    case "report": return t(($) => $.detail.result_kind_report);
    case "deploy": return t(($) => $.detail.result_kind_deploy);
    case "decision": return t(($) => $.detail.result_kind_decision);
    case "doc": return t(($) => $.detail.result_kind_doc);
    // `result_kind_other` would be read as a plural form of `result_kind`.
    case "other": return t(($) => $.detail.result_kind_generic);
  }
}

function useResultTitle(result: SessionResult): string {
  const { t } = useT("issues");
  return result.title.trim() || t(($) => $.detail.result_untitled);
}

export function IssueKeyResultsSection({
  issueId,
  sessions,
}: {
  issueId: string;
  sessions: IssueSession[];
}) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(true);
  const { data: results = [] } = useQuery(issueSessionResultsOptions(issueId));

  if (results.length === 0) return null;

  return (
    <div id={KEY_RESULTS_SECTION_ID}>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70 ${
          open ? "" : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.detail.section_key_results)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      {open && (
        <div className="space-y-0.5 pl-2">
          {results.map((result) => (
            <KeyResultCard
              key={result.id}
              result={result}
              // The source session is unresolvable while the sessions query is
              // still in flight, and permanently once it has been archived
              // (the list endpoint drops archived sessions). Neither case may
              // leak the raw session id into the copy.
              sourceTitle={(() => {
                const source = sessions.find(
                  (session) => session.id === result.source_session_id,
                );
                return source
                  ? getSessionDisplayName(t, source)
                  : t(($) => $.detail.result_unknown_session);
              })()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function KeyResultCard({
  result,
  sourceTitle,
}: {
  result: SessionResult;
  sourceTitle: string;
}) {
  const timeAgo = useTimeAgo();
  const [open, setOpen] = useState(false);
  const kind = sessionResultKind(result);
  const kindLabel = useKindLabel(kind);
  const refs = sessionResultRefs(result);
  const title = useResultTitle(result);
  const KindIcon = KIND_ICON[kind];

  return (
    <div className="rounded transition-colors hover:bg-accent/40">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-start gap-2 px-1 py-1.5 text-left"
      >
        <KindIcon
          role="img"
          aria-label={kindLabel}
          className="mt-0.5 h-4 w-4 shrink-0 text-info"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">{title}</span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <ActorAvatar
              actorType={result.published_by_type}
              actorId={result.published_by_id ?? ""}
              size={14}
            />
            <span className="truncate">{timeAgo(result.created_at)}</span>
          </span>
        </span>
      </button>
      {/* Badges sit outside the card button: a ref is a link of its own, and
          an anchor nested in a button is neither valid nor clickable. */}
      <DocRefs refs={refs} className="px-1 pb-1.5 pl-7" />
      <KeyResultDialog
        result={result}
        sourceTitle={sourceTitle}
        refs={refs}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

function KeyResultDialog({
  result,
  sourceTitle,
  refs,
  open,
  onOpenChange,
}: {
  result: SessionResult;
  sourceTitle: string;
  refs: ProjectDocRef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("issues");
  const title = useResultTitle(result);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* An agent writes the body through the CLI as Markdown and it has no
          length bound — the dialog has to scroll rather than grow past the
          viewport, and the Markdown has to render as Markdown. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(($) => $.detail.result_from_session, { session: sourceTitle })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <ReadonlyContent content={result.body} />
          <DocRefs refs={refs} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// One line per published result in the activity timeline. The result itself is
// not repeated here — the line points at the panel section that holds it.
export function IssueResultActivityLines({
  issueId,
  onShowResults,
}: {
  issueId: string;
  onShowResults: () => void;
}) {
  const { data: results = [] } = useQuery(issueSessionResultsOptions(issueId));
  if (results.length === 0) return null;

  return (
    <div className="mt-4 space-y-1">
      {results.map((result) => (
        <ResultActivityLine key={result.id} result={result} onShowResults={onShowResults} />
      ))}
    </div>
  );
}

function ResultActivityLine({
  result,
  onShowResults,
}: {
  result: SessionResult;
  onShowResults: () => void;
}) {
  const { t } = useT("issues");
  const timeAgo = useTimeAgo();
  const { getActorName } = useActorName();
  const title = useResultTitle(result);

  return (
    <button
      type="button"
      onClick={onShowResults}
      className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
    >
      <ActorAvatar
        actorType={result.published_by_type}
        actorId={result.published_by_id ?? ""}
        size={16}
      />
      <span className="shrink-0 font-medium">
        {getActorName(result.published_by_type, result.published_by_id ?? "")}
      </span>
      <span className="truncate">
        {t(($) => $.detail.result_published_activity, { title })}
      </span>
      <span className="ml-auto shrink-0">{timeAgo(result.created_at)}</span>
    </button>
  );
}
