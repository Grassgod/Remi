/**
 * Per-task skill materialization.
 *
 * The skill root is runtime-specific: claude reads `.claude/skills`, while
 * codex-acp only ever registers `<root>/.agents/skills`
 * (refreshSkills → skills/extraRoots/set, codex-acp dist/index.js:26718-26731)
 * and never looks at `.claude/skills` — writing there for a codex task means
 * the agent silently runs with no skills at all.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportedSlashCommands, syncAgentSkills, writeAgentSkillContext, writeTaskContext } from "@daemon/agent-runtime/skills/ephemeral.js";
import { skillCommandName, type ObservedSlashCommand } from "@multiremi/contracts/slash-commands.js";
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

test.each(["claude", "codex"])("%s materializes binary Skill attachments byte for byte", (provider) => {
  const task = taskWithSkill(provider);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
  task.agent!.skills[0]!.files!.push({ path: "references/preview.png", encoding: "base64", content: bytes.toString("base64") });
  const workDir = workspace();
  writeAgentSkillContext(workDir, task);
  const root = provider === "codex" ? ".agents" : ".claude";
  expect(readFileSync(join(workDir, root, "skills", "deploy-runbook", "references", "preview.png"))).toEqual(bytes);
});

test("rejects malformed binary Skill payloads instead of silently corrupting attachments", () => {
  for (const file of [
    { path: "invalid.png", encoding: "base64", content: "%%%" },
    { path: "invalid.png", encoding: "hex", content: "89504e47" },
    { path: "invalid.png", encoding: null, content: "89504e47" },
    { path: "invalid.png", encoding: "base64", content: null },
    { path: "invalid.png", encoding: "base64" },
  ]) {
    const task = taskWithSkill("codex");
    task.agent!.skills[0]!.files = [file as any];
    expect(() => writeAgentSkillContext(workspace(), task)).toThrow(/skill file/i);
  }
});

function withSkills(skills: Array<{ name: string; description?: string; content: string }>): AgentTask {
  const task = taskWithSkill("claude");
  task.agent!.skills = skills.map((skill) => ({ files: [], ...skill }));
  return task;
}

test("ADR 0025: the SKILL.md name is the directory name, the one `/name` invokes", () => {
  const workDir = workspace();
  writeAgentSkillContext(workDir, taskWithSkill("claude"));
  expect(readFileSync(join(workDir, ".claude", "skills", "deploy-runbook", "SKILL.md"), "utf-8"))
    .toBe('---\nname: "deploy-runbook"\ndescription: "How to deploy"\n---\nstep one\n');
});

test("ADR 0025: a non-ASCII name gets its own directory and stays readable in the description", () => {
  const root = join(workspace(), "skills");
  syncAgentSkills(root, withSkills([
    { name: "代码审查", description: "审查代码改动", content: "review\n" },
    { name: "部署", content: "deploy\n" },
  ]));
  const review = skillCommandName("代码审查");
  const deploy = skillCommandName("部署");
  expect(review).not.toBe(deploy);
  expect(readFileSync(join(root, review, "SKILL.md"), "utf-8"))
    .toBe(`---\nname: "${review}"\ndescription: "代码审查 — 审查代码改动"\n---\nreview\n`);
  expect(readFileSync(join(root, deploy, "SKILL.md"), "utf-8")).toBe(`---\nname: "${deploy}"\ndescription: "部署"\n---\ndeploy\n`);
  expect(JSON.parse(readFileSync(join(root, ".remi-skills.json"), "utf-8"))).toEqual({ skills: [review, deploy] });
});

test("ADR 0025: a body with its own frontmatter keeps the author's name", () => {
  const root = join(workspace(), "skills");
  const content = "---\nname: Custom Name\ndescription: mine\n---\nbody\n";
  syncAgentSkills(root, withSkills([{ name: "Custom Name", content }]));
  expect(readFileSync(join(root, "custom-name", "SKILL.md"), "utf-8")).toBe(content);
});

test("ADR 0025: the next sync rewrites skills installed before, and moves a non-ASCII one out of the shared `skill` directory", () => {
  const root = join(workspace(), "skills");
  // As an earlier daemon left them: the display name in `name`, and every non-ASCII name in `skill`.
  mkdirSync(join(root, "review"), { recursive: true });
  writeFileSync(join(root, "review", "SKILL.md"), '---\nname: "Review"\ndescription: "Review skill"\n---\n# Review');
  mkdirSync(join(root, "skill"), { recursive: true });
  writeFileSync(join(root, "skill", "SKILL.md"), '---\nname: "部署"\n---\ndeploy\n');
  writeFileSync(join(root, ".remi-skills.json"), `${JSON.stringify({ skills: ["review", "skill"] })}\n`);

  syncAgentSkills(root, withSkills([
    { name: "Review", description: "Review skill", content: "# Review" },
    { name: "部署", content: "deploy\n" },
  ]));
  const deploy = skillCommandName("部署");
  expect(readFileSync(join(root, "review", "SKILL.md"), "utf-8")).toBe('---\nname: "review"\ndescription: "Review skill"\n---\n# Review');
  expect(existsSync(join(root, "skill"))).toBe(false);
  expect(readFileSync(join(root, deploy, "SKILL.md"), "utf-8")).toBe(`---\nname: "${deploy}"\ndescription: "部署"\n---\ndeploy\n`);
  expect(JSON.parse(readFileSync(join(root, ".remi-skills.json"), "utf-8"))).toEqual({ skills: ["review", deploy] });
});

test("ADR 0025: syncAgentSkills returns the directories Remi installed, not the ones it left alone", () => {
  const root = join(workspace(), "skills");
  mkdirSync(join(root, "review"), { recursive: true });
  writeFileSync(join(root, "review", "SKILL.md"), "someone else's");
  expect(syncAgentSkills(root, withSkills([
    { name: "Review", content: "r" }, { name: "Deploy", content: "d" },
  ]))).toEqual(["deploy"]);
  expect(syncAgentSkills(root, withSkills([]))).toEqual([]);
});

describe("ADR 0025: reportedSlashCommands", () => {
  const observed = (name: string, extra: Partial<ObservedSlashCommand> = {}): ObservedSlashCommand =>
    ({ name, description: `${name} help`, hint: null, kind: "command", skillDir: null, ...extra });
  const skills = [
    { id: "skl_deploy", name: "Deploy Prod", content: "deploy" },
    { id: "skl_review", name: "Review", content: "review" },
    { id: "skl_own", name: "Own", content: "---\nname: \"author-name\"\ndescription: mine\n---\nbody" },
    { id: "skl_absent", name: "Absent", content: "x" },
    { name: "No Id", content: "x" },
  ];
  const installed = ["deploy-prod", "review", "own", "no-id"];

  test("Claude: a command named like an installed Remi skill is that skill", () => {
    expect(reportedSlashCommands("claude", [
      observed("compact", { hint: "<instructions>" }),
      observed("deploy-prod"),
      observed("author-name"),
      observed("absent"),
      observed("no-id"),
      observed("$review"),
    ], skills, installed)).toEqual([
      { name: "compact", description: "compact help", hint: "<instructions>", kind: "command" },
      { name: "deploy-prod", description: "deploy-prod help", hint: null, kind: "skill", skill_id: "skl_deploy" },
      { name: "author-name", description: "author-name help", hint: null, kind: "skill", skill_id: "skl_own" },
      { name: "absent", description: "absent help", hint: null, kind: "command" },
      { name: "no-id", description: "no-id help", hint: null, kind: "command" },
      { name: "$review", description: "$review help", hint: null, kind: "command" },
    ]);
  });

  test("Codex: only a `$` name is a skill, so the built-in /review stays a command", () => {
    expect(reportedSlashCommands("codex", [observed("review"), observed("$review", { kind: "skill" }), observed("$deploy-prod", { kind: "skill" })],
      skills, installed).map((entry) => [entry.name, entry.kind, entry.skill_id ?? null])).toEqual([
      ["review", "command", null],
      ["$review", "skill", "skl_review"],
      ["$deploy-prod", "skill", "skl_deploy"],
    ]);
  });

  test("a SKILL.md directory decides over the name, and a skill Remi did not install is never tagged", () => {
    expect(reportedSlashCommands("claude", [
      observed("renamed", { kind: "skill", skillDir: "review" }),
      observed("absent", { kind: "skill", skillDir: "absent" }),
    ], skills, installed).map((entry) => [entry.name, entry.kind, entry.skill_id ?? null])).toEqual([
      ["renamed", "skill", "skl_review"],
      ["absent", "skill", null],
    ]);
    expect(reportedSlashCommands("claude", [observed("deploy-prod")], skills, [])[0]).not.toHaveProperty("skill_id");
  });
});

test("task context refresh preserves a Feishu topic binding dossier", () => {
  const workDir = workspace();
  const metadataDir = join(workDir, ".multiremi");
  mkdirSync(metadataDir, { recursive: true });
  const topicBinding = {
    version: 1,
    kind: "feishu_topic_issue",
    topic_id: "om_1",
    session_key: "chat:thread:om_1",
  };
  writeFileSync(join(metadataDir, "task.json"), JSON.stringify({ topic_binding: topicBinding }));

  writeTaskContext(workDir, {
    id: "tsk_1",
    workspaceId: "ws_1",
    agent: null,
    issue: { id: "iss_1", key: "MUL-1", title: "Topic Issue" },
    project: null,
    projectContexts: [],
    projectResources: [],
    repos: [],
    prompt: "Continue the topic",
  } as unknown as AgentTask);

  expect(JSON.parse(readFileSync(join(metadataDir, "task.json"), "utf8"))).toMatchObject({
    task_id: "tsk_1",
    topic_binding: topicBinding,
  });
});
