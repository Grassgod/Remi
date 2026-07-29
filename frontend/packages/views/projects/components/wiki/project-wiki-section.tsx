"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookText, Brain, FileText, Pin } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { projectDocListOptions } from "@multiremi/core/project-docs";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type { ProjectDoc } from "@multiremi/core/types";
import { ActorAvatar } from "../../../common/actor-avatar";
import { DocRefs } from "../../../common/doc-refs";
import { ReadonlyContent } from "../../../editor";
import { AppLink } from "../../../navigation";
import { useT } from "../../../i18n";
import { useFormatRelativeDate } from "../labels";
import { extractWikiLinkSlugs, replaceWikiLinkMarkers } from "./wiki-links";

// The memory node is a pseudo-entry pinned to the top of the left column: it
// has no doc id of its own, it stands for "all memory entries of this
// project". Selection state is a doc id or this sentinel.
const MEMORY_NODE = "__memory__";

function byUpdatedAtDesc(a: ProjectDoc, b: ProjectDoc): number {
  return b.updated_at.localeCompare(a.updated_at);
}

// ---------------------------------------------------------------------------
// Left column
// ---------------------------------------------------------------------------

function SidebarRow({
  icon,
  label,
  count,
  active,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Right pane — a wiki page
// ---------------------------------------------------------------------------

/** `[[slug]]` targets of the open page, rendered as chips below the body. */
function WikiLinkChips({
  slugs,
  pages,
  onSelect,
}: {
  slugs: string[];
  pages: ProjectDoc[];
  onSelect: (docId: string) => void;
}) {
  const { t } = useT("projects");
  if (slugs.length === 0) return null;

  return (
    <div className="mt-5 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">
        {t(($) => $.wiki.links_label)}
      </span>
      {slugs.map((slug) => {
        const target = pages.find((page) => page.slug === slug);
        return target ? (
          <Badge
            key={slug}
            variant="secondary"
            className="cursor-pointer hover:bg-accent"
            render={<button type="button" />}
            onClick={() => onSelect(target.id)}
          >
            {target.title}
          </Badge>
        ) : (
          <Badge
            key={slug}
            variant="outline"
            className="text-muted-foreground"
            title={t(($) => $.wiki.link_missing)}
          >
            {slug}
          </Badge>
        );
      })}
    </div>
  );
}

function WikiPagePane({
  doc,
  pages,
  onSelect,
}: {
  doc: ProjectDoc;
  pages: ProjectDoc[];
  onSelect: (docId: string) => void;
}) {
  const { t } = useT("projects");
  const formatRelativeDate = useFormatRelativeDate();
  const updatedByType = doc.updated_by_type ?? doc.author_type;
  const updatedById = doc.updated_by_id ?? doc.author_id;
  const linkedSlugs = extractWikiLinkSlugs(doc.body);
  const body = replaceWikiLinkMarkers(
    doc.body,
    (slug) => pages.find((page) => page.slug === slug)?.title ?? null,
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-5">
      <h2 className="text-lg font-semibold">{doc.title}</h2>
      {doc.summary && (
        <p className="mt-1 text-sm text-muted-foreground">{doc.summary}</p>
      )}
      <DocRefs refs={doc.refs ?? []} className="mt-2" />
      <div className="mt-4">
        <ReadonlyContent content={body} />
      </div>
      <WikiLinkChips slugs={linkedSlugs} pages={pages} onSelect={onSelect} />
      <div className="mt-6 flex flex-wrap items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
        <span>{t(($) => $.wiki.updated_by)}</span>
        {updatedByType && updatedById ? (
          <>
            <ActorAvatar actorType={updatedByType} actorId={updatedById} size={16} />
            <ActorName actorType={updatedByType} actorId={updatedById} />
          </>
        ) : (
          <span>{t(($) => $.wiki.unknown_author)}</span>
        )}
        <span>·</span>
        <span>{formatRelativeDate(doc.updated_at)}</span>
        <span>·</span>
        <span>{t(($) => $.wiki.version, { version: doc.version })}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane — the memory card stream
// ---------------------------------------------------------------------------

function MemoryCard({ doc }: { doc: ProjectDoc }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  // `memory add --summary` writes a summary with no body. A memory card has no
  // second surface to show it on, so it stands in for the missing body rather
  // than being stored and never read.
  const detail = doc.body || doc.summary;

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium">{doc.title}</p>
        {doc.pinned && (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <Pin className="h-3 w-3" />
            {t(($) => $.wiki.pinned_badge)}
          </Badge>
        )}
      </div>
      {detail && (
        <p className="mt-1.5 whitespace-pre-wrap text-sm text-muted-foreground">
          {detail}
        </p>
      )}
      <DocRefs refs={doc.refs ?? []} className="mt-2" />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {doc.author_type && doc.author_id && (
          <>
            <ActorAvatar
              actorType={doc.author_type}
              actorId={doc.author_id}
              size={16}
            />
            <ActorName actorType={doc.author_type} actorId={doc.author_id} />
            <span>·</span>
          </>
        )}
        <span>{formatRelativeDate(doc.updated_at)}</span>
        {doc.source_issue_id && (
          <>
            <span>·</span>
            <AppLink
              href={paths.issueDetail(doc.source_issue_id)}
              className="hover:text-foreground hover:underline"
            >
              {t(($) => $.wiki.source_issue)}
            </AppLink>
          </>
        )}
      </div>
    </div>
  );
}

function MemoryPane({ docs }: { docs: ProjectDoc[] }) {
  const { t } = useT("projects");
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-5">
      <h2 className="text-lg font-semibold">{t(($) => $.wiki.memory_node)}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(($) => $.wiki.memory_description)}
      </p>
      {docs.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {t(($) => $.wiki.memory_empty)}
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {docs.map((doc) => (
            <MemoryCard key={doc.id} doc={doc} />
          ))}
        </div>
      )}
    </div>
  );
}

