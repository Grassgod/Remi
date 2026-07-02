// Pure Go-compatibility serializers for skills. Extracted from api.ts (D-refactor):
// these map store domain objects to the wire shape the frontend/API expects. They
// depend only on contract types (no request context, no store, no shared state),
// which keeps this a leaf module that api.ts and future route sub-modules can import
// without introducing a cycle.
import type { MultiremiSkill, MultiremiSkillFile } from "@multiremi/contracts/types.js";

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
