import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { homedir } from "node:os";
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

// ── Path constants ──────────────────────────────────────

const HOME = homedir();
const REMI_DATA = join(HOME, ".remi");
const PROJECTS_DIR = join(REMI_DATA, "projects");
const PERSONAL_WIKI_DIR = join(PROJECTS_DIR, "-data00-home-hehuajie", "wiki");
const SOUL_FILE = join(REMI_DATA, "soul.md");
const REMI_REPO = "/data00/home/hehuajie/project/remi";
const AGENTS_DIR = join(REMI_REPO, "agents");
const PROJECT_CONFIG = join(REMI_REPO, "CLAUDE.md");

/** Convert project hash to readable name: "-data00-home-hehuajie-project-remi" → "remi" */
function projectDisplayName(hash: string): string {
  const m = hash.match(/-project-(.+)$/);
  return m ? m[1] : hash;
}

/** Discover all project wikis (excluding personal wiki) */
function discoverProjectWikis(): { name: string; hash: string; wikiDir: string }[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const results: { name: string; hash: string; wikiDir: string }[] = [];
  for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "-data00-home-hehuajie") continue;
    const wikiDir = join(PROJECTS_DIR, entry.name, "wiki");
    if (existsSync(wikiDir)) {
      results.push({ name: projectDisplayName(entry.name), hash: entry.name, wikiDir });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Types ───────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

interface GitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// ── Helpers ─────────────────────────────────────────────

function scanDir(dir: string, pathPrefix: string): TreeNode[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const result: TreeNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(pathPrefix, entry.name);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        path: entryPath,
        type: "directory",
        children: scanDir(join(dir, entry.name), entryPath),
      });
    } else {
      result.push({ name: entry.name, path: entryPath, type: "file" });
    }
  }
  return result;
}

function resolveFilePath(path: string): string | null {
  // Personal wiki: personal/...
  if (path.startsWith("personal/")) {
    return join(PERSONAL_WIKI_DIR, path.slice("personal/".length));
  }
  // Project wiki: projects/<hash>/...
  if (path.startsWith("projects/")) {
    const rest = path.slice("projects/".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) return null;
    const hash = rest.slice(0, slashIdx);
    const filePath = rest.slice(slashIdx + 1);
    return join(PROJECTS_DIR, hash, "wiki", filePath);
  }
  if (path === "soul" || path === "soul.md" || path.startsWith("soul/")) {
    return SOUL_FILE;
  }
  if (path.startsWith("agents/")) {
    return join(AGENTS_DIR, path.slice("agents/".length));
  }
  if (path.startsWith("project/")) {
    return join(REMI_REPO, path.slice("project/".length));
  }
  return null;
}

function getRepoDir(fsPath: string): string | null {
  if (fsPath.startsWith(REMI_DATA)) return REMI_DATA;
  if (fsPath.startsWith(REMI_REPO)) return REMI_REPO;
  return null;
}

