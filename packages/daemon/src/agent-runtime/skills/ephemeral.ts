/**
 * Ephemeral agent-runtime context writers.
 *
 * Per-task workdir preparation for Multiremi tasks: serialize task /
 * project-resource metadata and materialize the agent's skills into the skill
 * root its runtime reads (`.claude/skills` for claude, `.agents/skills` for
 * codex) before the agent runs. Extracted from src/multiremi/daemon.ts in D6.
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { boundSlashCommands, hasNonAsciiText, skillCommandName, type ObservedSlashCommand, type SlashCommandEntry } from "@multiremi/contracts/slash-commands.js";
import type { AgentTask, AgentTaskSkill } from "@daemon/contracts/types.js";

export function writeTaskContext(workDir: string, task: AgentTask): void {
  const dir = join(workDir, ".multiremi");
  mkdirSync(dir, { recursive: true });
  const taskPath = join(dir, "task.json");
  const topicBinding = readTopicBinding(taskPath);
  const payload = {
    task_id: task.id,
    workspace_id: task.workspaceId,
    agent: task.agent ? {
      id: task.agent.id,
      name: task.agent.name,
      provider: task.agent.provider,
      model: task.agent.model,
    } : null,
    issue: task.issue ? {
      id: task.issue.id,
      key: task.issue.key,
      title: task.issue.title,
    } : null,
    project: task.project ? {
      id: task.project.id,
      title: task.project.title,
    } : null,
    project_contexts: (task.projectContexts ?? task.project_contexts ?? []).map((context) => ({
      id: context.project.id,
      title: context.project.title,
      directory: context.project.title,
      repos: context.repos.map((repo) => repo.url),
      docs: context.docs.map((doc) => ({ kind: doc.kind, slug: doc.slug, title: doc.title })),
    })),
    repos: task.repos.map((repo) => ({
      url: repo.url,
      ...(repo.description ? { description: repo.description } : {}),
    })),
    prompt: task.prompt,
    ...(topicBinding ? { topic_binding: topicBinding } : {}),
  };
  writeFileSync(taskPath, JSON.stringify(payload, null, 2), { mode: 0o644 });
}

function readTopicBinding(taskPath: string): Record<string, unknown> | null {
  if (!existsSync(taskPath)) return null;
  try {
    const value = JSON.parse(readFileSync(taskPath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const binding = (value as Record<string, unknown>).topic_binding;
    return binding && typeof binding === "object" && !Array.isArray(binding)
      ? binding as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function writeProjectResourceContext(workDir: string, task: AgentTask): void {
  if (!task.project && task.projectResources.length === 0) return;
  const dir = join(workDir, ".multiremi", "project");
  mkdirSync(dir, { recursive: true });
  const resources = task.projectResources.filter((resource) => resource.resourceType === "github_repo");
  const payload = {
    project_id: task.project?.id ?? "",
    project_title: task.project?.title ?? "",
    resources: resources.map((resource) => ({
      id: resource.id,
      resource_type: resource.resourceType,
      resource_ref: serializeProjectResourceRef(resource.resourceType, resource.resourceRef),
      ...(resource.label ? { label: resource.label } : {}),
    })),
  };
  writeFileSync(join(dir, "resources.json"), JSON.stringify(payload, null, 2), { mode: 0o644 });
}

/**
 * Skill root each runtime actually reads inside the task workdir.
 *
 * codex-acp never looks at `.claude/skills`: `refreshSkills(cwd, roots)` maps
 * every root to `<root>/.agents/skills` for `skills/extraRoots/set` and lists
 * `cwds: [cwd, ...roots]` (dist/index.js:26718-26731), so a codex task only
 * sees skills materialized under `<workDir>/.agents/skills`.
 */
export function agentSkillRoot(workDir: string, provider: string | undefined): string {
  return provider === "codex" || provider === "antigravity"
    ? join(workDir, ".agents", "skills")
    : join(workDir, ".claude", "skills");
}

