/**
 * Per-task skill materialization.
 *
 * The skill root is runtime-specific: claude reads `.claude/skills`, while
 * codex-acp only ever registers `<root>/.agents/skills`
 * (refreshSkills → skills/extraRoots/set, codex-acp dist/index.js:26718-26731)
 * and never looks at `.claude/skills` — writing there for a codex task means
 * the agent silently runs with no skills at all.
 */

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAgentSkillContext } from "@daemon/agent-runtime/skills/ephemeral.js";
import type { AgentTask } from "@daemon/contracts/types.js";

function taskWithSkill(provider: string): AgentTask {
  return {
    agent: {
      id: "agt_1",
      name: "Agent",
      provider,
      model: null,
      instructions: "",
      cwd: null,
      executable: null,
      allowedTools: [],
      customEnv: {},
      skills: [
        {
          name: "Deploy Runbook",
          description: "How to deploy",
          content: "step one\n",
          files: [{ path: "scripts/check.sh", content: "echo ok\n" }],
        },
      ],
    },
  } as unknown as AgentTask;
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "skills-ephemeral-"));
}

test("claude tasks materialize skills into .claude/skills", () => {
  const workDir = workspace();
  writeAgentSkillContext(workDir, taskWithSkill("claude"));

  const skillFile = join(workDir, ".claude", "skills", "deploy-runbook", "SKILL.md");
  expect(readFileSync(skillFile, "utf-8")).toContain("step one");
  expect(readFileSync(join(workDir, ".claude", "skills", "deploy-runbook", "scripts", "check.sh"), "utf-8")).toBe("echo ok\n");
  expect(existsSync(join(workDir, ".agents", "skills"))).toBe(false);
});

test("codex tasks materialize skills into .agents/skills — the only root codex-acp registers", () => {
  const workDir = workspace();
  writeAgentSkillContext(workDir, taskWithSkill("codex"));

  const skillFile = join(workDir, ".agents", "skills", "deploy-runbook", "SKILL.md");
  expect(readFileSync(skillFile, "utf-8")).toContain("step one");
  expect(readFileSync(join(workDir, ".agents", "skills", "deploy-runbook", "scripts", "check.sh"), "utf-8")).toBe("echo ok\n");
  expect(existsSync(join(workDir, ".claude", "skills"))).toBe(false);
});

test("an agent without skills writes no skill root at all", () => {
  const workDir = workspace();
  writeAgentSkillContext(workDir, { agent: { skills: [], provider: "codex" } } as unknown as AgentTask);
  expect(existsSync(join(workDir, ".agents"))).toBe(false);
  expect(existsSync(join(workDir, ".claude"))).toBe(false);
});
