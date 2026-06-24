/**
 * Skills sync: keep each tool's skills dir as a symlink (fallback copy) to the
 * SSOT directory at ~/.cc-switch/skills/<directory>/. Mirrors cc-switch
 * desktop's mechanism (skill.rs sync_to_app_dir).
 *
 * Safety: we ONLY remove a target that's either nonexistent, a symlink, or
 * dangling. Never delete a real user directory of the same name — that would
 * destroy data we don't own.
 */

import {
  existsSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  cpSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export type LinkResult = "symlink" | "copy" | "noop";

export function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export function symlinkTarget(target: string): string | null {
  if (!isSymlink(target)) return null;
  try {
    return resolve(dirname(target), readlinkSync(target));
  } catch {
    return null;
  }
}

/** Remove a target dir, but only if we know it's safe (symlink, dangling, or nonexistent). */
export function safeUnlink(target: string): void {
  if (isSymlink(target)) {
    unlinkSync(target);
    return;
  }
  // Dangling symlink: lstat works, isSymbolicLink true above. Already handled.
  // Real directory: refuse — caller chose to wipe a real dir explicitly via wipeDir.
}

/** Wipe a directory (real or symlink). Use only when caller knows it's hub-owned. */
export function wipeDir(target: string): void {
  if (!existsSync(target) && !isSymlink(target)) return;
  if (isSymlink(target)) unlinkSync(target);
  else rmSync(target, { recursive: true, force: true });
}

/**
 * Ensure `dest` links/copies `source`. Idempotent: if dest already symlinks to
 * source, no-op. If dest is a real directory NOT owned by hub, throws.
 */
export function ensureSkillLink(source: string, dest: string): LinkResult {
  if (!existsSync(source)) throw new Error(`skill source missing: ${source}`);

  const current = symlinkTarget(dest);
  if (current && resolve(current) === resolve(source)) return "noop"; // already linked

  if (isSymlink(dest)) {
    unlinkSync(dest); // stale link
  } else if (existsSync(dest)) {
    // Real directory in the way — refuse rather than nuke user data.
    throw new Error(`refusing to overwrite existing real directory: ${dest}`);
  }

  mkdirSync(dirname(dest), { recursive: true });
  try {
    symlinkSync(source, dest);
    return "symlink";
  } catch {
    cpSync(source, dest, { recursive: true });
    return "copy";
  }
}

/** Remove a hub-managed link/copy at `dest`. Real foreign dirs are left alone. */
export function removeSkillLink(dest: string, ssotRoot: string): void {
  if (!existsSync(dest) && !isSymlink(dest)) return;
  if (isSymlink(dest)) {
    const tgt = symlinkTarget(dest);
    if (!tgt || tgt.startsWith(resolve(ssotRoot))) unlinkSync(dest);
    return;
  }
  // Real dir: leave it (we never wipe foreign directories on disable).
}

/** Deterministic hash of a directory's contents (sorted) — used for content_hash. */
export function hashDirectory(dir: string): string {
  const h = createHash("sha256");
  function walk(p: string): void {
    const entries = readdirSync(p).sort();
    for (const name of entries) {
      const full = join(p, name);
      const st = statSync(full);
      h.update(name);
      if (st.isDirectory()) walk(full);
      else h.update(readFileSync(full));
    }
  }
  walk(dir);
  return h.digest("hex");
}
