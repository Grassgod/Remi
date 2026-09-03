"use client";

import type { ReactNode } from "react";
import { CornerDownLeft, Link2 } from "lucide-react";
import {
  resolveProjectWikiRef,
  resolveRepositoryWikiRef,
  tokenizeWikiLinks,
  type ProjectWikiRefResolution,
  type RepositoryWikiRefResolution,
  type WikiLinkToken,
  normalizeWikiHeadingAnchor,
} from "@multiremi/core/knowledge";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { ReadonlyContent } from "../editor";
import { useT } from "../i18n";
import { AppLink } from "../navigation";

export interface WikiLinkDocument {
  id: string;
  slug: string;
  path: string;
  title: string;
  body: string;
}

export type WikiDocumentScope =
  | { kind: "project"; projectId: string }
  | { kind: "repository"; repositoryId: string };

type WikiResolution =
  | ProjectWikiRefResolution<WikiLinkDocument>
  | RepositoryWikiRefResolution<WikiLinkDocument>;

interface ResolvedWikiLink {
  token: WikiLinkToken;
  resolution: WikiResolution;
}

interface UnresolvedWikiLink {
  key: string;
  label: string;
  status: "missing" | "ambiguous";
}

export function WikiDocumentContent({
  doc,
  pages,
  scope,
  backlinks: suppliedBacklinks,
  backlinksPending = false,
}: {
  doc: WikiLinkDocument;
  pages: readonly WikiLinkDocument[];
  scope: WikiDocumentScope;
  /** Supply lazy server backlinks when `pages` contains metadata only. */
  backlinks?: readonly WikiLinkDocument[];
  backlinksPending?: boolean;
}) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const links = resolveDocumentLinks(doc, pages, scope);
  const content = replaceDocumentLinks(doc.body, links, (target) => (
    scope.kind === "project"
      ? paths.projectWikiPage(scope.projectId, target.slug || target.id)
      : paths.repositoryWikiPage(scope.repositoryId, target.path)
  ), (status) => status === "ambiguous"
    ? t(($) => $.wiki.link_ambiguous)
    : t(($) => $.wiki.link_missing));
  const outgoing = uniqueDocuments(links.flatMap(({ token, resolution }) => (
    token.ref !== null && resolution.status === "resolved" && resolution.document.id !== doc.id
      ? [resolution.document]
      : []
  )));
  const unresolved = uniqueUnresolvedLinks(links.flatMap(({ token, resolution }) => (
    token.ref !== null && resolution.status !== "resolved"
      ? [{
        key: `${resolution.status}:${token.ref}`,
        label: token.label || token.ref,
        status: resolution.status,
      }]
      : []
  )));
  const localBacklinks = uniqueDocuments(pages.flatMap((candidate) => {
    if (candidate.id === doc.id) return [];
    const linksToCurrent = resolveDocumentLinks(candidate, pages, scope).some(({ token, resolution }) => (
      token.ref !== null && resolution.status === "resolved" && resolution.document.id === doc.id
    ));
    return linksToCurrent ? [candidate] : [];
  }));
  const backlinks = suppliedBacklinks === undefined
    ? localBacklinks
    : uniqueDocuments([...suppliedBacklinks]);

  const hrefFor = (target: WikiLinkDocument) => scope.kind === "project"
    ? paths.projectWikiPage(scope.projectId, target.slug || target.id)
    : paths.repositoryWikiPage(scope.repositoryId, target.path);

  return (
    <>
      <ReadonlyContent content={content} headingAnchors />
      <WikiRelations
        outgoing={outgoing}
        unresolved={unresolved}
        backlinks={backlinks}
        backlinksPending={backlinksPending}
        hrefFor={hrefFor}
      />
    </>
  );
}

function WikiRelations({
  outgoing,
  unresolved,
  backlinks,
  backlinksPending,
  hrefFor,
}: {
  outgoing: readonly WikiLinkDocument[];
  unresolved: readonly UnresolvedWikiLink[];
  backlinks: readonly WikiLinkDocument[];
  backlinksPending: boolean;
  hrefFor: (target: WikiLinkDocument) => string;
}) {
  const { t } = useT("projects");
  return (
    <section className="mt-6 space-y-2 border-t pt-4 text-xs" aria-label={t(($) => $.wiki.relations_label)}>
      <RelationRow
        icon={<Link2 className="size-3.5" />}
        label={t(($) => $.wiki.links_label)}
        documents={outgoing}
        unresolved={unresolved}
        hrefFor={hrefFor}
      />
      <RelationRow
        icon={<CornerDownLeft className="size-3.5" />}
        label={t(($) => $.wiki.backlinks_label)}
        documents={backlinks}
        pending={backlinksPending}
        hrefFor={hrefFor}
      />
    </section>
  );
}

