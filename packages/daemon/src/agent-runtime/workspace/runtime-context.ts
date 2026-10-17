import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { IssueSessionProviderHome } from "./session-home.js";
import { LocalDirectoryError } from "./ephemeral.js";

const MAX_FILE_BYTES = 256 * 1024;
// Leave room for provider-discovered project instructions in Codex's default budget.
const MAX_CONTEXT_BYTES = 24 * 1024;
/** The whole `AGENTS.md`: Remi's notes get what the local context leaves, up to their own cap. */
export const PROVIDER_INSTRUCTIONS_MAX_BYTES = 48 * 1024;
const REMI_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
const LOCAL_CONTEXT_HEADING = "# Runtime workspace local context";
/** The first line of every `AGENTS.md` Remi writes; it tells Remi's own file from anyone else's. */
export const PROVIDER_INSTRUCTIONS_MARKER = "<!-- Written by Remi for this session and rewritten before every turn; edits do not persist. -->";
/** Claude reads only `CLAUDE.md` from its config dir; this one imports the shared file. */
const CLAUDE_IMPORT = "@AGENTS.md\n";

/** Paths are registered centrally; contents are read only here, on the owning host. */
export function prepareRuntimeWorkspaceContext(
  task: AgentTask,
  providerHome: IssueSessionProviderHome,
  workDir: string,
): Record<string, string> {
  const context = runtimeWorkspaceContext(task, providerHome, workDir);
  if (!context) return {};
  writeProviderInstructions(providerHome, { local: context.instructions });
  return context.env;
}

/**
 * The runtime workspace's local instructions and env file, read on this host:
 * instruction files from the workspace root down to the working directory and
 * the registered context paths, with the workspace's own skill catalog. User-level
 * files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, personal skills) are not
 * read: an Agent's definition does not depend on whose machine runs it (ADR 0023).
 * The instructions are never sent to the server; the caller writes them into the
 * provider home with {@link writeProviderInstructions}.
 */
export function runtimeWorkspaceContext(
  task: AgentTask,
  providerHome: IssueSessionProviderHome,
  workDir: string,
): { instructions: string; env: Record<string, string> } | null {
  const workspace = task.runtimeWorkspace;
  if (!workspace) return null;
  const root = realpathSync(workspace.rootPath);
  const cwd = containedPath(root, workDir);
  const sections: string[] = [];
  const seen = new Set<string>();
  const instructionNames = providerHome.provider === "codex"
    ? ["AGENTS.override.md", "AGENTS.md", "AGENT.md"] : providerHome.provider === "antigravity"
      ? ["AGENTS.md", "AGENT.md"] : ["CLAUDE.md", "AGENTS.md", "AGENT.md"];

  const addInstructions = (file: string, boundary: string) => {
    if (!existsSync(file)) return;
    const canonical = containedPath(boundary, file);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    sections.push(`\n## Local instructions: ${file}\n${readText(canonical)}`);
  };
  const addSkills = (directory: string, boundary: string) => {
    if (!existsSync(directory)) return;
    const canonical = containedPath(boundary, directory);
    const files = existsSync(join(canonical, "SKILL.md")) ? [join(canonical, "SKILL.md")]
      : readdirSync(canonical).sort().map(name => join(canonical, name, "SKILL.md")).filter(existsSync);
    if (files.length > 256) throw new LocalDirectoryError("Runtime workspace skill directory exceeds 256 skills");
    for (const file of files) {
      const source = containedPath(boundary, file);
      if (seen.has(source)) continue;
      seen.add(source);
      const content = readText(source);
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const metadata = frontmatter ? parseYaml(frontmatter[1]!, { maxAliasCount: 0 }) : {};
      const name = typeof metadata?.name === "string" ? metadata.name : basename(dirname(source));
      const description = typeof metadata?.description === "string" ? metadata.description : "Read SKILL.md when relevant.";
      sections.push(`- Skill ${JSON.stringify(name)}: ${JSON.stringify(description)}. Read ${JSON.stringify(source)}; resolve supporting files beside that file.`);
    }
  };

  // The workspace's own skills: providers find only the working directory's, so the catalog names the rest.
  // The Agent's skills are installed where the provider finds them itself (`syncAgentSkills`).
  sections.push("\n## Local skills\nWhen a listed skill is relevant, read its original SKILL.md and follow its instructions before working.");
  const ancestors: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    ancestors.unshift(directory);
    if (directory === root) break;
    if (dirname(directory) === directory) throw new LocalDirectoryError("Runtime workspace cwd escapes root");
  }
  for (const directory of ancestors) {
    const file = instructionNames.find(name => existsSync(join(directory, name)));
    if (file) addInstructions(join(directory, file), root);
    addSkills(join(directory, ".agents", "skills"), root);
    if (providerHome.provider === "claude") addSkills(join(directory, ".claude", "skills"), root);
  }
  for (const source of workspace.contextPaths) {
    const path = containedPath(root, resolve(root, source));
    if (statSync(path).isDirectory()) addSkills(path, root);
    else addInstructions(path, root);
  }
  const content = `${LOCAL_CONTEXT_HEADING}\nInstructions below are ordered from workspace root to working directory. More specific directory instructions take precedence.\n${sections.join("\n")}\n`;
  if (Buffer.byteLength(content) > MAX_CONTEXT_BYTES) {
    throw new LocalDirectoryError("Runtime workspace local context exceeds 24 KiB; reduce instruction files or the skill catalog");
  }
  return { instructions: content, env: runtimeWorkspaceEnv(task, root, providerHome.provider) };
}