/**
 * Skill root a provider discovers in its provider home, for a working
 * directory that is the user's own (a runtime workspace or a Project's
 * `local_directory`, ADR 0023): Claude reads `$CLAUDE_CONFIG_DIR/skills`, Codex
 * `$CODEX_HOME/skills`; Antigravity keeps the `.agents/skills` it has always used.
 */
export function providerHomeSkillRoot(home: string, provider: string | undefined): string {
  return provider === "antigravity" ? join(home, ".agents", "skills") : join(home, "skills");
}

/** The skill directories Remi wrote into a root, so a later sync removes only its own. */
const SKILL_MANIFEST = ".remi-skills.json";

function writtenSkillDirs(root: string): string[] {
  try {
    const value = JSON.parse(readFileSync(join(root, SKILL_MANIFEST), "utf8")) as { skills?: unknown };
    return Array.isArray(value.skills) ? value.skills.filter((name): name is string => typeof name === "string" && SAFE_DIR.test(name)) : [];
  } catch {
    return [];
  }
}

const SAFE_DIR = /^[a-z0-9_][a-z0-9._-]*$/;

/**
 * Install the Agent's skills where the provider discovers them natively, every
 * turn (ADR 0023): each skill is rewritten whole, and a skill the Agent no
 * longer has is removed. Only directories Remi created and recorded in the
 * root's manifest are written or deleted: a directory that was already there
 * (the provider's own, the agent's, a person's) is left alone, even when it
 * has an Agent skill's name, and that skill is not installed over it.
 * The caller picks a root Remi owns: never a folder of the user's own.
 * Returns the directories Remi installed, the ones its skills run from.
 */
export function syncAgentSkills(root: string, task: AgentTask): string[] {
  const skills = task.agent?.skills ?? [];
  const previous = writtenSkillDirs(root);
  const wanted = [...new Set(skills.map((skill) => safeSkillDirName(skill.name)))];
  for (const dir of previous) if (!wanted.includes(dir)) rmSync(join(root, dir), { recursive: true, force: true });
  const owned = wanted.filter((dir) => previous.includes(dir) || !existsSync(join(root, dir)));
  if (!owned.length) {
    if (previous.length) rmSync(join(root, SKILL_MANIFEST), { force: true });
    return [];
  }
  mkdirSync(root, { recursive: true });
  for (const skill of skills) {
    const name = safeSkillDirName(skill.name);
    if (!owned.includes(name)) continue;
    const dir = join(root, name);
    // A removed supporting file must not survive the rewrite.
    rmSync(dir, { recursive: true, force: true });
    writeSkill(dir, skill);
  }
  writeFileSync(join(root, SKILL_MANIFEST), `${JSON.stringify({ skills: owned })}\n`, { mode: 0o644 });
  return owned;
}

/**
 * ADR 0025: the catalogue the daemon reports, from the list the bridge
 * advertised. A command is tagged with a Remi skill's id when it is that skill
 * as installed this turn (`installedDirs`, from `syncAgentSkills`): its
 * `SKILL.md` sits in the skill's directory, or it carries the skill's name
 * (the directory name, or the `name` of a body that brings its own
 * frontmatter). Codex names skills `$name`, so there only a `$` name matches,
 * and the built-in `/review` never becomes a skill called `review`.
 */
export function reportedSlashCommands(provider: string | null | undefined, observed: readonly ObservedSlashCommand[],
  skills: readonly AgentTaskSkill[], installedDirs: readonly string[]): SlashCommandEntry[] {
  const installed = new Set(installedDirs);
  const byDir = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const skill of skills) {
    const id = typeof skill.id === "string" ? skill.id.trim() : "";
    const dir = safeSkillDirName(skill.name);
    if (!id || !installed.has(dir)) continue;
    byDir.set(dir, id);
    byName.set(ownFrontmatterName(skill.content) ?? dir, id);
  }
  const skillPrefix = provider === "codex" ? "$" : "";
  return boundSlashCommands(observed.map((command) => {
    const named = skillPrefix ? command.name.startsWith(skillPrefix) && byName.get(command.name.slice(1))
      : !command.name.startsWith("$") && byName.get(command.name);
    const skillId = (command.skillDir ? byDir.get(command.skillDir) : undefined) ?? (named || undefined);
    return {
      name: command.name,
      description: command.description,
      hint: command.hint,
      kind: skillId ? "skill" as const : command.kind,
      ...(skillId ? { skill_id: skillId } : {}),
    };
  }));
}

