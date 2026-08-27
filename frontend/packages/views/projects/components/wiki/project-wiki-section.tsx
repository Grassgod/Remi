"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownUp,
  BookText,
  Brain,
  FileQuestion,
  Files,
  GitFork,
  PanelLeft,
  Pin,
  Search,
} from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { Sheet, SheetContent, SheetTitle } from "@multiremi/ui/components/ui/sheet";
import { projectDocListOptions } from "@multiremi/core/project-docs";
import { projectResourcesOptions } from "@multiremi/core/projects";
import { repositoryListOptions } from "@multiremi/core/repositories";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type { ProjectDoc } from "@multiremi/core/types";
import { ActorAvatar } from "../../../common/actor-avatar";
import { DocRefs } from "../../../common/doc-refs";
import { EmptyState } from "../../../common/empty-state";
import { WikiDirectoryTree, WikiPathBreadcrumb } from "../../../common/wiki-directory-tree";
import { ReadonlyContent } from "../../../editor";
import { AppLink } from "../../../navigation";
import { useT } from "../../../i18n";
import { useFormatRelativeDate } from "../labels";
import { extractWikiLinkSlugs, replaceWikiLinkMarkers } from "./wiki-links";

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
  href,
  nested = false,
  disabledTitle,
  markCurrent = true,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  href?: string;
  nested?: boolean;
  disabledTitle?: string;
  markCurrent?: boolean;
}) {
  const content = (
    <>
      {icon}
      {/* The right pane only shows the title of the page you already opened,
          so a truncated row here would be the only copy of a long agent-written
          title — `title` keeps it recoverable on hover. */}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {count !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {count || "--"}
        </span>
      )}
    </>
  );
  const className = cn(
    "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
    nested && "pl-6",
    active
      ? nested
        ? "bg-accent/40 font-medium text-foreground"
        : "bg-accent text-foreground"
      : href
        ? "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        : "cursor-default text-muted-foreground",
  );

  if (!href) {
    return (
      <div className={className} aria-disabled="true" title={disabledTitle}>
        {content}
      </div>
    );
  }

  return (
    <AppLink
      href={href}
      className={className}
      aria-current={active && markCurrent ? "page" : undefined}
    >
      {content}
    </AppLink>
  );
}

// ---------------------------------------------------------------------------
// Right pane — a wiki page
// ---------------------------------------------------------------------------

/** `[[slug]]` targets of the open page, rendered as chips below the body. */
function WikiLinkChips({
  slugs,
  pages,
}: {
  slugs: string[];
  pages: ProjectDoc[];
}) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
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
            render={
              <AppLink
                href={paths.projectWikiPage(
                  target.project_id,
                  target.slug || target.id,
                )}
              />
            }
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

