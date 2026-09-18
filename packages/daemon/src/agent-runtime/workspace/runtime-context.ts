import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { IssueSessionProviderHome } from "./session-home.js";
import { LocalDirectoryError } from "./ephemeral.js";

const MAX_FILE_BYTES = 256 * 1024;
// Leave room for provider-discovered project instructions in Codex's default budget.
const MAX_CONTEXT_BYTES = 24 * 1024;

/** Paths are registered centrally; contents are read only here, on the owning host. */
export function prepareRuntimeWorkspaceContext(
  task: AgentTask,
  providerHome: IssueSessionProviderHome,
  workDir: string,
  options: { baseHome?: string; userHome?: string } = {},
): Record<string, string> {
  const workspace = task.runtimeWorkspace;
  if (!workspace) return {};
  const root = realpathSync(workspace.rootPath);
  const cwd = containedPath(root, workDir);
  const sections: string[] = [];
  const seen = new Set<string>();
  const userHome = options.userHome ?? homedir();
  const baseHome = options.baseHome ?? (providerHome.provider === "codex"
    ? process.env.CODEX_HOME ?? join(userHome, ".codex")
    : providerHome.provider === "antigravity" ? join(userHome, ".gemini", "antigravity-cli")
      : process.env.CLAUDE_CONFIG_DIR ?? join(userHome, ".claude"));
  const instructionNames = providerHome.provider === "codex"
    ? ["AGENTS.override.md", "AGENTS.md", "AGENT.md"] : providerHome.provider === "antigravity"
      ? ["AGENTS.md", "AGENT.md"] : ["CLAUDE.md", "AGENTS.md", "AGENT.md"];

  const addInstructions = (file: string, boundary?: string) => {
    if (!existsSync(file)) return;
    const canonical = boundary ? containedPath(boundary, file) : realpathSync(file);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    sections.push(`\n## Local instructions: ${file}\n${readText(canonical)}`);
  };
  const addSkills = (directory: string, boundary?: string) => {
    if (!existsSync(directory)) return;
    const canonical = boundary ? containedPath(boundary, directory) : realpathSync(directory);
    const files = existsSync(join(canonical, "SKILL.md")) ? [join(canonical, "SKILL.md")]
      : readdirSync(canonical).sort().map(name => join(canonical, name, "SKILL.md")).filter(existsSync);
    if (files.length > 256) throw new LocalDirectoryError("Runtime workspace skill directory exceeds 256 skills");
    for (const file of files) {
      const source = boundary ? containedPath(boundary, file) : realpathSync(file);
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

  // Preserve user-level instructions while keeping native histories/session IDs isolated.
  const global = instructionNames.find(name => existsSync(join(baseHome, name)));
  if (global) addInstructions(join(baseHome, global));
  sections.push("\n## Local skills\nWhen a listed skill is relevant, read its original SKILL.md and follow its instructions before working.");
  addSkills(join(baseHome, "skills"));
  addSkills(join(userHome, ".agents", "skills"));
  // Database Agent skills are materialized in daemon-owned state, leaving any
  // identically named local skill intact.
  addSkills(join(providerHome.home, providerHome.provider === "claude" ? ".claude" : ".agents", "skills"));
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
  const content = `# Runtime workspace local context\nInstructions below are ordered from user to workspace root to working directory. More specific directory instructions take precedence.\n${sections.join("\n")}\n`;
  if (Buffer.byteLength(content) > MAX_CONTEXT_BYTES) {
    throw new LocalDirectoryError("Runtime workspace local context exceeds 24 KiB; reduce instruction files or the skill catalog");
  }
  const target = join(providerHome.home, providerHome.provider === "claude" ? "CLAUDE.md" : "AGENTS.md");
  const targetStat = existsSync(target) ? lstatSync(target) : null;
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1)) {
    throw new LocalDirectoryError("Runtime workspace provider instructions must be an unlinked regular file");
  }
  writeFileSync(target, content, { mode: 0o600 });

  if (!workspace.envFile) return {};
  const env = parseEnv(readText(containedPath(root, resolve(root, workspace.envFile))));
  // Runtime/task identity and provider homes/routing stay authoritative.
  for (const key of Object.keys(env)) {
    if (/^(MULTIREMI_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|OPENAI_|ANTHROPIC_)/i.test(key)) {
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
