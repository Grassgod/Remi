/**
 * Pure 3-way reconciliation for MCP entries in one (tool, scope) file.
 *
 *   base   = manifest hub wrote last sync   (what we last owned)
 *   ours   = entries currently in the DB    (hub's intent)
 *   theirs = entries currently in the file  (reality, incl. user/tool edits)
 *
 * No I/O — fully unit-testable. See ReconcileResult for the decision table.
 */

import type { EntryMap, Manifest, McpConfig, ReconcileResult } from "./types.js";

/** Deterministic JSON (sorted keys) — used as the manifest hash so equality is exact. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
      .join(",") +
    "}"
  );
}

export function hashConfig(cfg: McpConfig): string {
  return canonical(cfg);
}

export function reconcileMcp(ours: EntryMap, theirs: EntryMap, base: Manifest): ReconcileResult {
  const toFile: EntryMap = {};
  const imports: EntryMap = {};
  const disables: string[] = [];
  const conflicts: string[] = [];
  const nextManifest: Manifest = {};

  const names = new Set<string>([
    ...Object.keys(ours),
    ...Object.keys(theirs),
    ...Object.keys(base),
  ]);

  for (const name of names) {
    const inO = name in ours;
    const inT = name in theirs;
    const inB = name in base;
    const ho = inO ? hashConfig(ours[name]) : undefined;
    const ht = inT ? hashConfig(theirs[name]) : undefined;
    const hb = inB ? base[name] : undefined;

    if (inO && inT) {
      const oursChanged = ho !== hb;
      const theirsChanged = ht !== hb;

      if (!theirsChanged) {
        // file untouched (or matches base) → DB is authoritative
        toFile[name] = ours[name];
        nextManifest[name] = ho!;
      } else if (!oursChanged) {
        // only the file changed → file wins, import back into DB
        toFile[name] = theirs[name];
        imports[name] = theirs[name];
        nextManifest[name] = ht!;
      } else if (ho === ht) {
        // both changed to the same value → consistent, no conflict
        toFile[name] = ours[name];
        nextManifest[name] = ho!;
      } else {
        // both diverged → real conflict, leave the file as-is, keep flagged
        toFile[name] = theirs[name];
        conflicts.push(name);
        nextManifest[name] = hb ?? ht!;
      }
    } else if (inO && !inT) {
      if (inB) {
        // hub wrote it before, now gone from file → user removed it → honor
        disables.push(name);
      } else {
        // new in DB → create in file
        toFile[name] = ours[name];
        nextManifest[name] = ho!;
      }
    } else if (!inO && inT) {
      if (inB) {
        // hub wrote it before, DB row deleted → propagate delete (omit from file)
      } else {
        // user/tool added it → import into DB, keep in file
        toFile[name] = theirs[name];
        imports[name] = theirs[name];
        nextManifest[name] = ht!;
      }
    }
    // !inO && !inT → vanished from both; drop from manifest (do nothing)
  }

  return { toFile, imports, disables, conflicts, nextManifest };
}
