/**
 * Clean the `env/<subject>/` tree down to what cannot be rebuilt (ADR 0018, section 4).
 *
 * A lane generation keeps only the provider's native session history; the
 * rest of its home, the discussion work set and the plugin runtime are rebuilt
 * by the next execution. Every directory is removed through the anchored
 * removal; plain files and links are unlinked inside the owned root.
 *
 * Nothing here looks for repositories, which an agent may have left anywhere in
 * the generation: in its `work/` directory, but also in the provider home or
 * the plugin runtime. The caller inspects the whole generation first
 * (`repo-inspection.ts`, apart from the history this keeps and the provider's
 * own state, which was never the agent's work) and keeps the generation when
 * that finds work which cannot be saved.
 */

import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StorageSubjectRef } from "@multiremi/contracts/storage.js";
import { envDirectory, TASK_TMP_DIRECTORY } from "./layout.js";
import { removeOwnedDirectory } from "./safe-remove.js";

/** Native session history, kept in place so provider paths never change. */
const HISTORY_ENTRIES: ReadonlySet<string> = new Set(["projects", "sessions", "session_index.jsonl"]);
/**
 * What a provider keeps in its home for itself: temp and cache directories, installed and vendored plugins
 * and skills. The provider rebuilds all of it. Codex, for one, clones its curated plugins into
 * `$CODEX_HOME/.tmp/plugins` whenever it starts, a repository with one commit and no remote.
 */
const PROVIDER_STATE_ENTRIES: ReadonlySet<string> = new Set([".tmp", "tmp", "plugins", "vendor_imports", "skills", "cache", ".cache", "memories", "memories_v2"]);

export interface EnvCleanupOptions {
  root: string;
  assertRootOwner?: () => void;
}

export interface LaneGeneration {
  /** `env/<subject>/<conversation>/<agent>/<scope>`: the directory holding every generation of one lane. */
  lane: string;
  generation: number;
  path: string;
}

/** Remove everything below a lane generation except native session history. Returns how many entries went. */
export async function cleanLaneGeneration(directory: string, options: EnvCleanupOptions): Promise<number> {
  let removed = 0;
  const visit = async (current: string, parts: string[]): Promise<void> => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryParts = [...parts, entry.name];
      const verdict = classify(entryParts);
      if (verdict === "keep") continue;
      const path = join(current, entry.name);
      if (verdict === "descend" && entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path, entryParts);
        continue;
      }
      options.assertRootOwner?.();
      await removeOwnedPath(options.root, path, options);
      removed++;
    }
  };
  await visit(directory, []);
  return removed;
}

/** Clean every lane generation of a subject and delete its execution temp directories. */
export async function cleanSubjectEnvironment(subject: StorageSubjectRef, options: EnvCleanupOptions): Promise<number> {
  let removed = 0;
  for (const generation of listLaneGenerations(options.root, subject)) {
    removed += await cleanLaneGeneration(generation.path, options);
  }
  const tmp = join(envDirectory(options.root, subject), TASK_TMP_DIRECTORY);
  if (lstatSync(tmp, { throwIfNoEntry: false })) {
    options.assertRootOwner?.();
    await removeOwnedPath(options.root, tmp, options);
    removed++;
  }
  return removed;
}

/** Every `<conversation>/<agent>/<scope>/<generation>` directory below a subject's `env/` entry. */
export function listLaneGenerations(root: string, subject: StorageSubjectRef): LaneGeneration[] {
  const generations: LaneGeneration[] = [];
  const base = envDirectory(root, subject);
  for (const conversation of directories(base)) {
    if (conversation === TASK_TMP_DIRECTORY) continue;
    for (const agent of directories(join(base, conversation))) {
      for (const scope of directories(join(base, conversation, agent))) {
        const lane = join(base, conversation, agent, scope);
        for (const name of directories(lane)) {
          const generation = Number(name);
          if (Number.isInteger(generation) && generation > 0 && String(generation) === name) {
            generations.push({ lane, generation, path: join(lane, name) });
          }
        }
      }
    }
  }
  return generations;
}

/** Generations below the highest one of their lane. */
export function supersededGenerations(root: string, subject: StorageSubjectRef): LaneGeneration[] {
  const highest = new Map<string, number>();
  const all = listLaneGenerations(root, subject);
  for (const generation of all) highest.set(generation.lane, Math.max(highest.get(generation.lane) ?? 0, generation.generation));
  return all.filter((generation) => generation.generation < (highest.get(generation.lane) ?? 0));
}

/** Last change to a generation directory or its direct children, in epoch milliseconds. */
export function generationModifiedAt(directory: string): number {
  let latest = lstatSync(directory).mtimeMs;
  for (const name of readdirSync(directory)) {
    latest = Math.max(latest, lstatSync(join(directory, name), { throwIfNoEntry: false })?.mtimeMs ?? 0);
  }
  return latest;
}

/** Whether a path below a lane generation (its parts) is native session history, which stays where it is. */
export function isKeptHistory(parts: readonly string[]): boolean {
  return classify([...parts]) === "keep";
}

/**
 * Whether a path below a lane generation (its parts) is the provider's own state, directly in its home:
 * cleanup deletes it, and nothing in it is the agent's work, so no repository in it has anything to save.
 */
export function isProviderState(parts: readonly string[]): boolean {
  const rest = homeRest(parts);
  return rest?.length === 1 && PROVIDER_STATE_ENTRIES.has(rest[0]!);
}

type Verdict = "keep" | "descend" | "delete";

function classify(parts: string[]): Verdict {
  const rest = homeRest(parts);
  if (rest) return classifyHome(rest);
  return parts[0] === "executions" && parts.length <= 2 ? "descend" : "delete";
}

/** The path below a provider home: `home/…`, or `executions/<fingerprint>/home/…` (one home per Plugin set). Null outside one. */
function homeRest(parts: readonly string[]): readonly string[] | null {
  if (parts[0] === "home") return parts.slice(1);
  return parts[0] === "executions" && parts[2] === "home" ? parts.slice(3) : null;
}

function classifyHome(rest: readonly string[]): Verdict {
  if (rest.length === 0) return "descend";
  return rest.length === 1 && HISTORY_ENTRIES.has(rest[0]!) ? "keep" : "delete";
}

function directories(parent: string): string[] {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort();
}

/** Remove a directory through the anchored removal, or unlink a file or link, below the owned root. */
export async function removeOwnedPath(root: string, path: string, options: Pick<EnvCleanupOptions, "assertRootOwner">): Promise<void> {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  if (info.isDirectory() && !info.isSymbolicLink()) {
    await removeOwnedDirectory(root, path, { assertRootOwner: options.assertRootOwner });
    return;
  }
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to remove path outside owned root: ${path}`);
  }
  unlinkSync(path);
}