/** What Remi's notes may use of `AGENTS.md` next to `local`. */
export function remiInstructionsBudget(local: string | null | undefined): number {
  const marker = Buffer.byteLength(PROVIDER_INSTRUCTIONS_MARKER) + 2;
  return Math.min(REMI_INSTRUCTIONS_MAX_BYTES, PROVIDER_INSTRUCTIONS_MAX_BYTES - marker - (local ? Buffer.byteLength(local) + 1 : 0));
}

/** The session's `AGENTS.md`, in its provider home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_HOME`). */
export function providerInstructionsPath(providerHome: IssueSessionProviderHome): string {
  return join(providerHome.home, "AGENTS.md");
}

/**
 * Write the provider's own instruction file in its daemon-owned home (ADR 0023):
 * `AGENTS.md` with Remi's notes first, then the runtime workspace's local
 * context; for Claude also `CLAUDE.md`, which imports it. Never a working
 * directory or a local project folder. Each file is replaced atomically and only
 * when its content changed; with neither part, the files Remi wrote are removed.
 * Returns the `AGENTS.md` content now in effect.
 */
export function writeProviderInstructions(
  providerHome: IssueSessionProviderHome,
  parts: { remi?: string | null; local?: string | null },
): string | null {
  const body = [parts.remi, parts.local].filter((part): part is string => Boolean(part?.trim()))
    .map(part => part.endsWith("\n") ? part : `${part}\n`).join("\n");
  const agents = providerInstructionsPath(providerHome);
  const claude = providerHome.provider === "claude" ? join(providerHome.home, "CLAUDE.md") : null;
  if (!body) {
    removeOwnFile(agents, current => current.startsWith(PROVIDER_INSTRUCTIONS_MARKER) || current.startsWith(LOCAL_CONTEXT_HEADING));
    if (claude) removeOwnFile(claude, current => current === CLAUDE_IMPORT || current.startsWith(LOCAL_CONTEXT_HEADING));
    return null;
  }
  const content = `${PROVIDER_INSTRUCTIONS_MARKER}\n\n${body}`;
  if (Buffer.byteLength(content) > PROVIDER_INSTRUCTIONS_MAX_BYTES) {
    throw new LocalDirectoryError("Provider instructions exceed 48 KiB; reduce instruction files or the skill catalog");
  }
  writeOwnFile(agents, content);
  if (claude) writeOwnFile(claude, CLAUDE_IMPORT);
  return content;
}

/** A model can rewrite its own home; Remi never writes through a link it finds there. */
function ownFileStat(path: string): ReturnType<typeof lstatSync> | null {
  const stat = existsSync(path) ? lstatSync(path) : null;
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)) {
    throw new LocalDirectoryError("Runtime workspace provider instructions must be an unlinked regular file");
  }
  return stat;
}

function writeOwnFile(path: string, content: string): void {
  if (ownFileStat(path) && readFileSync(path, "utf8") === content) return;
  const temporary = `${path}.remi-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeOwnFile(path: string, ours: (content: string) => boolean): void {
  if (ownFileStat(path) && ours(readFileSync(path, "utf8"))) unlinkSync(path);
}

function runtimeWorkspaceEnv(task: AgentTask, root: string, provider: IssueSessionProviderHome["provider"]): Record<string, string> {
  const workspace = task.runtimeWorkspace!;
  if (!workspace.envFile) return {};
  const env = parseEnv(readText(containedPath(root, resolve(root, workspace.envFile))));
  // Runtime/task identity and provider homes/routing stay authoritative.
  // Antigravity also owns its home, gateway routing and Google credentials
  // (blanked by its environment builder); other providers may use Google tools.
  const antigravity = provider === "antigravity";
  for (const key of Object.keys(env)) {
    if (/^(MULTIREMI_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|OPENAI_|ANTHROPIC_)/i.test(key)
      || (antigravity && /^(GEMINI_HOME$|GEMINI_API_KEY$|AGY_|GOOGLE_|ANTIGRAVITY_)/i.test(key))) {
      throw new LocalDirectoryError(`Runtime workspace env file cannot override ${key}`);
    }
  }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function containedPath(root: string, path: string): string {
  const canonical = realpathSync(path);
  const rel = relative(root, canonical);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new LocalDirectoryError("Runtime workspace context path escapes its root");
  }
  return canonical;
}

function readText(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new LocalDirectoryError(`Runtime workspace context must be a file under 256 KiB: ${path}`);
  return readFileSync(path, "utf8");
}
