/**
 * Mission queue handler — executes pipeline steps.
 * Each step loads its SKILL.md as systemPrompt and receives mission context as the user prompt.
 */

import type { Remi } from "../../core.js";
import type { MissionJobData } from "../queues.js";
import { MissionStore } from "../../mission/store.js";
import type { Mission, PipelineStep, Contract, ContractVerification } from "../../mission/model.js";
import { sendToThread } from "../../connectors/feishu/thread.js";
import { createLogger } from "../../logger.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const log = createLogger("mission");

// ── Constants ──

/** PipelineStep → pipeline/skills/ 目录名 */
const STEP_SKILL_DIR: Record<string, string> = {
  intake: "intake",
  rfc: "rfc",
  decompose: "decompose",
  execute: "execute",
  eval: "contract-eval",
  summary: "mission-summary",
};

/** PipelineStep → 输出文件名 */
const STEP_OUTPUT_FILE: Record<string, string> = {
  rfc: "RFC.md",
  decompose: "tasks.md",
  execute: "execute-log.md",
  eval: "eval-report.md",
  summary: "summary.md",
};

/** PipelineStep → 中文标签（话题通知用） */
const STEP_LABEL: Record<string, string> = {
  rfc: "RFC 技术方案",
  decompose: "任务拆解",
  execute: "代码执行",
  eval: "Contract 验证",
  summary: "总结",
};

/** 最大 eval → execute 循环次数，防止无限重试 */
const MAX_EVAL_RETRIES = 3;

// ── Main Handler ──

export async function handleMissionJob(
  job: { data: MissionJobData },
  remi: Remi,
): Promise<void> {
  const { missionId, step, attempt = 0, evalFailureInfo } = job.data;
  const store = new MissionStore();
  const mission = store.getById(missionId);

  if (!mission) {
    log.warn(`Mission ${missionId} not found, skipping`);
    return;
  }

  log.info(`Executing mission ${missionId} step: ${step} (attempt ${attempt})`);

  store.updateStep(missionId, step as PipelineStep);
  if (mission.status !== "in_progress") {
    store.updateStatus(missionId, "in_progress");
  }

  try {
    // Load SKILL.md as systemPrompt
    const systemPrompt = loadSkillContent(step as PipelineStep);

    // Build mission context as user prompt
    let prompt = buildStepPrompt(mission, step as PipelineStep);
    if (step === "execute" && evalFailureInfo) {
      prompt += `\n\n## 上次 Eval 失败详情\n以下 Contract Case 在上次验证中未通过，请修复：\n${evalFailureInfo}`;
    }

    const projectCwd = resolveProjectCwd(remi, mission.projectId);
    const sessionId = resolveSessionId(missionId, step as PipelineStep);

    const provider = remi._providers.values().next().value;
    if (!provider) throw new Error("No provider available");

    const result = await provider.send(prompt, {
      chatId: `mission-${missionId}`,
      sessionId,
      cwd: projectCwd,
      systemPrompt,
    });

    log.info(`Mission ${missionId} step ${step} completed (${result.text?.length ?? 0} chars)`);

    // Write output to file
    writeStepOutput(mission.outputDir, step as PipelineStep, result.text);

    // Notify thread (non-blocking)
    notifyThread(mission, step as PipelineStep, result.text).catch((err) =>
      log.warn(`Thread notify failed for ${missionId}: ${err}`),
    );

    // Handle eval result (pass/fail routing)
    if (step === "eval") {
      await handleEvalResult(store, mission, result.text, remi, attempt);
      return;
    }

    // Determine next step
    const nextStep = resolveNextStep(step as PipelineStep);
    if (nextStep) {
      await remi.queue.enqueueMission({ missionId, step: nextStep });
    } else {
      store.updateStatus(missionId, "in_review");
      log.info(`Mission ${missionId} pipeline complete, moved to in_review`);
    }
  } catch (err) {
    log.error(`Mission ${missionId} step ${step} failed:`, err);
    store.updateStatus(missionId, "blocked");
    store.recordFeedback(missionId, step as PipelineStep, step, "timeout", String(err));
    throw err;
  }
}

// ── Skill Loading ──

function loadSkillContent(step: PipelineStep): string | null {
  const dirName = STEP_SKILL_DIR[step];
  if (!dirName) return null;

  const skillPath = join(import.meta.dir, "../../../pipeline/skills", dirName, "SKILL.md");
  if (!existsSync(skillPath)) {
    log.warn(`Skill file not found for step ${step}: ${skillPath}`);
    return null;
  }

  let content = readFileSync(skillPath, "utf-8");
  // Strip YAML frontmatter
  const fm = content.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) content = content.slice(fm[0].length);
  return content.trim();
}

// ── Prompt Building ──

