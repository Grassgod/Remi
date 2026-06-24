/**
 * Ephemeral agent-runtime context writers.
 *
 * Per-task workdir preparation for Multiremi tasks: serialize task / GC /
 * project-resource metadata and materialize the agent's skills into the
 * task's .claude/skills/ before the agent runs. Extracted verbatim from
 * src/multiremi/daemon.ts in D6 (behavior unchanged).
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AgentTask } from "@daemon/contracts/types.js";

export function writeTaskContext(workDir: string, task: AgentTask): void {
  const dir = join(workDir, ".multiremi");
  mkdirSync(dir, { recursive: true });
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
    repos: task.repos.map((repo) => ({
      url: repo.url,
      ...(repo.description ? { description: repo.description } : {}),
    })),
    prompt: task.prompt,
  };
  writeFileSync(join(dir, "task.json"), JSON.stringify(payload, null, 2), { mode: 0o644 });
}

export function writeTaskGcContext(workDir: string, task: AgentTask, options: { localDirectory?: boolean } = {}): void {
  const dir = join(workDir, ".multiremi");
  mkdirSync(dir, { recursive: true });
  const kind = task.chatSessionId
    ? "chat"
    : task.autopilotRunId
      ? "autopilot_run"
      : task.issueId
        ? "issue"
        : "quick_create";
  const payload = {
    version: 1,
    kind,
    workspace_id: task.workspaceId,
    task_id: task.id,
    issue_id: task.issueId,
    chat_session_id: task.chatSessionId,
    autopilot_run_id: task.autopilotRunId,
    completed_at: task.completedAt,
    created_at: task.createdAt,
    local_directory: options.localDirectory || undefined,
  };
  writeFileSync(join(dir, "gc.json"), JSON.stringify(payload, null, 2), { mode: 0o644 });
}

export function writeProjectResourceContext(workDir: string, task: AgentTask): void {
  if (!task.project && task.projectResources.length === 0) return;
  const dir = join(workDir, ".multiremi", "project");
  mkdirSync(dir, { recursive: true });
  const payload = {
    project_id: task.project?.id ?? "",
    project_title: task.project?.title ?? "",
    resources: task.projectResources.map((resource) => ({
      id: resource.id,
      resource_type: resource.resourceType,
      resource_ref: serializeProjectResourceRef(resource.resourceType, resource.resourceRef),
      ...(resource.label ? { label: resource.label } : {}),
    })),
  };
  writeFileSync(join(dir, "resources.json"), JSON.stringify(payload, null, 2), { mode: 0o644 });
}

export function writeAgentSkillContext(workDir: string, task: AgentTask): void {
  const skills = task.agent?.skills ?? [];
  if (!skills.length) return;
  const root = join(workDir, ".claude", "skills");
  mkdirSync(root, { recursive: true });
  for (const skill of skills) {
    const dir = join(root, safeSkillDirName(skill.name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), renderSkillMarkdown(skill), { mode: 0o644 });
    for (const file of skill.files ?? []) {
      const path = normalizeSkillFilePath(file.path);
      const target = join(dir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, file.content ?? "", { mode: 0o644 });
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
