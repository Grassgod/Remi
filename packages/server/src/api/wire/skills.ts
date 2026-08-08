// Wire serializers for the skills domain, moved verbatim out of api.ts.
// Go-compat (`*Compatibility*`) and native shapers sit side by side on purpose:
// the two route prefixes are intentionally divergent and must stay diffable.
import type {
  CreateSkillInput,
  ImportSkillInput,
  MultiremiSkill,
  MultiremiSkillFile,
  UpdateSkillInput,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { Context } from "hono";
import { cleanString, currentAccessToken, parseOptionalInt } from "./context.js";

export function requestedSkillWorkspaceId(
  c: Context,
  input?: Pick<CreateSkillInput | ImportSkillInput | UpdateSkillInput, "workspaceId" | "workspace_id">,
): string {
  return cleanString(input?.workspaceId) ??
    cleanString(input?.workspace_id) ??
    cleanString(c.req.query("workspaceId")) ??
    cleanString(c.req.query("workspace_id")) ??
    currentAccessToken(c)?.workspaceId ??
    "local";
}

export function sanitizeSkillFilesForCompatibility<T extends { files?: MultiremiSkillFile[] }>(input: T): T {
  if (!Array.isArray(input.files)) return input;
  return {
    ...input,
    files: input.files.filter((file) => !isReservedSkillContentPath(file.path)),
  };
}

function isReservedSkillContentPath(path: unknown): boolean {
  const rawPath = String(path ?? "").replace(/\\/g, "/");
  if (rawPath.startsWith("/")) return false;
  const cleaned = cleanRelativeSkillPath(rawPath);
  return !cleaned.startsWith("..") && cleaned.toLowerCase() === "skill.md";
}

function cleanRelativeSkillPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else {
        parts.push("..");
      }
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : ".";
}

export function skillCompatibilityErrorResponse(
  c: Context,
  error: unknown,
  options: {
    invalidPathIncludesPath?: boolean;
    duplicateImportInput?: CreateSkillInput;
    store?: MultiremiStore;
  } = {},
): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Skill not found")) return c.json({ error: "skill not found" }, 404);
  if (message.startsWith("Agent not found")) return c.json({ error: "agent not found" }, 404);
  if (message === "Skill name is required") return c.json({ error: "name is required" }, 400);
  if (message.startsWith("Invalid skill file path:")) {
    const path = message.slice("Invalid skill file path:".length).trim();
    return c.json({ error: options.invalidPathIncludesPath && path ? `invalid file path: ${path}` : "invalid file path" }, 400);
  }
  if (message === "Skill files should not include SKILL.md") {
    return c.json({ error: "SKILL.md is reserved for the primary skill content" }, 400);
  }
  if (isUniqueSkillNameError(message)) {
    if (options.duplicateImportInput && options.store) {
      const existing = existingSkillIdentityForInput(options.store, options.duplicateImportInput);
      if (existing) {
        return c.json({
          error: "a skill with this name already exists",
          existing_skill: existing,
        }, 409);
      }
    }
    return c.json({ error: "a skill with this name already exists" }, 409);
  }
  return c.json({ error: message }, 500);
}

function isUniqueSkillNameError(message: string): boolean {
  return message.includes("UNIQUE constraint failed: multiremi_skills.workspace_id, multiremi_skills.name")
    || message.includes("constraint failed") && message.includes("multiremi_skills.workspace_id") && message.includes("multiremi_skills.name");
}

function existingSkillIdentityForInput(store: MultiremiStore, input: CreateSkillInput): { id: string; name: string } | null {
  const name = input.name?.trim();
  if (!name) return null;
  const workspaceId = input.workspaceId ?? input.workspace_id ?? "local";
  const existing = store.listSkills(workspaceId, { includeFiles: false }).find((skill) => skill.name === name);
  if (!existing?.id) return null;
  return { id: existing.id, name: existing.name };
}

export function searchSkillsResponse(store: MultiremiStore, c: Context): {
  skills: Array<{
    name: string;
    description: string;
    url: string;
    source: string;
    repo: string | null;
    github_stars: number | null;
    install_count: number | null;
  }>;
} {
  const query = String(c.req.query("q") ?? "").trim().toLowerCase();
  const workspaceId = requestedSkillWorkspaceId(c);
  const limit = Math.max(1, Math.min(parseOptionalInt(c.req.query("limit")) ?? 50, 200));
  const offset = Math.max(0, parseOptionalInt(c.req.query("offset")) ?? 0);
  const skills = store.listSkills(workspaceId, { includeFiles: false })
    .filter((skill) => {
      if (!query) return true;
      return [
        skill.name,
        skill.description ?? "",
        skill.content ?? "",
      ].some((value) => value.toLowerCase().includes(query));
    })
    .slice(offset, offset + limit)
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? "",
      url: skill.id ? `local://skills/${skill.id}` : "local://skills",
      source: "local",
      repo: null,
      github_stars: null,
      install_count: null,
    }));
  return { skills };
}

export function daemonClaimSkillResponse(skill: MultiremiSkill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? "",
    content: skill.content,
    files: (skill.files ?? []).map((file) => ({
      path: file.path,
      content: file.content,
    })),
  };
}

export function skillSummary(skill: MultiremiSkill): Omit<MultiremiSkill, "content" | "files"> {
  const { content: _content, files: _files, ...summary } = skill;
  return summary;
}

export function skillSummaryCompatibilityResponse(skill: MultiremiSkill): Record<string, unknown> {
  return {
    id: skill.id,
    workspace_id: skill.workspaceId,
    name: skill.name,
    description: skill.description ?? "",
    config: skill.config ?? {},
    created_by: skill.createdBy ?? null,
    created_at: skill.createdAt,
    updated_at: skill.updatedAt,
  };
}

export function skillCompatibilityResponse(skill: MultiremiSkill): Record<string, unknown> {
  return {
    ...skillSummaryCompatibilityResponse(skill),
    content: skill.content,
  };
}

export function skillWithFilesCompatibilityResponse(skill: MultiremiSkill): Record<string, unknown> {
  return {
    ...skillCompatibilityResponse(skill),
    files: (skill.files ?? []).map(skillFileCompatibilityResponse),
  };
}

export function skillFileCompatibilityResponse(file: MultiremiSkillFile): Record<string, unknown> {
  return {
    id: file.id,
    skill_id: file.skillId,
    path: file.path,
    content: file.content,
    created_at: file.createdAt,
    updated_at: file.updatedAt,
  };
}

export function agentSkillCompatibilitySummary(skill: MultiremiSkill): Record<string, unknown> {
  return {
    id: skill.id ?? "",
    name: skill.name,
    description: skill.description ?? "",
  };
}