function buildStepPrompt(
  mission: { title: string; description: string | null; outputDir: string | null; contract: Contract | null },
  step: PipelineStep,
): string {
  const parts: string[] = [];

  parts.push(`# Mission: ${mission.title}`);
  if (mission.description) parts.push(`\n## 需求描述\n${mission.description}`);
  if (mission.outputDir) parts.push(`\n## 产出目录\n${mission.outputDir}`);

  // Inject contract for eval and execute steps
  if (mission.contract && (step === "eval" || step === "execute")) {
    parts.push(`\n## Contract Cases\n\`\`\`json\n${JSON.stringify(mission.contract, null, 2)}\n\`\`\``);
  }

  return parts.join("\n");
}

// ── Session Management ──

function resolveSessionId(missionId: string, step: PipelineStep): string | undefined {
  // rfc + decompose share a planning session (codebase understanding reuse)
  if (step === "rfc" || step === "decompose") return `mission-${missionId}-plan`;
  // execute gets its own session (clean context)
  if (step === "execute") return `mission-${missionId}-exec`;
  // eval, summary: fresh sessions
  return undefined;
}

// ── Output Writing ──

function writeStepOutput(outputDir: string | null, step: PipelineStep, text: string): void {
  if (!outputDir || !text) return;
  const filename = STEP_OUTPUT_FILE[step];
  if (!filename) return;

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, filename), text, "utf-8");
  log.info(`Wrote step output: ${outputDir}/${filename}`);
}

// ── Thread Notifications ──

async function notifyThread(
  mission: { chatId: string; threadId: string | null; id: string },
  step: PipelineStep,
  outputText: string,
): Promise<void> {
  if (!mission.threadId) return;

  const label = STEP_LABEL[step] ?? step;
  const summary =
    outputText.length > 2000 ? outputText.slice(0, 2000) + "\n\n> (truncated)" : outputText;

  await sendToThread(mission.chatId, mission.threadId, `**${label} 完成**\n\n${summary}`);
}

// ── Eval Result Handling ──

async function handleEvalResult(
  store: MissionStore,
  mission: Mission,
  evalText: string,
  remi: Remi,
  attempt: number,
): Promise<void> {
  // Try to extract structured verification results
  const verification = parseVerificationResults(evalText);

  if (verification) {
    const updatedContract: Contract = {
      cases: mission.contract?.cases ?? [],
      acceptanceCriteria: mission.contract?.acceptanceCriteria ?? [],
      verificationResults: verification,
    };
    store.updateContract(mission.id, JSON.stringify(updatedContract));
  }

  const allPassed = verification?.overallPassed ?? parseEvalPassed(evalText);

  if (allPassed) {
    store.updateStatus(mission.id, "in_review");
    await remi.queue.enqueueMission({ missionId: mission.id, step: "summary" });
    log.info(`Mission ${mission.id} eval passed → in_review + summary`);
  } else {
    // Check retry limit
    if (attempt >= MAX_EVAL_RETRIES) {
      store.updateStatus(mission.id, "blocked");
      store.recordFeedback(mission.id, "eval", "contract-eval", "contract_fail", `Max retries (${MAX_EVAL_RETRIES}) exceeded`);
      log.warn(`Mission ${mission.id} eval failed after ${MAX_EVAL_RETRIES} retries → blocked`);
      return;
    }

    const failureDetail = verification
      ? verification.caseResults
          .filter((r) => !r.passed)
          .map((r) => `${r.caseId}: ${r.detail}`)
          .join("; ")
      : evalText.slice(0, 500);

    store.recordFeedback(mission.id, "eval", "contract-eval", "contract_fail", failureDetail);
    await remi.queue.enqueueMission({
      missionId: mission.id,
      step: "execute",
      attempt: attempt + 1,
      evalFailureInfo: failureDetail,
    });
    log.info(`Mission ${mission.id} eval failed (attempt ${attempt}) → re-enqueue execute`);
  }
}

function parseVerificationResults(evalText: string): ContractVerification | null {
  const jsonMatch = evalText.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (parsed.caseResults && typeof parsed.overallPassed === "boolean") {
      return {
        caseResults: parsed.caseResults,
        overallPassed: parsed.overallPassed,
        verifiedAt: new Date().toISOString(),
      };
    }
  } catch {
    /* not valid JSON */
  }
  return null;
}

function parseEvalPassed(evalText: string): boolean {
  const lower = evalText.toLowerCase();
  if (lower.includes('"overallpassed": true') || lower.includes('"overall_passed": true'))
    return true;
  if (lower.includes('"overallpassed": false') || lower.includes('"overall_passed": false'))
    return false;
  if (lower.includes("全部通过") || lower.includes("all passed")) return true;
  return false;
}

// ── Helpers ──

function resolveProjectCwd(_remi: Remi, projectId: string): string {
  const { ProjectStore } = require("../../project/store.js");
  const store = new ProjectStore();
  const project = store.getById(projectId);
  return project?.cwd ?? process.env.HOME ?? "~";
}

function resolveNextStep(current: PipelineStep): PipelineStep | null {
  const flow: Record<string, PipelineStep | null> = {
    rfc: "decompose",
    decompose: "execute",
    execute: "eval",
    eval: null, // handled by handleEvalResult()
    summary: null, // pipeline complete
  };
  return flow[current] ?? null;
}
