"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { AppLink } from "../navigation";

export interface WikiTreePage {
  id: string;
  path: string;
  title: string;
  searchText?: string;
}

interface WikiTreeFolder {
  kind: "folder";
  name: string;
  path: string;
  children: WikiTreeNode[];
}

interface WikiTreeLeaf {
  kind: "page";
  name: string;
  path: string;
  page: WikiTreePage;
}

type WikiTreeNode = WikiTreeFolder | WikiTreeLeaf;

export function WikiDirectoryTree({
  pages,
  selectedId,
  hrefFor,
  filter = "",
  noMatches,
  baseDepth = 0,
  onNavigate,
}: {
  pages: readonly WikiTreePage[];
  selectedId?: string;
  hrefFor: (page: WikiTreePage) => string;
  filter?: string;
  noMatches: string;
  baseDepth?: number;
  onNavigate?: () => void;
}) {
  const tree = useMemo(() => buildWikiTree(pages), [pages]);
  const selected = pages.find((page) => page.id === selectedId);
  const selectedFolders = useMemo(() => ancestorPaths(selected?.path ?? ""), [selected?.path]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selectedFolders));

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const path of selectedFolders) next.add(path);
      return next;
    });
  }, [selectedFolders]);

  const query = filter.trim().toLowerCase();
  if (query) {
    const matches = pages.filter((page) =>
      `${page.title}\n${page.path}\n${page.searchText ?? ""}`.toLowerCase().includes(query)
    );
    if (!matches.length) return <p className="p-2 text-xs text-muted-foreground">{noMatches}</p>;
    return (
      <div role="list" aria-label="Wiki search results">
        {matches.map((page) => (
          <div key={page.id} role="listitem">
            <AppLink
              href={hrefFor(page)}
              onClick={onNavigate}
              aria-current={selectedId === page.id ? "page" : undefined}
              className={cn(
                "flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                selectedId === page.id
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <FileText className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate" title={page.title}>{displayWikiTitle(page)}</span>
                <span className="block truncate text-xs font-normal text-muted-foreground" title={parentWikiPath(page.path)}>
                  {parentWikiPath(page.path) || "/"}
                </span>
              </span>
            </AppLink>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div role="tree" aria-label="Wiki pages">
      {tree.map((node) => (
        <WikiTreeNodeRow
          key={`${node.kind}:${node.path}`}
          node={node}
          depth={baseDepth}
          selectedId={selectedId}
          selectedFolders={selectedFolders}
          expanded={expanded}
          hrefFor={hrefFor}
          onNavigate={onNavigate}
          onToggle={(path) => setExpanded((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          })}
        />
      ))}
    </div>
  );
}

function WikiTreeNodeRow({
  node,
  depth,
  selectedId,
  selectedFolders,
  expanded,
  hrefFor,
  onNavigate,
  onToggle,
}: {
  node: WikiTreeNode;
  depth: number;
  selectedId?: string;
  selectedFolders: readonly string[];
  expanded: ReadonlySet<string>;
  hrefFor: (page: WikiTreePage) => string;
  onNavigate?: () => void;
  onToggle: (path: string) => void;
}) {
  if (node.kind === "page") {
    const active = selectedId === node.page.id;
    return (
      <div role="treeitem">
        <AppLink
          href={hrefFor(node.page)}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex h-8 min-w-0 items-center gap-2 rounded-md pr-2 text-sm",
            active
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
          style={{ paddingLeft: `${8 + depth * 16 + 16}px` }}
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate" title={node.page.title}>{displayWikiTitle(node.page)}</span>
        </AppLink>
      </div>
    );
  }

  const singlePage = node.children.length === 1 && node.children[0]?.kind === "page";
  const open = singlePage || expanded.has(node.path);
  const activePath = selectedFolders.includes(node.path);
  const FolderIcon = open ? FolderOpen : Folder;
  const row = (
    <>
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", singlePage && "invisible")} />
      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate" title={node.name}>{node.name}</span>
    </>
  );

  return (
    <div role="treeitem" aria-expanded={open}>
      {singlePage ? (
        <div
          className={cn("flex h-8 min-w-0 items-center gap-1.5 pr-2 text-sm text-muted-foreground", activePath && "font-medium text-foreground")}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          {row}
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(node.path)}
          className={cn(
            "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            activePath && "font-medium text-foreground",
          )}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          {row}
        </button>
      )}
      {open && (
        <div role="group">
          {node.children.map((child) => (
            <WikiTreeNodeRow
              key={`${child.kind}:${child.path}`}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              selectedFolders={selectedFolders}
              expanded={expanded}
              hrefFor={hrefFor}
              onNavigate={onNavigate}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WikiPathBreadcrumb({ path, className }: { path: string; className?: string }) {
  const segments = path.split("/").filter(Boolean);
  return (
    <nav aria-label="Wiki path" className={cn("flex min-w-0 flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground", className)}>
      {segments.map((segment, index) => (
        <span key={`${segment}:${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 && <ChevronRight className="size-3 shrink-0" />}
          <span className={cn("truncate", index === segments.length - 1 && "text-foreground/70")} title={segment}>
            {segment}
          </span>
        </span>
      ))}
    </nav>
  );
}

export function buildWikiTree(pages: readonly WikiTreePage[]): WikiTreeNode[] {
  const root: WikiTreeNode[] = [];
  for (const page of pages) {
    const parts = page.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let children = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join("/");
      let folder = children.find((node): node is WikiTreeFolder => node.kind === "folder" && node.path === path);
      if (!folder) {
        folder = { kind: "folder", name: parts[index]!, path, children: [] };
        children.push(folder);
      }
      children = folder.children;
    }
    children.push({ kind: "page", name: parts.at(-1)!, path: page.path, page });
  }
  const sort = (nodes: WikiTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
    for (const node of nodes) if (node.kind === "folder") sort(node.children);
  };
  sort(root);
  return root;
}

export function displayWikiTitle(page: Pick<WikiTreePage, "path" | "title">): string {
  const folders = page.path.split("/").slice(0, -1);
  const labels = folders.map((part) => part.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const prefixes = [...new Set([[...labels].join(" "), ...labels].filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remainder = page.title.replace(new RegExp(`^${escaped}(?:\\s*[-:/]\\s*|\\s+)`, "i"), "").trim();
    if (remainder !== page.title && remainder) return remainder;
  }
  return page.title;
}

function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function parentWikiPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}
