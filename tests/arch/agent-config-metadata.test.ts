import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Enforces docs/agent-config-spec.md §4/§6: agent-template JSON metadata and
// repo-tracked SKILL.md frontmatter must be complete enough for a model to
// decide when to trigger them.

const ROOT = join(import.meta.dir, "../..");
const TEMPLATES_DIR = join(ROOT, "packages/server/src/api/agent-templates");
const SKILL_ROOTS = [".remi/pipeline/skills", "frontend/.agents/skills"];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATEGORIES = new Set([
  "Engineering",
  "Writing",
  "Product",
  "Design",
  "Communication",
  "Productivity",
  "Team",
]);
const ACCENTS = new Set(["info", "success", "warning", "primary", "secondary"]);

// Mirrors MAX_AGENT_DESCRIPTION_LENGTH in packages/server/src/api/helpers/agents.ts
const MAX_DESCRIPTION_CODEPOINTS = 255;
const INSTRUCTIONS_MIN = 200;
const INSTRUCTIONS_MAX = 4000;
const SKILL_DESCRIPTION_MIN = 20;
const SKILL_DESCRIPTION_MAX = 1024;

const codepoints = (s: string): number => Array.from(s).length;

describe("agent templates metadata", () => {
  const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));

  test("template directory is non-empty", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} follows the agent-config spec`, () => {
      const raw = JSON.parse(readFileSync(join(TEMPLATES_DIR, file), "utf8"));

      expect(raw.slug, `${file}: slug must match filename`).toBe(file.replace(/\.json$/, ""));
      expect(raw.slug, `${file}: slug must be kebab-case`).toMatch(SLUG_RE);
      expect(typeof raw.name === "string" && raw.name.trim().length > 0, `${file}: name is required`).toBe(true);

      expect(
        typeof raw.description === "string" && raw.description.trim().length > 0,
        `${file}: description is required`,
      ).toBe(true);
      expect(
        codepoints(raw.description),
        `${file}: description must be <= ${MAX_DESCRIPTION_CODEPOINTS} codepoints`,
      ).toBeLessThanOrEqual(MAX_DESCRIPTION_CODEPOINTS);

      expect(CATEGORIES.has(raw.category), `${file}: category "${raw.category}" not in allowed set`).toBe(true);
      expect(ACCENTS.has(raw.accent), `${file}: accent "${raw.accent}" not in allowed set`).toBe(true);
      expect(
        typeof raw.icon === "string" && raw.icon.trim().length > 0,
        `${file}: icon (lucide name) is required`,
      ).toBe(true);

      expect(typeof raw.instructions, `${file}: instructions is required`).toBe("string");
      expect(
        raw.instructions.length,
        `${file}: instructions shorter than ${INSTRUCTIONS_MIN} chars — see six-part skeleton in docs/agent-config-spec.md §2`,
      ).toBeGreaterThanOrEqual(INSTRUCTIONS_MIN);
      expect(
        raw.instructions.length,
        `${file}: instructions longer than ${INSTRUCTIONS_MAX} chars — move reusable manuals into a skill`,
      ).toBeLessThanOrEqual(INSTRUCTIONS_MAX);
      // Real newlines only — catches prompts stored as JSON-escaped strings.
      expect(
        raw.instructions.includes("\\n") && !raw.instructions.includes("\n"),
        `${file}: instructions looks like an escaped JSON string (literal \\n, no real newlines)`,
      ).toBe(false);

      for (const skill of raw.skills ?? []) {
        expect(
          typeof skill.source_url === "string" && skill.source_url.startsWith("https://"),
          `${file}: skills[].source_url must be https`,
        ).toBe(true);
        expect(
          typeof skill.cached_name === "string" && SLUG_RE.test(skill.cached_name),
          `${file}: skills[].cached_name must be kebab-case`,
        ).toBe(true);
        expect(
          typeof skill.cached_description === "string" && skill.cached_description.trim().length > 0,
          `${file}: skills[].cached_description is required`,
        ).toBe(true);
      }
    });
  }
});

describe("Atlas Wiki maintenance contract", () => {
  const atlas = JSON.parse(
    readFileSync(join(TEMPLATES_DIR, "atlas-llm-wiki.json"), "utf8"),
  ) as { instructions: string };

  test("uses the six-part agent prompt skeleton", () => {
    expect(atlas.instructions).toStartWith("You are Atlas");
    for (const heading of [
      "## Responsibilities and boundaries",
      "## Prohibited actions",
      "## Tools and CLI conventions",
      "## Deliverable shape",
      "## When to stop and ask",
    ]) {
      expect(atlas.instructions, `missing Atlas prompt section: ${heading}`).toContain(heading);
    }
  });

  test("keeps link identity and publication validation explicit", () => {
    expect(atlas.instructions).toContain("Project Wiki links use stable slugs");
    expect(atlas.instructions).toContain("repository-root-relative canonical path");
    expect(atlas.instructions).toContain("same-directory short reference");
    expect(atlas.instructions).toContain("enumerate every inbound link");
    expect(atlas.instructions).toContain("Repository Wiki publishing validates the complete final repository link graph");
  });

  test("does not direct Atlas to deprecated or unsafe one-step commands", () => {
    expect(atlas.instructions).not.toContain("remi wiki lint");
    expect(atlas.instructions).not.toContain("remi wiki merge");
  });
});

interface Frontmatter {
  name: string | null;
  description: string | null;
}

// Intentionally minimal line-based parsing: the spec requires name/description
// to be single-line plain scalars, the only form all three in-repo frontmatter
// parsers (skill-import.ts, local-skills.ts, gray-matter) agree on.
function parseFrontmatter(markdown: string): Frontmatter | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return null;
  const block = lines.slice(1, end);
  const get = (key: string): string | null => {
    const line = block.find((l) => l.startsWith(`${key}:`));
    if (!line) return null;
    return line
      .slice(key.length + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  };
  return { name: get("name"), description: get("description") };
}

describe("repo-tracked SKILL.md frontmatter", () => {
  const skillDirs: Array<{ root: string; dir: string }> = [];
  for (const root of SKILL_ROOTS) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs)) {
      if (statSync(join(abs, entry)).isDirectory()) skillDirs.push({ root, dir: entry });
    }
  }

  test("at least one skill root exists", () => {
    expect(skillDirs.length).toBeGreaterThan(0);
  });

  for (const { root, dir } of skillDirs) {
    const rel = `${root}/${dir}`;
    test(`${rel} has a spec-compliant SKILL.md`, () => {
      const skillPath = join(ROOT, root, dir, "SKILL.md");
      expect(existsSync(skillPath), `${rel}: SKILL.md is required`).toBe(true);

      const fm = parseFrontmatter(readFileSync(skillPath, "utf8"));
      expect(fm, `${rel}: SKILL.md must start with a --- frontmatter block`).not.toBeNull();

      expect(fm!.name, `${rel}: frontmatter name must equal directory name`).toBe(dir);
      expect(dir, `${rel}: directory name must be kebab-case`).toMatch(SLUG_RE);

      const description = fm!.description;
      expect(
        description !== null && description.length > 0,
        `${rel}: description is required (single-line, states what it does + when to trigger)`,
      ).toBe(true);
      expect(
        codepoints(description!),
        `${rel}: description must be >= ${SKILL_DESCRIPTION_MIN} codepoints — state what it does AND when to use it`,
      ).toBeGreaterThanOrEqual(SKILL_DESCRIPTION_MIN);
      expect(
        codepoints(description!),
        `${rel}: description must be <= ${SKILL_DESCRIPTION_MAX} codepoints`,
      ).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);
      expect(description!, `${rel}: description must not be a block scalar (single line only)`).not.toMatch(/^[|>]/);
    });
  }
});
