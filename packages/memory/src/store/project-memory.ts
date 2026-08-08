/**
 * MemoryStore — MEMORY.md section splitting and project-local `.remi/` memory
 * discovery.
 *
 * Moved verbatim out of `memory/store.ts`; both the recall pipeline and the
 * entity writers use these.
 */

import {
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";

/** Sections considered "core" identity — not returned by recall as extended sections. */
const CORE_SECTIONS = new Set(["关于主人", "用户偏好"]);

/**
 * Parse MEMORY.md into sections. Returns core (identity) and
 * extended (searchable via recall) parts.
 */
export function splitMemorySections(content: string): {
  core: string;
  extended: Array<{ heading: string; body: string }>;
} {
  const lines = content.split("\n");
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;
  const preamble: string[] = [];

  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);

  const coreLines = [...preamble];
  const extended: Array<{ heading: string; body: string }> = [];

  for (const sec of sections) {
    if (CORE_SECTIONS.has(sec.heading)) {
      coreLines.push(`## ${sec.heading}`, ...sec.body);
    } else {
      const body = sec.body.join("\n").trim();
      if (body) {
        extended.push({ heading: sec.heading, body });
      }
    }
  }

  return { core: coreLines.join("\n").trim(), extended };
}

export function resolveProjectRoot(cwd: string): string | null {
  let p = resolve(cwd);
  let root: string | null = null;
  while (true) {
    if (existsSync(join(p, ".remi"))) {
      root = p;
    }
    const parent = dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return root;
}

export function findRemiMemoryFiles(root: string, callback: (path: string) => void): void {
  const remiMemory = join(root, ".remi", "memory.md");
  if (existsSync(remiMemory)) {
    callback(remiMemory);
  }
  // Scan subdirectories
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        findRemiMemoryFiles(join(root, entry.name), callback);
      }
    }
  } catch {
    // Permission errors etc.
  }
}
