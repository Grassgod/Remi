/**
 * Ephemeral agent-runtime context writers.
 *
 * Per-task workdir preparation for Multiremi tasks: serialize task /
 * project-resource metadata and materialize the agent's skills into the skill
 * root its runtime reads (`.claude/skills` for claude, `.agents/skills` for
 * codex) before the agent runs. Extracted from src/multiremi/daemon.ts in D6.
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTask } from "@daemon/contracts/types.js";

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

export function writeAgentSkillContext(workDir: string, task: AgentTask): void {
  const skills = task.agent?.skills ?? [];
  if (!skills.length) return;
  const root = agentSkillRoot(workDir, task.agent?.provider);
  mkdirSync(root, { recursive: true });
  for (const skill of skills) {
    const dir = join(root, safeSkillDirName(skill.name));
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
}

function renderSkillMarkdown(skill: NonNullable<AgentTask["agent"]>["skills"][number]): string {
  const content = skill.content ?? "";
  if (content.trimStart().startsWith("---")) return content;
  const frontmatter = [
    "---",
    `name: ${yamlQuote(skill.name)}`,
    skill.description ? `description: ${yamlQuote(skill.description)}` : "",
    "---",
    "",
  ].filter((line) => line !== "").join("\n");
  return `${frontmatter}${content}`;
}

function yamlQuote(value: string): string {
  return JSON.stringify(String(value ?? ""));
}

function safeSkillDirName(value: string): string {
  return String(value || "skill").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
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