// Small wrapper so the name resolution hook stays out of the card bodies.
function ActorName({
  actorType,
  actorId,
}: {
  actorType: string;
  actorId: string;
}) {
  const { getActorName } = useActorName();
  return <span className="text-foreground">{getActorName(actorType, actorId)}</span>;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function ProjectWikiSection({ projectId }: { projectId: string }) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const { data: docs = [] } = useQuery(projectDocListOptions(wsId, projectId));
  const [selected, setSelected] = useState<string>(MEMORY_NODE);

  const memoryDocs = docs.filter((doc) => doc.kind === "memory");
  // Wiki pages sort newest-first; the server sorts pinned-first, which is the
  // memory index's ordering, not the page list's.
  const wikiDocs = docs
    .filter((doc) => doc.kind === "wiki")
    .sort(byUpdatedAtDesc);

  if (docs.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <BookText className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="mt-4 text-base font-semibold">
          {t(($) => $.wiki.empty_title)}
        </h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {t(($) => $.wiki.empty_hint)}
        </p>
      </div>
    );
  }

  // A doc can disappear under the selection (deleted elsewhere, WS
  // invalidation refetches). Falling back to the memory node keeps the pane
  // rendering instead of going blank.
  const selectedDoc = wikiDocs.find((doc) => doc.id === selected);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r p-2">
        <SidebarRow
          icon={<Brain className="h-4 w-4 shrink-0" />}
          label={t(($) => $.wiki.memory_node)}
          count={memoryDocs.length}
          active={!selectedDoc}
          onSelect={() => setSelected(MEMORY_NODE)}
        />
        {wikiDocs.map((doc) => (
          <SidebarRow
            key={doc.id}
            icon={<FileText className="h-4 w-4 shrink-0" />}
            label={doc.title}
            active={selectedDoc?.id === doc.id}
            onSelect={() => setSelected(doc.id)}
          />
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selectedDoc ? (
          <WikiPagePane
            doc={selectedDoc}
            pages={wikiDocs}
            onSelect={setSelected}
          />
        ) : (
          <MemoryPane docs={memoryDocs} />
        )}
      </div>
    </div>
  );
}