function parseGitLogLine(line: string): GitInfo | null {
  const parts = line.split("|");
  if (parts.length < 4) return null;
  return {
    hash: parts[0],
    message: parts[1],
    author: parts[2],
    date: parts[3],
  };
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

// ── Handler ─────────────────────────────────────────────

export function registerWikiHandlers(app: Hono, data: RemiData) {
  // GET /api/v1/wiki/tree
  app.get("/api/v1/wiki/tree", (c) => {
    const tree: TreeNode[] = [];

    // Personal Wiki
    if (existsSync(PERSONAL_WIKI_DIR)) {
      tree.push({
        name: "Personal",
        path: "personal",
        type: "directory",
        children: scanDir(PERSONAL_WIKI_DIR, "personal"),
      });
    }

    // Project Wikis
    const projects = discoverProjectWikis();
    if (projects.length > 0) {
      const projectChildren: TreeNode[] = projects.map(p => ({
        name: p.name,
        path: `projects/${p.hash}`,
        type: "directory" as const,
        children: scanDir(p.wikiDir, `projects/${p.hash}`),
      }));
      tree.push({
        name: "Projects",
        path: "projects",
        type: "directory",
        children: projectChildren,
      });
    }

    // Soul
    if (existsSync(SOUL_FILE)) {
      tree.push({ name: "Soul & Agents", path: "soul", type: "file" });
    }

    // Agents — scan for CLAUDE.md files
    if (existsSync(AGENTS_DIR)) {
      const agentEntries = readdirSync(AGENTS_DIR, { withFileTypes: true });
      const agentChildren: TreeNode[] = [];
      for (const entry of agentEntries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const claudeMd = join(AGENTS_DIR, entry.name, "CLAUDE.md");
        if (existsSync(claudeMd)) {
          agentChildren.push({
            name: entry.name,
            path: `agents/${entry.name}/CLAUDE.md`,
            type: "file",
          });
        }
      }
      if (agentChildren.length > 0) {
        tree.push({
          name: "Agents",
          path: "agents",
          type: "directory",
          children: agentChildren,
        });
      }
    }

    // Project config
    if (existsSync(PROJECT_CONFIG)) {
      tree.push({ name: "Project Config", path: "project/CLAUDE.md", type: "file" });
    }

    return c.json(tree);
  });

  // GET /api/v1/wiki/file?path=<path>
  app.get("/api/v1/wiki/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path parameter" }, 400);

    const fsPath = resolveFilePath(path);
    if (!fsPath || !existsSync(fsPath)) {
      return c.json({ error: "File not found" }, 404);
    }

    try {
      const stat = statSync(fsPath);
      if (!stat.isFile()) return c.json({ error: "Not a file" }, 400);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }

    const content = readFileSync(fsPath, "utf-8");
    const lastModified = statSync(fsPath).mtime.toISOString();

    let gitInfo: GitInfo | null = null;
    const repoDir = getRepoDir(fsPath);
    if (repoDir) {
      try {
        const out = await runGit(
          ["log", "-1", "--format=%H|%s|%an|%ai", "--", fsPath],
          repoDir,
        );
        if (out) gitInfo = parseGitLogLine(out);
      } catch {
        // git not available or not a git repo — skip
      }
    }

    return c.json({ content, lastModified, gitInfo });
  });

  // GET /api/v1/wiki/history?path=<path>&limit=20
  app.get("/api/v1/wiki/history", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path parameter" }, 400);

    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);

    const fsPath = resolveFilePath(path);
    if (!fsPath || !existsSync(fsPath)) {
      return c.json({ error: "File not found" }, 404);
    }

    const repoDir = getRepoDir(fsPath);
    if (!repoDir) return c.json([]);

    try {
      const out = await runGit(
        ["log", "--follow", `-n`, `${limit}`, "--format=%H|%s|%an|%ai", "--", fsPath],
        repoDir,
      );
      if (!out) return c.json([]);
      const entries = out
        .split("\n")
        .map(parseGitLogLine)
        .filter((e): e is GitInfo => e !== null);
      return c.json(entries);
    } catch {
      return c.json([]);
    }
  });

  // GET /api/v1/wiki/diff?path=<path>&commit=<hash>
  app.get("/api/v1/wiki/diff", async (c) => {
    const path = c.req.query("path");
    const commit = c.req.query("commit");
    if (!path || !commit) {
      return c.json({ error: "Missing path or commit parameter" }, 400);
    }

    const fsPath = resolveFilePath(path);
    if (!fsPath) return c.json({ error: "File not found" }, 404);

    const repoDir = getRepoDir(fsPath);
    if (!repoDir) return c.json({ diff: "" });

    try {
      const diff = await runGit(
        ["diff", `${commit}~1`, commit, "--", fsPath],
        repoDir,
      );
      return c.json({ diff });
    } catch {
      return c.json({ diff: "" });
    }
  });
}