function RelationRow({
  icon,
  label,
  documents,
  unresolved = [],
  pending = false,
  hrefFor,
}: {
  icon: ReactNode;
  label: string;
  documents: readonly WikiLinkDocument[];
  unresolved?: readonly UnresolvedWikiLink[];
  pending?: boolean;
  hrefFor: (target: WikiLinkDocument) => string;
}) {
  const { t } = useT("projects");
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      role="group"
      aria-label={label}
      aria-busy={pending || undefined}
    >
      <span className="flex w-20 shrink-0 items-center gap-1 text-muted-foreground">
        {icon}
        {label}
      </span>
      {documents.map((document) => (
        <Badge
          key={document.id}
          variant="secondary"
          className="max-w-64 cursor-pointer font-normal hover:bg-accent"
          render={<AppLink href={hrefFor(document)} title={document.title} />}
        >
          <span className="truncate">{document.title}</span>
        </Badge>
      ))}
      {unresolved.map((link) => (
        <Badge
          key={link.key}
          variant="outline"
          className="max-w-64 font-normal text-muted-foreground"
          title={link.status === "ambiguous"
            ? t(($) => $.wiki.link_ambiguous)
            : t(($) => $.wiki.link_missing)}
        >
          <span className="truncate">{link.label}</span>
        </Badge>
      ))}
      {pending && documents.length === 0 ? (
        <span className="inline-block h-4 w-20 animate-pulse rounded bg-muted" />
      ) : documents.length === 0 && unresolved.length === 0 ? (
        <span className="text-muted-foreground">{t(($) => $.wiki.links_empty)}</span>
      ) : null}
    </div>
  );
}

function resolveDocumentLinks(
  source: WikiLinkDocument,
  pages: readonly WikiLinkDocument[],
  scope: WikiDocumentScope,
): ResolvedWikiLink[] {
  return tokenizeWikiLinks(source.body).map((token) => ({
    token,
    resolution: scope.kind === "project"
      ? resolveProjectWikiRef(token.ref, source.path, pages)
      : resolveRepositoryWikiRef(token.ref, source.path, pages),
  }));
}

function replaceDocumentLinks(
  markdown: string,
  links: readonly ResolvedWikiLink[],
  hrefFor: (target: WikiLinkDocument) => string,
  unresolvedTitle: (status: "missing" | "ambiguous") => string,
): string {
  if (links.length === 0) return markdown;
  let cursor = 0;
  let rendered = "";
  for (const { token, resolution } of links) {
    rendered += markdown.slice(cursor, token.start);
    if (token.ref === null && token.anchor) {
      rendered += markdownLink(
        token.label || token.anchor,
        `#${encodeURIComponent(normalizeWikiHeadingAnchor(token.anchor))}`,
      );
    } else if (resolution.status === "resolved") {
      const anchor = token.anchor ? normalizeWikiHeadingAnchor(token.anchor) : "";
      const href = `${hrefFor(resolution.document)}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
      rendered += markdownLink(token.label || resolution.document.title, href);
    } else {
      rendered += titledInlineCode(
        token.label || token.ref || token.anchor || token.raw,
        unresolvedTitle(resolution.status),
      );
    }
    cursor = token.end;
  }
  return rendered + markdown.slice(cursor);
}

function markdownLink(label: string, href: string): string {
  return `[${label.replace(/[\\[\]]/g, (character) => `\\${character}`)}](${href})`;
}

function titledInlineCode(value: string, title: string): string {
  return `<code title="${escapeHtml(title)}">${escapeHtml(value)}</code>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function uniqueDocuments(documents: WikiLinkDocument[]): WikiLinkDocument[] {
  const seen = new Set<string>();
  return documents.filter((document) => {
    if (seen.has(document.id)) return false;
    seen.add(document.id);
    return true;
  });
}

function uniqueUnresolvedLinks(links: UnresolvedWikiLink[]): UnresolvedWikiLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.key)) return false;
    seen.add(link.key);
    return true;
  });
}