function WikiPagePane({ doc, pages }: { doc: ProjectDoc; pages: ProjectDoc[] }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const updatedByType = doc.updated_by_type ?? doc.author_type;
  const updatedById = doc.updated_by_id ?? doc.author_id;
  const linkedSlugs = extractWikiLinkSlugs(doc.body);
  // Links are built from the doc's own project rather than the section's, so
  // the pane stays correct wherever a doc is rendered.
  const body = replaceWikiLinkMarkers(doc.body, (slug) => {
    const target = pages.find((page) => page.slug === slug);
    return target
      ? {
          title: target.title,
          href: paths.projectWikiPage(
            doc.project_id,
            target.slug || target.id,
          ),
        }
      : null;
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-5">
      <WikiPathBreadcrumb path={projectWikiPath(doc)} className="mb-1.5" />
      <h2 className="text-lg font-semibold">{doc.title}</h2>
      {doc.summary && (
        <p className="mt-1 text-sm text-muted-foreground">{doc.summary}</p>
      )}
      <DocRefs refs={doc.refs ?? []} className="mt-2" />
      <div className="mt-4">
        <ReadonlyContent content={body} />
      </div>
      <WikiLinkChips slugs={linkedSlugs} pages={pages} />
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

function memoryDetail(doc: ProjectDoc): string {
  return doc.body || doc.summary || "";
}

function memoryPreview(doc: ProjectDoc): string {
  return memoryDetail(doc).replace(/\s+/g, " ").trim();
}

function matchesMemoryQuery(doc: ProjectDoc, query: string): boolean {
  if (!query) return true;
  return [
    doc.title,
    doc.summary ?? "",
    doc.body,
    ...doc.tags,
    ...(doc.refs ?? []).map((ref) => ref.value),
    doc.source_issue_id ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

// Exported for the workspace-wide Knowledge page, which renders the same
// memory entries grouped by project.
export function MemoryCard({
  doc,
  pages,
}: {
  doc: ProjectDoc;
  pages: ProjectDoc[];
}) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const [expanded, setExpanded] = useState(false);
  // `memory add --summary` writes a summary with no body. A memory card has no
  // second surface to show it on, so it stands in for the missing body rather
  // than being stored and never read.
  const detail = memoryDetail(doc);
  // Memory entries come out of the same agent prompt as wiki pages: markdown
  // with `[[slug]]` cross-links. They go through the same pipeline WikiPagePane
  // uses, otherwise headings, bullets, fences and raw link markers leak.
  const body = detail
    ? replaceWikiLinkMarkers(detail, (slug) => {
        const target = pages.find((page) => page.slug === slug);
        return target
          ? {
              title: target.title,
              href: paths.projectWikiPage(
                doc.project_id,
                target.slug || target.id,
              ),
            }
          : null;
      })
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

function MemoryListItem({
  doc,
  selected,
  onSelect,
}: {
  doc: ProjectDoc;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT("projects");
  const formatRelativeDate = useFormatRelativeDate();
  const preview = memoryPreview(doc);

  return (
    <button
      type="button"
      aria-label={doc.title}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "relative flex w-full flex-col gap-1.5 border-b px-4 py-3 text-left transition-colors",
        "hover:bg-accent/50 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40",
        selected && "bg-accent",
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand" />}
      <span className="flex w-full items-start gap-2">
        <span className="min-w-0 flex-1 break-words text-sm font-medium leading-5">
          {doc.title}
        </span>
        {doc.pinned && (
          <Pin
            className="mt-0.5 size-3.5 shrink-0 text-amber-600"
            aria-label={t(($) => $.wiki.pinned_badge)}
          />
        )}
      </span>
      {preview && (
        <span className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
          {preview}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/80">
        {doc.source_issue_id && (
          <>
            <span>{doc.source_issue_id}</span>
            <span>·</span>
          </>
        )}
        <span>{formatRelativeDate(doc.updated_at)}</span>
      </span>
    </button>
  );
}

function MemoryDetailPane({
  doc,
  pages,
}: {
  doc: ProjectDoc;
  pages: ProjectDoc[];
}) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const formatRelativeDate = useFormatRelativeDate();
  const detail = memoryDetail(doc);
  const body = detail
    ? replaceWikiLinkMarkers(detail, (slug) => {
        const target = pages.find((page) => page.slug === slug);
        return target
          ? {
              title: target.title,
              href: paths.projectWikiPage(
                doc.project_id,
                target.slug || target.id,
              ),
            }
          : null;
      })
    : "";

  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-5">
      <div className="flex items-start gap-3 border-b pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Brain className="size-3.5" />
            <span>{t(($) => $.wiki.memory_node)}</span>
            {doc.author_type && doc.author_id && (
              <>
                <span>·</span>
                <ActorAvatar
                  actorType={doc.author_type}
                  actorId={doc.author_id}
                  size={16}
                />
                <ActorName actorType={doc.author_type} actorId={doc.author_id} />
              </>
            )}
            <span>·</span>
            <span>{formatRelativeDate(doc.updated_at)}</span>
          </div>
          <h2 className="mt-2 break-words text-lg font-semibold leading-6">
            {doc.title}
          </h2>
        </div>
        {doc.pinned && (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <Pin className="size-3" />
            {t(($) => $.wiki.pinned_badge)}
          </Badge>
        )}
      </div>

      {body && (
        <div className="py-5">
          <ReadonlyContent content={body} />
        </div>
      )}

      <DocRefs refs={doc.refs ?? []} className="border-t pt-4" />

      {doc.source_issue_id && (
        <div className="mt-4 flex items-center justify-between gap-3 border-y py-3 text-xs">
          <span className="text-muted-foreground">
            {t(($) => $.wiki.source_issue)}
          </span>
          <AppLink
            href={paths.issueDetail(doc.source_issue_id)}
            className="min-w-0 truncate font-medium hover:underline"
            aria-label={`${t(($) => $.wiki.source_issue)} ${doc.source_issue_id}`}
          >
            {doc.source_issue_id}
          </AppLink>
        </div>
      )}
    </article>
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
  const [search, setSearch] = useState("");
  const [onlyPinned, setOnlyPinned] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string>();
  const filteredDocs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return docs
      .filter((doc) => !onlyPinned || doc.pinned)
      .filter((doc) => matchesMemoryQuery(doc, query))
      .toSorted((a, b) => {
        const pinnedOrder = Number(b.pinned) - Number(a.pinned);
        if (pinnedOrder !== 0) return pinnedOrder;
        return newestFirst
          ? b.updated_at.localeCompare(a.updated_at)
          : a.updated_at.localeCompare(b.updated_at);
      });
  }, [docs, newestFirst, onlyPinned, search]);
  const selectedDoc =
    filteredDocs.find((doc) => doc.id === selectedMemoryId) ?? filteredDocs[0];
  const hasFilters = search.trim().length > 0 || onlyPinned;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-5 py-4">
        <h2 className="text-lg font-semibold">{t(($) => $.wiki.memory_node)}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {t(($) => $.wiki.memory_description)}
        </p>
      </div>

      {docs.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
          {t(($) => $.wiki.memory_empty)}
        </div>
      ) : (
        <>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(($) => $.wiki.memory_search_placeholder)}
                aria-label={t(($) => $.wiki.memory_search_placeholder)}
                className="h-8 pl-8 text-sm"
              />
            </div>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/70">
              {filteredDocs.length}/{docs.length}
            </span>
            <Button
              type="button"
              size="icon-sm"
              variant={onlyPinned ? "secondary" : "outline"}
              aria-label={t(($) => $.wiki.memory_filter_pinned)}
              aria-pressed={onlyPinned}
              title={t(($) => $.wiki.memory_filter_pinned)}
              onClick={() => setOnlyPinned((value) => !value)}
            >
              <Pin className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={t(($) =>
                newestFirst
                  ? $.wiki.memory_sort_oldest
                  : $.wiki.memory_sort_newest,
              )}
              title={t(($) =>
                newestFirst
                  ? $.wiki.memory_sort_oldest
                  : $.wiki.memory_sort_newest,
              )}
              onClick={() => setNewestFirst((value) => !value)}
            >
              <ArrowDownUp className="size-3.5" />
            </Button>
          </div>

          {filteredDocs.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                {t(($) => $.wiki.memory_no_results)}
              </p>
              {hasFilters && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSearch("");
                    setOnlyPinned(false);
                  }}
                >
                  {t(($) => $.wiki.memory_clear_filters)}
                </Button>
              )}
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(12rem,40%)_minmax(0,1fr)] xl:grid-cols-[minmax(13rem,42%)_minmax(0,1fr)] xl:grid-rows-1">
              <div className="min-w-0 overflow-y-auto border-b xl:border-b-0 xl:border-r">
                {filteredDocs.map((doc) => (
                  <MemoryListItem
                    key={doc.id}
                    doc={doc}
                    selected={selectedDoc?.id === doc.id}
                    onSelect={() => setSelectedMemoryId(doc.id)}
                  />
                ))}
              </div>
              <div className="min-w-0 overflow-y-auto">
                {selectedDoc && <MemoryDetailPane doc={selectedDoc} pages={pages} />}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane — a slug in the URL that resolves to nothing
// ---------------------------------------------------------------------------

// A wiki URL outlives the page it points at (renamed slug, deleted doc, typo in
// a shared link). Falling back to the memory stream would leave the reader
// believing they are looking at the page they asked for, so the dead link is
// stated and the way back offered.
function WikiNotFoundPane({ projectId }: { projectId: string }) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  return (
    <EmptyState
      icon={FileQuestion}
      title={t(($) => $.wiki.not_found_title)}
      description={t(($) => $.wiki.not_found_hint)}
      action={
        <AppLink
          href={paths.projectWiki(projectId)}
          className="mt-4 text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          {t(($) => $.wiki.not_found_back)}
        </AppLink>
      }
    />
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

export function ProjectWikiSection({
  projectId,
  selectedRef,
}: {
  projectId: string;
  selectedRef?: string;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [pageFilter, setPageFilter] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const docsQuery = useQuery(projectDocListOptions(wsId, projectId));
  const resourcesQuery = useQuery(projectResourcesOptions(wsId, projectId));
  const repositoriesQuery = useQuery(repositoryListOptions(wsId));
  const docs = docsQuery.data ?? [];
  const projectRepositoryUrls = new Set((resourcesQuery.data ?? []).flatMap((resource) => {
    if (resource.resource_type !== "github_repo") return [];
    const url = (resource.resource_ref as { url?: unknown }).url;
    return typeof url === "string" ? [canonicalRepositoryUrl(url)] : [];
  }));
  const projectRepositories = (repositoriesQuery.data?.repositories ?? []).filter((repository) =>
    projectRepositoryUrls.has(canonicalRepositoryUrl(repository.url))
  );

  const memoryDocs = docs.filter((doc) => doc.kind === "memory");
  // Wiki pages sort newest-first; the server sorts pinned-first, which is the
  // memory index's ordering, not the page list's.
  const wikiDocs = docs
    .filter((doc) => doc.kind === "wiki")
    .sort(byUpdatedAtDesc);
  const visibleWikiDocs = wikiDocs.filter((doc) => doc.slug !== "_schema");
  const treePages = useMemo(() => visibleWikiDocs.map((doc) => ({
    id: doc.id,
    path: projectWikiPath(doc),
    title: doc.title,
    searchText: `${doc.summary ?? ""}\n${doc.tags.join(" ")}`,
  })), [visibleWikiDocs]);

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
      <EmptyState
        variant="status"
        tone="destructive"
        icon={AlertCircle}
        title={t(($) => $.wiki.load_error_title)}
        description={
          docsQuery.error instanceof Error
            ? docsQuery.error.message
            : t(($) => $.wiki.load_error_hint)
        }
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void docsQuery.refetch()}
          >
            {t(($) => $.wiki.load_error_retry)}
          </Button>
        }
      />
    );
  }

  if (docs.length === 0) {
    return (
      <EmptyState
        icon={BookText}
        title={t(($) => $.wiki.empty_title)}
        description={t(($) => $.wiki.empty_hint)}
      />
    );
  }

  // The ref in the URL is resolved the way the server's getProjectDocByRef
  // resolves one — id first, then slug — so a link that opens a page through
  // the API opens the same one here. No ref at all means the memory stream.
  const selectedDoc = selectedRef
    ? (wikiDocs.find((doc) => doc.id === selectedRef) ??
      wikiDocs.find((doc) => doc.slug === selectedRef))
    : undefined;
  const sidebar = (
    <nav className="flex h-full min-h-0 w-full flex-col p-2" aria-label={t(($) => $.wiki.tab_wiki)}>
      <div className="shrink-0 space-y-0.5">
        <SidebarRow
          icon={<Brain className="h-4 w-4 shrink-0" />}
          label={t(($) => $.wiki.memory_node)}
          count={memoryDocs.length}
          active={!selectedRef}
          href={paths.projectWiki(projectId)}
        />
        {projectRepositories.length > 0 && (
          <SidebarRow
            icon={<GitFork className="h-4 w-4 shrink-0" />}
            label={t(($) => $.wiki.repository_facts)}
            count={projectRepositories.length}
            active={false}
            href={paths.repositoryWiki(projectRepositories[0]!.id)}
            markCurrent={false}
          />
        )}
        {projectRepositories.map((repository) => (
          <SidebarRow
            key={repository.id}
            icon={<GitFork className="h-4 w-4 shrink-0" />}
            label={repository.name}
            active={false}
            href={paths.repositoryWiki(repository.id)}
            nested
            markCurrent={false}
          />
        ))}
        <SidebarRow
          icon={<Files className="h-4 w-4 shrink-0" />}
          label={t(($) => $.wiki.pages_label)}
          count={visibleWikiDocs.length}
          active={Boolean(selectedRef)}
          href={visibleWikiDocs[0]
            ? paths.projectWikiPage(projectId, visibleWikiDocs[0].slug || visibleWikiDocs[0].id)
            : undefined}
          disabledTitle={t(($) => $.wiki.pages_empty)}
          markCurrent={false}
        />
      </div>
      {visibleWikiDocs.length > 0 && (
        <>
          <div className="relative my-2 shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={pageFilter}
              onChange={(event) => setPageFilter(event.target.value)}
              placeholder={t(($) => $.wiki.pages_search)}
              aria-label={t(($) => $.wiki.pages_search)}
              className="h-8 pl-8 text-sm"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WikiDirectoryTree
              pages={treePages}
              selectedId={selectedDoc?.id}
              filter={pageFilter}
              noMatches={t(($) => $.wiki.pages_no_match)}
              baseDepth={1}
              hrefFor={(page) => {
                const doc = visibleWikiDocs.find((candidate) => candidate.id === page.id)!;
                return paths.projectWikiPage(projectId, doc.slug || doc.id);
              }}
              onNavigate={() => setSidebarOpen(false)}
            />
          </div>
        </>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-[280px] shrink-0 border-r lg:block">{sidebar}</aside>
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[280px] gap-0 p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">{t(($) => $.wiki.tab_wiki)}</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center border-b px-2 lg:hidden">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarOpen(true)}
            aria-label={t(($) => $.wiki.tab_wiki)}
            title={t(($) => $.wiki.tab_wiki)}
          >
            <PanelLeft className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {selectedDoc ? (
          <div className="h-full overflow-y-auto">
            <WikiPagePane doc={selectedDoc} pages={wikiDocs} />
          </div>
        ) : selectedRef ? (
          <WikiNotFoundPane projectId={projectId} />
        ) : (
          <MemoryPane docs={memoryDocs} pages={wikiDocs} />
        )}
        </div>
      </div>
    </div>
  );
}

function canonicalRepositoryUrl(value: string): string {
  const trimmed = value.trim();
  const scp = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    return `${url.hostname}${url.pathname}`.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\.git$/i, "").replace(/\/+$/, "");
  }
}

function projectWikiPath(doc: ProjectDoc): string {
  return doc.path || `${doc.slug || doc.id}.md`;
}
