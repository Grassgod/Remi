"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, BookText, Brain, FileText, Pin } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
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
      {/* The right pane only shows the title of the page you already opened,
          so a truncated row here would be the only copy of a long agent-written
          title — `title` keeps it recoverable on hover. */}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
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
        // Page titles and slugs are agent-authored strings of unbounded
        // length. Without a width bound a single long (or CJK) title makes the
        // chip wider than the content column and hands the whole scrolling
        // pane a horizontal scrollbar — same bound DocRefs uses.
        return target ? (
          <Badge
            key={slug}
            variant="secondary"
            className="max-w-64 cursor-pointer hover:bg-accent"
            render={<button type="button" />}
            onClick={() => onSelect(target.id)}
            title={target.title}
          >
            <span className="truncate">{target.title}</span>
          </Badge>
        ) : (
          <Badge
            key={slug}
            variant="outline"
            className="max-w-64 text-muted-foreground"
            title={t(($) => $.wiki.link_missing)}
          >
            <span className="truncate">{slug}</span>
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

// A memory body is agent-authored markdown of unbounded length, and the cards
// live in a stream rather than on a page of their own — so a long one is
// clamped with a fade and an explicit toggle. Whether a body is long is
// decided from the source text, not a measured height: no layout read, no
// resize observer, and the same answer on the server and in tests.
const MEMORY_CLAMP_LINES = 6;
const MEMORY_CLAMP_CHARS = 400;

function isLongMemoryBody(body: string): boolean {
  return (
    body.length > MEMORY_CLAMP_CHARS ||
    body.split("\n").length > MEMORY_CLAMP_LINES
  );
}

function MemoryCard({ doc, pages }: { doc: ProjectDoc; pages: ProjectDoc[] }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const [expanded, setExpanded] = useState(false);
  // `memory add --summary` writes a summary with no body. A memory card has no
  // second surface to show it on, so it stands in for the missing body rather
  // than being stored and never read.
  const detail = doc.body || doc.summary;
  // Memory entries come out of the same agent prompt as wiki pages: markdown
  // with `[[slug]]` cross-links. They go through the same pipeline WikiPagePane
  // uses, otherwise headings, bullets, fences and raw link markers leak.
  const body = detail
    ? replaceWikiLinkMarkers(
        detail,
        (slug) => pages.find((page) => page.slug === slug)?.title ?? null,
      )
    : "";
  const isLong = isLongMemoryBody(body);
  const clamped = isLong && !expanded;

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
      {body && (
        <div className="mt-1.5">
          <div className={cn("relative", clamped && "max-h-40 overflow-hidden")}>
            <ReadonlyContent content={body} />
            {clamped && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
            )}
          </div>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {expanded
                ? t(($) => $.wiki.memory_collapse)
                : t(($) => $.wiki.memory_expand)}
            </button>
          )}
        </div>
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

function MemoryPane({
  docs,
  pages,
}: {
  docs: ProjectDoc[];
  pages: ProjectDoc[];
}) {
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
            <MemoryCard key={doc.id} doc={doc} pages={pages} />
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
  const docsQuery = useQuery(projectDocListOptions(wsId, projectId));
  const [selected, setSelected] = useState<string>(MEMORY_NODE);
  const docs = docsQuery.data ?? [];

  const memoryDocs = docs.filter((doc) => doc.kind === "memory");
  // Wiki pages sort newest-first; the server sorts pinned-first, which is the
  // memory index's ordering, not the page list's.
  const wikiDocs = docs
    .filter((doc) => doc.kind === "wiki")
    .sort(byUpdatedAtDesc);

  // Nothing prefetches this key, so the first open of every Wiki tab starts
  // here. Falling through to the empty state instead would claim the project
  // has no knowledge before the request has even answered — and keep claiming
  // it forever when the request fails.
  if (docsQuery.isPending) {
    return (
      <div className="flex min-h-0 flex-1" data-testid="wiki-loading">
        <div className="w-56 shrink-0 space-y-2 border-r p-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-7 w-full" />
          ))}
        </div>
        <div className="min-w-0 flex-1 px-6 py-5">
          <div className="mx-auto w-full max-w-3xl space-y-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (docsQuery.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <div>
          <p className="text-sm font-medium">
            {t(($) => $.wiki.load_error_title)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {docsQuery.error instanceof Error
              ? docsQuery.error.message
              : t(($) => $.wiki.load_error_hint)}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void docsQuery.refetch()}
        >
          {t(($) => $.wiki.load_error_retry)}
        </Button>
      </div>
    );
  }

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
          <MemoryPane docs={memoryDocs} pages={wikiDocs} />
        )}
      </div>
    </div>
  );
}
