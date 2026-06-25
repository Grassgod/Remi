import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";
import { ProjectStore } from "../../project/store.js";

/** Get alias→cwd map from DB projects table. */
function getProjectMap(): Record<string, string> {
  const store = new ProjectStore();
  const map: Record<string, string> = {};
  for (const p of store.list()) { if (p.cwd) map[p.id] = p.cwd; }
  return map;
}

// ── Path constants ──────────────────────────────────────

const HOME = homedir();
const REMI_DATA = join(HOME, ".remi");
const WIKI_DIR = join(REMI_DATA, "wiki");
const WIKI_PROJECTS_DIR = join(WIKI_DIR, "projects");
const SOUL_FILE = join(REMI_DATA, "soul.md");
const REMI_REPO = process.cwd();
const AGENTS_DIR = join(REMI_REPO, "agents");

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

function resolveFilePath(path: string, projects: Record<string, string>): string | null {
  // Home wiki: home/... → ~/.remi/wiki/{...} (excluding projects/)
  if (path.startsWith("home/")) {
    const rest = path.slice("home/".length);
    if (rest.startsWith("projects/")) return null; // block access to projects/ via home path
    return join(WIKI_DIR, rest);
  }
  // Project wiki: projects/{alias}/... → ~/.remi/wiki/projects/{alias}/{...}
  // Special: projects/{alias}/CLAUDE.md → {projectPath}/.claude/CLAUDE.md
  if (path.startsWith("projects/")) {
    const rest = path.slice("projects/".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) return null;
    const alias = rest.slice(0, slashIdx);
    const filePath = rest.slice(slashIdx + 1);
    if (filePath === "CLAUDE.md") {
      const projectPath = projects[alias];
      if (!projectPath) return null;
      return join(projectPath, ".claude", "CLAUDE.md");
    }
    return join(WIKI_PROJECTS_DIR, alias, filePath);
  }
  // Soul
  if (path === "soul" || path === "soul.md") {
    return SOUL_FILE;
  }
  // Agents
  if (path.startsWith("agents/")) {
    return join(AGENTS_DIR, path.slice("agents/".length));
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
    const projects = getProjectMap(); // alias → path from remi.toml

    // Home — ~/.remi/wiki/ top-level content (excluding projects/)
    if (existsSync(WIKI_DIR)) {
      const homeChildren: TreeNode[] = [];
      for (const entry of readdirSync(WIKI_DIR, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "projects") continue;
        const entryPath = `home/${entry.name}`;
        if (entry.isDirectory()) {
          homeChildren.push({
            name: entry.name,
            path: entryPath,
            type: "directory",
            children: scanDir(join(WIKI_DIR, entry.name), entryPath),
          });
        } else {
          homeChildren.push({ name: entry.name, path: entryPath, type: "file" });
        }
      }
      if (homeChildren.length > 0) {
        tree.push({
          name: "Home",
          path: "home",
          type: "directory",
          children: homeChildren,
        });
      }
    }

    // Projects — scan ~/.remi/wiki/projects/ filesystem (ground truth).
    // Previously only iterated over DB-registered projects, missing any
    // entity-only project that wiki-curate had bootstrapped a README for.
    const projectChildren: TreeNode[] = [];
    if (existsSync(WIKI_PROJECTS_DIR)) {
      const aliases = readdirSync(WIKI_PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));

      for (const alias of aliases) {
        const wikiDir = join(WIKI_PROJECTS_DIR, alias);
        const children = scanDir(wikiDir, `projects/${alias}`);
        if (children.length > 0) {
          projectChildren.push({
            name: alias,
            path: `projects/${alias}`,
            type: "directory",
            children,
          });
        }
      }
    }
    if (projectChildren.length > 0) {
      tree.push({
        name: "Projects",
        path: "projects",
        type: "directory",
        children: projectChildren,
      });
    }

    // Soul
    if (existsSync(SOUL_FILE)) {
      tree.push({ name: "Soul", path: "soul", type: "file" });
    }

    // Agents — scan for CLAUDE.md files
    if (existsSync(AGENTS_DIR)) {
      const agentChildren: TreeNode[] = [];
      for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
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

    return c.json(tree);
  });

  // GET /api/v1/wiki/file?path=<path>
  app.get("/api/v1/wiki/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path parameter" }, 400);

    const projects = getProjectMap();
    const fsPath = resolveFilePath(path, projects);
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

  // PUT /api/v1/wiki/file — write file content
  app.put("/api/v1/wiki/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path parameter" }, 400);

    const body = await c.req.json();
    if (!body.content || typeof body.content !== "string") {
      return c.json({ error: "content required" }, 400);
    }

    const projects = getProjectMap();
    const fsPath = resolveFilePath(path, projects);
    if (!fsPath) return c.json({ error: "Invalid path" }, 400);
    if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
      return c.json({ error: "File not found" }, 404);
    }

    try {
      writeFileSync(fsPath, body.content, "utf-8");
      return c.json({ ok: true });
    } catch {
      return c.json({ error: "Write failed" }, 500);
    }
  });

  // GET /api/v1/wiki/history?path=<path>&limit=20
  app.get("/api/v1/wiki/history", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path parameter" }, 400);

    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);

    const projects = getProjectMap();
    const fsPath = resolveFilePath(path, projects);
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

    const projects = getProjectMap();
    const fsPath = resolveFilePath(path, projects);
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
