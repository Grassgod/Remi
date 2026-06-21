import { createHash } from "node:crypto";
import contractEval from "../../pipeline/skills/contract-eval/SKILL.md" with { type: "text" };
import dailyChangelog from "../../pipeline/skills/daily-changelog/SKILL.md" with { type: "text" };
import execute from "../../pipeline/skills/execute/SKILL.md" with { type: "text" };
import intake from "../../pipeline/skills/intake/SKILL.md" with { type: "text" };
import missionSummary from "../../pipeline/skills/mission-summary/SKILL.md" with { type: "text" };
import releaseNotes from "../../pipeline/skills/release-notes/SKILL.md" with { type: "text" };
import rfc from "../../pipeline/skills/rfc/SKILL.md" with { type: "text" };
import type { CreateSkillInput, MultiremiSkill } from "./types.js";
import type { MultiremiStore } from "./store.js";

type BuiltinSkillSource = {
  slug: string;
  sourcePath: string;
  content: string;
};

export const REMI_BUILTIN_SKILL_SOURCES: BuiltinSkillSource[] = [
  { slug: "contract-eval", sourcePath: "pipeline/skills/contract-eval/SKILL.md", content: contractEval },
  { slug: "daily-changelog", sourcePath: "pipeline/skills/daily-changelog/SKILL.md", content: dailyChangelog },
  { slug: "execute", sourcePath: "pipeline/skills/execute/SKILL.md", content: execute },
  { slug: "intake", sourcePath: "pipeline/skills/intake/SKILL.md", content: intake },
  { slug: "mission-summary", sourcePath: "pipeline/skills/mission-summary/SKILL.md", content: missionSummary },
  { slug: "release-notes", sourcePath: "pipeline/skills/release-notes/SKILL.md", content: releaseNotes },
  { slug: "rfc", sourcePath: "pipeline/skills/rfc/SKILL.md", content: rfc },
];

export function buildRemiBuiltinSkillInputs(options: {
  workspaceId?: string | null;
  createdBy?: string | null;
} = {}): Array<CreateSkillInput & { id: string }> {
  const workspaceId = options.workspaceId ?? "local";
  return REMI_BUILTIN_SKILL_SOURCES.map((source) => {
    const metadata = parseSkillFrontmatter(source.content);
    return {
      id: `skl_remi_builtin_${source.slug.replace(/[^a-z0-9]+/g, "_")}`,
      workspaceId,
      name: metadata.name || source.slug,
      description: metadata.description,
      content: source.content,
      files: [],
      createdBy: options.createdBy ?? null,
      config: {
        origin: {
          type: "remi_builtin",
          slug: source.slug,
          source_path: source.sourcePath,
          content_sha256: createHash("sha256").update(source.content).digest("hex"),
        },
      },
    };
  });
}

export function seedRemiBuiltinSkills(
  store: MultiremiStore,
  options: { workspaceId?: string | null; createdBy?: string | null } = {},
): MultiremiSkill[] {
  return buildRemiBuiltinSkillInputs(options).map((input) => store.upsertSkill(input));
}

function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: "", description: "" };
  const metadata: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    metadata[key] = value;
  }
  return {
    name: metadata.name ?? "",
    description: metadata.description ?? "",
  };
}
