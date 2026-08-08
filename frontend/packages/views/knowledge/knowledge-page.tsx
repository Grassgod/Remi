"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, BookText, FileText, Library, Search } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { workspaceDocListOptions } from "@multiremi/core/project-docs";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import type { WorkspaceDoc } from "@multiremi/core/types";
import { AppLink } from "../navigation";
import { EmptyState } from "../common/empty-state";
import { PageHeader } from "../layout/page-header";
import { MemoryCard } from "../projects/components/wiki/project-wiki-section";
import { useT } from "../i18n";

interface ProjectGroup {
  projectId: string;
  projectTitle: string;
  wikiDocs: WorkspaceDoc[];
  memoryDocs: WorkspaceDoc[];
}

// The same fields the server searches, so typing into the box narrows the
// list the way `--query` narrows it on the CLI.
function matchesQuery(doc: WorkspaceDoc, query: string): boolean {
  return (
    doc.title.toLowerCase().includes(query) ||
    (doc.summary ?? "").toLowerCase().includes(query) ||
    doc.body.toLowerCase().includes(query) ||
    doc.tags.some((tag) => tag.toLowerCase().includes(query))
  );
}

// ---------------------------------------------------------------------------
// Chrome — kept around every state so the page never loses its header
// ---------------------------------------------------------------------------

function KnowledgeShell({ children }: { children: ReactNode }) {
  const { t } = useT("projects");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="px-5">
        <div className="flex items-center gap-2">
          <Library className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">{t(($) => $.knowledge.title)}</h1>
          <p className="ml-2 hidden text-xs text-muted-foreground md:block">
            {t(($) => $.knowledge.description)}
          </p>
        </div>
      </PageHeader>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One project's slice of the workspace knowledge base
// ---------------------------------------------------------------------------

function ProjectSection({
  group,
  pages,
}: {
  group: ProjectGroup;
  pages: WorkspaceDoc[];
}) {
  const paths = useWorkspacePaths();
  return (
    <section>
      <AppLink
        href={paths.projectWiki(group.projectId)}
        className="text-sm font-semibold hover:underline"
      >
        {group.projectTitle}
      </AppLink>
      {group.wikiDocs.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {group.wikiDocs.map((doc) => (
            <AppLink
              key={doc.id}
              href={paths.projectWikiPage(doc.project_id, doc.slug || doc.id)}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <FileText className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">
                  {doc.title}
                </span>
                {doc.summary && (
                  <span className="block truncate text-xs">{doc.summary}</span>
                )}
              </span>
            </AppLink>
          ))}
        </div>
      )}
      {group.memoryDocs.length > 0 && (
        <div className="mt-2 space-y-2">
          {group.memoryDocs.map((doc) => (
            <MemoryCard key={doc.id} doc={doc} pages={pages} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function KnowledgePage() {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const docsQuery = useQuery(workspaceDocListOptions(wsId));
  const [search, setSearch] = useState("");
  const docs = useMemo(() => docsQuery.data ?? [], [docsQuery.data]);

  // Link resolution reads a project's whole page list, not the filtered one:
  // a search term must not turn a resolvable [[slug]] into a dead code span.
  const pagesByProject = useMemo(() => {
    const map = new Map<string, WorkspaceDoc[]>();
    for (const doc of docs) {
      if (doc.kind !== "wiki") continue;
      const pages = map.get(doc.project_id);
      if (pages) pages.push(doc);
      else map.set(doc.project_id, [doc]);
    }
    return map;
  }, [docs]);

  // Map insertion order carries the response order through — the server sorts
  // newest-first across the whole workspace, so the project that was touched
  // last leads the page.
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const byProject = new Map<string, ProjectGroup>();
    for (const doc of docs) {
      // An unrecognized kind has no row shape here; the Wiki tab drops it the
      // same way rather than guessing.
      if (doc.kind !== "wiki" && doc.kind !== "memory") continue;
      if (query && !matchesQuery(doc, query)) continue;
      let group = byProject.get(doc.project_id);
      if (!group) {
        group = {
          projectId: doc.project_id,
          projectTitle: doc.project_title,
          wikiDocs: [],
          memoryDocs: [],
        };
        byProject.set(doc.project_id, group);
      }
      if (doc.kind === "memory") group.memoryDocs.push(doc);
      else group.wikiDocs.push(doc);
    }
    return [...byProject.values()];
  }, [docs, search]);

  // Nothing prefetches this key, so every open of the Knowledge page starts
  // here. Falling through to the empty state instead would claim the
  // workspace has no knowledge before the request has even answered.
  if (docsQuery.isPending) {
    return (
      <KnowledgeShell>
        <div
          className="mx-auto w-full max-w-3xl space-y-3 px-6 py-5"
          data-testid="knowledge-loading"
        >
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </KnowledgeShell>
    );
  }

  if (docsQuery.isError) {
    return (
      <KnowledgeShell>
        <EmptyState
          variant="status"
          tone="destructive"
          icon={AlertCircle}
          title={t(($) => $.knowledge.load_error_title)}
          description={
            docsQuery.error instanceof Error
              ? docsQuery.error.message
              : t(($) => $.knowledge.load_error_hint)
          }
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void docsQuery.refetch()}
            >
              {t(($) => $.knowledge.load_error_retry)}
            </Button>
          }
        />
      </KnowledgeShell>
    );
  }

  if (docs.length === 0) {
    return (
      <KnowledgeShell>
        <EmptyState
          icon={BookText}
          title={t(($) => $.knowledge.empty_title)}
          description={t(($) => $.knowledge.empty_hint)}
        />
      </KnowledgeShell>
    );
  }

  return (
    <KnowledgeShell>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 py-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t(($) => $.knowledge.search_placeholder)}
              className="h-8 w-full pl-8 text-sm sm:w-64"
            />
          </div>
          {groups.length === 0 ? (
            <p className="mt-8 text-center text-sm text-muted-foreground">
              {t(($) => $.knowledge.no_results)}
            </p>
          ) : (
            <div className="mt-5 space-y-8">
              {groups.map((group) => (
                <ProjectSection
                  key={group.projectId}
                  group={group}
                  pages={pagesByProject.get(group.projectId) ?? []}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </KnowledgeShell>
  );
}
