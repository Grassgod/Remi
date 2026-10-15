/**
 * Line diff for `FileChange` (turn + items traces, PR 2): the daemon translator
 * turns an ACP `diff` content block (`oldText` / `newText`) into the unified body
 * readers render, plus the `+N -M` counts.
 *
 * Kept out of `turn-trace.ts` on purpose: only the daemon computes diffs, so the
 * `diff` dependency never reaches the web bundle.
 */

import { structuredPatch } from "diff";
import type { FileChange } from "@multiremi/contracts/trace";
import { capFileChanges } from "./trace-sanitize.js";

/** Context lines around each change, as `git diff` shows them. */
export const FILE_CHANGE_CONTEXT_LINES = 3;
/**
 * Bounds for one line diff (Myers is O((N+M)·D)): a larger edit distance, a
 * slower diff or a larger input is reported without a body.
 */
export const FILE_CHANGE_MAX_EDIT_LENGTH = 10_000;
export const FILE_CHANGE_DIFF_TIMEOUT_MS = 500;
/** old + new, in UTF-16 units. Pure additions and deletions are never diffed. */
export const FILE_CHANGE_MAX_INPUT_LENGTH = 1024 * 1024;

export interface FileChangeOptions {
  /** Overrides the kind inferred from the texts (Codex sends `_meta.kind`). */
  kind?: FileChange["kind"];
  movePath?: string | null;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Build a `FileChange` from the old and new text of one file or snippet.
 *
 * - `kind`: `add` when `oldText` is null, `delete` when `newText` is null,
 *   otherwise `update`, unless `options.kind` says otherwise.
 * - `diff`: hunks of " " / "+" / "-" lines, each hunk introduced by a bare "@@"
 *   line. There are no line numbers because Claude sends snippets, not files;
 *   "\ No newline at end of file" markers are dropped.
 * - `added` / `removed`: "+" / "-" line counts of the whole diff, also when the
 *   body is capped (64 KiB per change). When the diff is not computed (over the
 *   bounds above) the body is null and the counts are the two texts' line counts.
 */
export function fileChangeFromTexts(
  path: string,
  oldText: string | null,
  newText: string | null,
  options: FileChangeOptions = {},
): FileChange {
  const kind = options.kind ?? (oldText === null ? "add" : newText === null ? "delete" : "update");
  const before = oldText ?? "";
  const after = newText ?? "";
  const base = { path, kind, move_path: options.movePath ?? null };
  if (before === after) return { ...base, diff: null, added: 0, removed: 0 };
  // A new or emptied file is one hunk of additions or deletions.
  if (before === "" || after === "") {
    const added = splitLines(after).map((line) => `+${line}`);
    const removed = splitLines(before).map((line) => `-${line}`);
    const change: FileChange = { ...base, diff: ["@@", ...removed, ...added].join("\n"), added: added.length, removed: removed.length };
    return capFileChanges([change]).value[0]!;
  }

  const patch = before.length + after.length > FILE_CHANGE_MAX_INPUT_LENGTH
    ? undefined
    : structuredPatch(path, path, before, after, undefined, undefined, {
      context: FILE_CHANGE_CONTEXT_LINES,
      maxEditLength: FILE_CHANGE_MAX_EDIT_LENGTH,
      timeout: FILE_CHANGE_DIFF_TIMEOUT_MS,
    });
  if (!patch) {
    return { ...base, diff: null, added: splitLines(after).length, removed: splitLines(before).length, diff_truncated: true };
  }

  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    lines.push("@@");
    for (const line of hunk.lines) {
      const marker = line[0];
      if (marker === "+") added++;
      else if (marker === "-") removed++;
      else if (marker !== " ") continue;
      lines.push(line);
    }
  }
  const change: FileChange = { ...base, diff: lines.length ? lines.join("\n") : null, added, removed };
  return capFileChanges([change]).value[0]!;
}
