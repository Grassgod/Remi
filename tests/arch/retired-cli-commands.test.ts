import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { RETIRED_CLI_COMMANDS } from "../../apps/remi/cli/core/retired-commands.js";

const root = resolve(import.meta.dir, "../..");
const paths = [
  "packages/contracts/src/artifact-delivery.ts", "packages/server/src/prompts/workspace-settings.ts",
  "packages/server/src/store/session-projection.ts", "packages/server/src/store/task-wait-reason.ts", "AGENTS.md",
  "packages/contracts/src/session-input.ts", "packages/server/src/store/task-session-input.ts",
  ...["chats-and-tasks", "issues-and-sessions", "automation-and-tasks", "workbench"].map((f) => `.agents/skills/remi/references/${f}.md`),
  ...["cli-command-migration", "chat", "feishu-topic-replies", "parallel-agent-execution", "task-progress-summary", "scheduled-targets", "issue-key-results", "dev/runtime-workspaces", "dev/performance"].map((f) => `docs/${f}.md`),
  ...readdirSync(resolve(root, "packages/server/src/api/agent-templates")).filter((f) => f.endsWith(".json")).map((f) => `packages/server/src/api/agent-templates/${f}`),
];

export function retiredReferences(path: string, content: string): string[] {
  // ADRs retain historical decisions. The migration guide's exception is table rows only.
  if (path.startsWith("docs/adr/")) return [];
  let retiredTable = false;
  const violations: string[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (line.startsWith("## ")) retiredTable = path === "docs/cli-command-migration.md" && line.startsWith("## Retired in ");
    if (retiredTable && line.startsWith("|")) continue;
    for (const command of Object.keys(RETIRED_CLI_COMMANDS)) {
      const escaped = command.split(" ").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      if (new RegExp(`\\bremi\\s+(?:multiremi\\s+)?${escaped}(?![\\w-])`).test(line)) violations.push(`${path}:${index + 1}: ${command}`);
    }
  }
  return violations;
}

describe("retired CLI command guard", () => {
  it("keeps S4 prompts, templates, skills and current documents free of retired commands", () => {
    expect(paths.flatMap((path) => retiredReferences(path, readFileSync(resolve(root, path), "utf8")))).toEqual([]);
  });
  it("allows only retired table rows and historical ADR text", () => {
    const sample = "remi task create --prompt x";
    expect(retiredReferences("docs/adr/example.md", sample)).toEqual([]);
    expect(retiredReferences("docs/cli-command-migration.md", `## Retired in next\n| ${sample} | replacement |`)).toEqual([]);
    expect(retiredReferences("docs/cli-command-migration.md", `## Retired in next\n${sample}`)).toHaveLength(1);
    expect(retiredReferences("docs/cli-command-migration.md", `## Retired in next\n| old | new |\n## Current\n| ${sample} |`)).toHaveLength(1);
    expect(retiredReferences("prompt.ts", sample)).toHaveLength(1);
    expect(retiredReferences("prompt.ts", "remi multiremi task create --prompt x")).toHaveLength(1);
    expect(retiredReferences("prompt.ts", "remi message send --content 'task create'")).toEqual([]);
  });
});