/** The `name` of a skill body that brings its own frontmatter (written as is by `renderSkillMarkdown`). */
function ownFrontmatterName(content: string | undefined): string | null {
  const text = String(content ?? "").trimStart();
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  const block = end < 0 ? "" : text.slice(3, end);
  const value = /^name:[ \t]*(.+)$/m.exec(block)?.[1]?.trim() ?? "";
  const unquoted = /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
  return unquoted.trim() || null;
}

export function writeAgentSkillContext(workDir: string, task: AgentTask): void {
  const skills = task.agent?.skills ?? [];
  if (!skills.length) return;
  const root = agentSkillRoot(workDir, task.agent?.provider);
  mkdirSync(root, { recursive: true });
  for (const skill of skills) writeSkill(join(root, safeSkillDirName(skill.name)), skill);
}

function writeSkill(dir: string, skill: NonNullable<AgentTask["agent"]>["skills"][number]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), renderSkillMarkdown(skill), { mode: 0o644 });
  for (const file of skill.files ?? []) {
    const path = normalizeSkillFilePath(file.path);
    const target = join(dir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    const content = file.content ?? "";
    if (file.encoding === "base64") {
      if (typeof file.content !== "string") throw new Error(`Invalid base64 skill file: ${path}`);
      const bytes = Buffer.from(content, "base64");
      if (bytes.toString("base64") !== content) throw new Error(`Invalid base64 skill file: ${path}`);
      writeFileSync(target, bytes, { mode: 0o644 });
    } else {
      if (file.encoding !== undefined && file.encoding !== "utf8") throw new Error(`Unsupported skill file encoding: ${path}`);
      writeFileSync(target, content, { mode: 0o644 });
    }
  }
}

/**
 * The generated `SKILL.md`. Its `name` is the directory name (ADR 0025): the
 * providers invoke a skill by the `name` in its frontmatter, and a display name
 * such as "Git Commit" cannot follow a `/`. A display name the directory name
 * cannot spell (non-ASCII letters) opens the description, so the model still
 * sees it. A body with its own frontmatter is the author's and stays as it is.
 */
function renderSkillMarkdown(skill: NonNullable<AgentTask["agent"]>["skills"][number]): string {
  const content = skill.content ?? "";
  if (content.trimStart().startsWith("---")) return content;
  const label = String(skill.name ?? "").trim();
  const description = [hasNonAsciiText(label) ? label : "", skill.description?.trim() ?? ""].filter(Boolean).join(" — ");
  const frontmatter = [
    "---",
    `name: ${yamlQuote(safeSkillDirName(skill.name))}`,
    description ? `description: ${yamlQuote(description)}` : "",
    "---",
  ].filter((line) => line !== "").join("\n");
  // The closing `---` must end its line: Codex skips a SKILL.md whose frontmatter runs into the body.
  return `${frontmatter}\n${content}`;
}

function yamlQuote(value: string): string {
  return JSON.stringify(String(value ?? ""));
}

/** A skill's directory, and the command name that invokes it (`skillCommandName`). */
function safeSkillDirName(value: string): string {
  return skillCommandName(value);
}

export function normalizeSkillFilePath(value: string): string {
  const normalized = String(value ?? "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!normalized || normalized.startsWith("/") || normalized === "." || normalized.includes("..") || normalized === "SKILL.md") {
    throw new Error(`Invalid skill file path: ${value}`);
  }
  return normalized;
}

function serializeProjectResourceRef(resourceType: string, ref: Record<string, unknown>): Record<string, unknown> {
  if (resourceType !== "github_repo") return ref;
  const url = String(ref.url ?? "");
  const defaultBranchHint = String(ref.default_branch_hint ?? ref.defaultBranchHint ?? "");
  return defaultBranchHint ? { url, default_branch_hint: defaultBranchHint } : { url };
}
