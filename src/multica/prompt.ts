import type { MulticaTaskWithAgent } from "./types.js";

export function buildTaskPrompt(task: MulticaTaskWithAgent): string {
  const sections: string[] = [];

  sections.push("# Task");
  sections.push(task.prompt.trim());

  if (task.issue) {
    sections.push("");
    sections.push("## Issue");
    sections.push(`Title: ${task.issue.title}`);
    if (task.issue.description) sections.push(task.issue.description);
  }

  if (task.project) {
    sections.push("");
    sections.push("## Project Context");
    sections.push(`This issue belongs to project: ${task.project.title}`);
    if (task.project.description) sections.push(task.project.description);
    if (task.projectResources.length) {
      sections.push("");
      sections.push("Project resources:");
      for (const resource of task.projectResources) {
        sections.push(formatProjectResource(resource));
      }
    }
  }

  if (task.agent?.instructions) {
    sections.push("");
    sections.push("## Agent Instructions");
    sections.push(task.agent.instructions);
  }

  if (task.agent?.skills.length) {
    sections.push("");
    sections.push("## Skills");
    for (const skill of task.agent.skills) {
      sections.push(`### ${skill.name}`);
      if (skill.description) sections.push(skill.description);
      sections.push(skill.content);
      if (skill.files?.length) {
        sections.push("Supporting files:");
        for (const file of skill.files) {
          sections.push(`- ${file.path}`);
        }
      }
    }
  }

  sections.push("");
  sections.push("## Output");
  sections.push("When finished, summarize what changed, how it was verified, and any remaining risks.");

  return sections.join("\n");
}

function formatProjectResource(resource: MulticaTaskWithAgent["projectResources"][number]): string {
  if (resource.resourceType === "github_repo") {
    const url = String(resource.resourceRef.url ?? "");
    const branch = String(resource.resourceRef.defaultBranchHint ?? resource.resourceRef.default_branch_hint ?? "");
    return branch ? `- GitHub repo: ${url} (default branch: ${branch})` : `- GitHub repo: ${url}`;
  }
  return `- ${resource.resourceType}: ${JSON.stringify(resource.resourceRef)}`;
}
