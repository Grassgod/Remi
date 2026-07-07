/**
 * Wikilink parser + bidirectional link graph (Obsidian-style).
 *
 * Parses `[[target]]` and `[[target|alias]]` syntax from entity markdown,
 * resolves aliases against the entity index, and maintains both forward
 * and backward indices for O(1) lookups.
 *
 * Rebuilt whenever the MemoryStore index is rebuilt (at startup and
 * after entity writes).
 */

import { basename } from "node:path";
import { readFileSync } from "node:fs";

export interface WikiLink {
  /** Canonical entity name after alias resolution; null if unresolved. */
  target: string | null;
  /** Raw target text as written in `[[X]]` or `[[X|Y]]`. */
  raw: string;
  /** Display text (alias side of `[[X|Y]]`, or raw target). */
  displayText: string;
}

export interface Backlink {
  /** Entity name of the file that contains the wikilink (source). */
  source: string;
  /** Path to the source file. */
  sourcePath: string;
  /** ~80-char text snippet around the wikilink. */
  snippet: string;
}

/** Regex matching `[[target]]` or `[[target|alias]]`. Captures target and alias. */
const WIKILINK_RE = /\[\[([^\]|[\n]+)(?:\|([^\]\n]+))?\]\]/g;

/**
 * Parse all wikilinks from a text blob. Does NOT resolve aliases.
 */
export function parseWikilinks(text: string): Array<{ raw: string; rawTarget: string; displayText: string; index: number }> {
  const result: Array<{ raw: string; rawTarget: string; displayText: string; index: number }> = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const rawTarget = m[1]!.trim();
    const displayText = (m[2] ?? m[1]!).trim();
    result.push({ raw: m[0], rawTarget, displayText, index: m.index });
  }
  return result;
}

/**
 * Extract a ~80-char snippet of context around a character offset in text.
 * Collapses whitespace, trims newlines, strips leading/trailing list markers.
 */
export function extractSnippet(text: string, index: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  // Ellipsis indicators
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

export interface LinkResolver {
  /** Given a raw wikilink target, return the canonical entity name, or null if unknown. */
  resolve(rawTarget: string): string | null;
}

export class LinkGraph {
  /** entityName → set of outgoing target entity names. */
  private outgoing = new Map<string, Set<string>>();
  /** entityName → array of backlinks (source entities with context). */
  private incoming = new Map<string, Backlink[]>();

  constructor(private resolver: LinkResolver) {}

  /**
   * Clear and rebuild from a list of entity files.
   * Each file: { entityName, path, content }.
   */
  rebuild(files: Array<{ entityName: string; path: string; content: string }>): void {
    this.outgoing.clear();
    this.incoming.clear();

    for (const file of files) {
      const links = parseWikilinks(file.content);
      const outSet = new Set<string>();
      for (const link of links) {
        const target = this.resolver.resolve(link.rawTarget);
        if (!target) continue;           // unresolved = broken link, skip
        if (target === file.entityName) continue; // ignore self-links
        outSet.add(target);
        const snippet = extractSnippet(file.content, link.index);
        const backs = this.incoming.get(target) ?? [];
        backs.push({ source: file.entityName, sourcePath: file.path, snippet });
        this.incoming.set(target, backs);
      }
      if (outSet.size > 0) this.outgoing.set(file.entityName, outSet);
    }
  }

  getBacklinks(entityName: string): Backlink[] {
    return this.incoming.get(entityName) ?? [];
  }

  getForwardLinks(entityName: string): string[] {
    return [...(this.outgoing.get(entityName) ?? [])];
  }

  /** All entities that have at least one incoming link. */
  allLinkedEntities(): string[] {
    return [...this.incoming.keys()];
  }
}

/**
 * Helper: load a file's text content safely, returning empty string on failure.
 */
export function safeReadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/** Extract entity name from a markdown file path (e.g., Alice-Chen.md → Alice-Chen). */
export function entityNameFromPath(path: string): string {
  return basename(path, ".md");
}
