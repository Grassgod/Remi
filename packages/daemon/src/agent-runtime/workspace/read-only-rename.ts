import { chmodSync, lstatSync, renameSync } from "node:fs";

/**
 * Rename a directory whose own mode may deny writing, and leave it with that
 * mode at whichever path it ends up at.
 *
 * Renaming a directory rewrites its `..` entry. Linux asks for write access to
 * the directory only when the parent changes; macOS asks for it on every
 * directory rename, so a published read-only (0555) tree fails there with
 * EACCES even inside one parent. Owner write is granted for the rename alone:
 * the directory's contents keep their protection throughout, and its own mode
 * is put back at the new path, or at the old one when the rename fails.
 *
 * A crash between the rename and the final chmod leaves only the root
 * writable. Callers that publish this way must re-apply protection before they
 * hand a tree out again (code snapshot reuse) or rebuild it (intake views).
 *
 * Symlinks and owner-writable directories are renamed as they are, so this
 * never changes the mode of a link's target.
 */
export function renameReadOnlyDirectory(source: string, target: string): void {
  const info = lstatSync(source);
  const mode = info.mode & 0o7777;
  if (!info.isDirectory() || (mode & 0o200) !== 0) {
    renameSync(source, target);
    return;
  }
  chmodSync(source, mode | 0o200);
  try {
    renameSync(source, target);
  } catch (error) {
    try {
      chmodSync(source, mode);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `rename of ${source} and restoration of its mode failed`);
    }
    throw error;
  }
  chmodSync(target, mode);
}
