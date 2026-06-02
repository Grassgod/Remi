/**
 * Mission queue handler — pipeline step execution.
 *
 * All steps (intake through summary) go through BunQueue.
 * Each step sends a normal user message to the mission's Feishu thread,
 * instructing the CLI to read and follow the corresponding SKILL.md.
 * This reuses the thread's existing CLI session — no new process per step.
 */

import type { Remi } from "../../core.js";
import type { MissionJobData } from "../queues.js";
import { MissionStore } from "../../mission/store.js";
import type { Mission, PipelineStep, Contract } from "../../mission/model.js";
import type { AgentResponse } from "../../providers/base.js";
import { sendToThread } from "@remi/feishu-channel";
import { loadConfig } from "../../config.js";
import { insertConversationProcessing, completeConversation } from "../../db/index.js";
import { createLogger } from "../../logger.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const log = createLogger("mission");

// ── Constants ──

/** PipelineStep → pipeline/skills/ 目录名 */
const STEP_SKILL_DIR: Record<string, string> = {
  intake: "intake",
  rfc: "rfc",
  execute: "execute",
  eval: "contract-eval",
  summary: "mission-summary",
};

/** PipelineStep → 输出文件名 */
const STEP_OUTPUT_FILE: Record<string, string> = {
  intake: "description.md",
  rfc: "RFC.md",
  execute: "execute-log.md",
  eval: "eval-report.md",
  summary: "summary.md",
};

/** PipelineStep → 中文标签 */
const STEP_LABEL: Record<string, string> = {
  intake: "需求澄清",
  rfc: "RFC 技术方案 + 任务拆解",
  execute: "代码执行",
  eval: "Contract 验证",
  summary: "总结",
};

/** Step flow: current → next */
const STEP_FLOW: Record<string, PipelineStep | null> = {
  intake: null,     // intake → approval card, not auto-advance
  rfc: "execute",   // rfc now includes task decomposition, goes straight to execute
  execute: "eval",
  eval: null,       // eval → model calls mission-advance script
  summary: null,    // pipeline complete
};

// ── Main Handler ──

export async function handleMissionJob(
  job: { data: MissionJobData },
  remi: Remi,
): Promise<void> {
  const { missionId, step, attempt = 0, evalFailureInfo, userMessage } = job.data;
  const store = new MissionStore();
  const mission = store.getById(missionId);

  if (!mission) {
    log.warn(`Mission ${missionId} not found, skipping`);
    return;
  }

  log.info(`Executing mission ${missionId} step: ${step} (attempt ${attempt})`);

  store.updateStep(missionId, step as PipelineStep);
  // Intake stays "inbox"; summary keeps "done"; other post-intake steps go "in_progress"
  if (step !== "intake" && step !== "summary" && mission.status !== "in_progress") {
    store.updateStatus(missionId, "in_progress");
  }

  try {
    // ── 1. Build prompt (user message that instructs CLI to use skill) ──
    const label = STEP_LABEL[step] ?? step;
    let prompt: string;

    if (userMessage && step === "intake") {
      // Intake first message: wrap user's original message with skill guidance
      prompt = buildPipelinePrompt(mission, step as PipelineStep, evalFailureInfo);
      prompt += `\n\n## 用户原始消息\n${userMessage}`;
    } else if (userMessage) {
      // Other multi-turn: user's reply is the prompt directly
      prompt = userMessage;
    } else {
      prompt = buildPipelinePrompt(mission, step as PipelineStep, evalFailureInfo);
    }

    // ── 2. Stream to Feishu thread (normal chat flow, reuses thread session) ──
    let result: AgentResponse;
    const feishu = remi.getFeishuConnector();

    if (mission.chatId && mission.threadId && feishu) {
      // Send stage label (only for first message of a step, not multi-turn replies)
      if (!userMessage) {
        try {
          await sendToThread(loadConfig().feishu, mission.chatId, mission.threadId, `── **${label}** ──`);
        } catch (err) {
          log.warn(`Failed to send stage label for ${missionId}/${step}: ${err}`);
        }
      }

      // Normal IncomingMessage — no special metadata, reuses thread's existing session
      const incoming: import("../../connectors/base.js").IncomingMessage = {
        text: prompt,
        chatId: mission.chatId,
        sender: "mission-pipeline",
        connectorName: "feishu",
        metadata: {
          rootId: mission.threadId,
          chatType: "group",
        },
      };
      const streamResult = await feishu.streamToThread(incoming, mission.chatId, mission.threadId);
      result = streamResult ?? { text: "[No response]" } as AgentResponse;
    } else {
      // Fallback: no Feishu, blocking send
      const provider = remi._providers.values().next().value;
      if (!provider) throw new Error("No provider available");
      result = await provider.send(prompt, {
        chatId: `mission-${missionId}`,
      });
    }

    log.info(`Mission ${missionId} step ${step} completed (${result.text?.length ?? 0} chars)`);

    // ── 3. Record conversation + accumulate stats ──
    recordMissionConversation(mission, step as PipelineStep, prompt, result);
    if (result.inputTokens || result.outputTokens || result.costUsd || result.durationMs) {
      try {
        const { getDb } = await import("../../db/index.js");
        const db = getDb();
        db.run(
          `UPDATE missions SET
            total_tokens = total_tokens + ?,
            total_cost = total_cost + ?,
            total_duration = total_duration + ?,
            updated_at = ?
          WHERE id = ?`,
          [
            (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
            result.costUsd ?? 0,
            result.durationMs ?? 0,
            new Date().toISOString(),
            missionId,
          ],
        );
      } catch {}
    }

    // ── 4. Write output file ──
    writeStepOutput(mission.outputDir, step as PipelineStep, result.text);

    // ── 5. Validate output ──
    if (step !== "eval" && step !== "intake") {
      const outFile = STEP_OUTPUT_FILE[step];
      if (outFile && mission.outputDir && !existsSync(join(mission.outputDir, outFile))) {
        log.warn(`Mission ${missionId} step ${step} did not produce expected output: ${outFile}`);
      }
    }

    // ── 6. Step-specific post-processing ──

    if (step === "intake") {
      if (mission.outputDir && existsSync(join(mission.outputDir, "description.md"))) {
        try {
          const { sendApprovalCard } = await import("../../mission/approval.js");
          const updated = store.getById(missionId);
          if (updated) await sendApprovalCard(updated);
          log.info(`Mission ${missionId} intake complete → sent approval card`);
        } catch (err) {
          log.warn(`Failed to send approval card for ${missionId}: ${err}`);
        }
      }
      return;
    }

    if (step === "eval") {
      // Check if mission-advance was called (status would be in_review or blocked)
      const postEval = store.getById(missionId);
      if (postEval && postEval.status === "in_progress") {
        // mission-advance was NOT called — auto-detect verdict
        let passed = false;
        let detected = false;

        // 1. Prefer eval-verdict file (structured, reliable)
        const verdictPath = mission.outputDir ? join(mission.outputDir, "eval-verdict") : null;
        if (verdictPath && existsSync(verdictPath)) {
          const verdict = readFileSync(verdictPath, "utf-8").trim().toUpperCase();
          passed = verdict === "PASS";
          detected = true;
          log.info(`Mission ${missionId} eval-verdict file: ${verdict}`);
        }

        // 2. Fallback: parse eval-report.md (legacy compat)
        if (!detected) {
          const evalReportPath = mission.outputDir ? join(mission.outputDir, "eval-report.md") : null;
          if (evalReportPath && existsSync(evalReportPath)) {
            const report = readFileSync(evalReportPath, "utf-8");
            passed = /[结結]果[\s\S]{0,30}PASS|PASS[\s\S]{0,60}通过率/i.test(report) && !/FAIL/i.test(report);
            detected = true;
          }
        }

        if (!detected) {
          log.info(`Mission ${missionId} eval step completed, no verdict found — awaiting mission-advance`);
        } else if (passed) {
          log.warn(`Mission ${missionId} eval PASSED — auto-advancing to in_review`);
          store.updateStatus(missionId, "in_review");
        } else {
          // Max retry guard
          const MAX_EVAL_RETRIES = 3;
          if (attempt >= MAX_EVAL_RETRIES) {
            log.error(`Mission ${missionId} eval failed ${attempt} times — blocking`);
            store.updateStatus(missionId, "blocked");
          } else {
            log.warn(`Mission ${missionId} eval FAILED (attempt ${attempt}) — retrying execute`);
            await remi.queue.enqueueMission({ missionId, step: "execute", attempt: attempt + 1 });
          }
        }
      } else {
        log.info(`Mission ${missionId} eval step completed, mission-advance already called (status: ${postEval?.status})`);
      }
      return;
    }

    // Other steps: auto-advance to next
    const nextStep = STEP_FLOW[step];
    if (nextStep) {
      await remi.queue.enqueueMission({ missionId, step: nextStep, attempt });
    } else {
      const current = store.getById(missionId);
      if (current?.status !== "done") {
        store.updateStatus(missionId, "in_review");
        log.info(`Mission ${missionId} pipeline complete → in_review`);
      }
    }
  } catch (err) {
    log.error(`Mission ${missionId} step ${step} failed:`, err);
    store.updateStatus(missionId, "blocked");
    store.recordFeedback(missionId, step as PipelineStep, step, "timeout", String(err));
    throw err;
  }
}

// ── Prompt Building ──

/**
 * Build a user message that instructs the CLI to read and follow the pipeline skill.
 * All context (mission info, pipeline config, constraints) is embedded in the message,
 * so no append-system-prompt is needed.
 */
function buildPipelinePrompt(
  mission: { title: string; description: string | null; outputDir: string | null; contract: Contract | null; id: string; projectId: string },
  step: PipelineStep,
  evalFailureInfo?: string,
): string {
  const skillDir = STEP_SKILL_DIR[step];
  const label = STEP_LABEL[step] ?? step;
  const skillPath = resolve(import.meta.dir, `../../../pipeline/skills/${skillDir}/SKILL.md`);
  const outputFile = STEP_OUTPUT_FILE[step] ? `${mission.outputDir}/${STEP_OUTPUT_FILE[step]}` : null;

  const parts: string[] = [];

  // Skill instruction
  parts.push(`请阅读文件 ${skillPath}，严格遵循其中的指示完成 Mission Pipeline 的「${label}」阶段。`);

  // Mission context
  parts.push(`\n# Mission: ${mission.title}`);
  parts.push(`## Mission ID\n${mission.id}`);
  if (mission.description) parts.push(`## 需求描述\n${mission.description}`);
  if (mission.outputDir) parts.push(`## 产出目录\n${mission.outputDir}`);

  // Output file constraint
  if (outputFile) {
    parts.push(`\n**重要**：本阶段的产出文件必须写到 ${outputFile}，不要写到其他位置。`);
  }

  // Contract for eval and execute steps
  if (mission.contract && (step === "eval" || step === "execute")) {
    parts.push(`\n## Contract Cases\n\`\`\`json\n${JSON.stringify(mission.contract, null, 2)}\n\`\`\``);
  }

  // Eval failure info for execute retries
  if (step === "execute" && evalFailureInfo) {
    parts.push(`\n## 上次 Eval 失败详情\n${evalFailureInfo}`);
  }

  // Inject project config for code-touching steps and eval (for MR creation)
  if (step === "rfc" || step === "execute" || step === "eval") {
    if (step === "rfc" || step === "execute") {
      parts.push(`\n必须先创建 git worktree 隔离工作区，再进行任何代码探索或修改。不要在主分支上直接工作。`);
    }
    try {
      const { ProjectStore } = require("../../project/store.js");
      const project = new ProjectStore().getById(mission.projectId);
      const pc = project?.pipelineConfig as any;
      if (pc?.pipeline?.releaseBranch) parts.push(`MR 目标分支: ${pc.pipeline.releaseBranch}`);
      if (step === "rfc" || step === "execute") {
        if (pc?.pipeline?.testCommand) parts.push(`测试命令: ${pc.pipeline.testCommand}`);
        if (pc?.pipeline?.lintCommand) parts.push(`Lint 命令: ${pc.pipeline.lintCommand}`);
      }
      if (project?.repoUrl) parts.push(`仓库地址: ${project.repoUrl}`);
    } catch {}
  }

  // Automation constraint (no user interaction for non-intake steps)
  if (step !== "intake") {
    parts.push(`\n此阶段完全自动化。禁止使用 AskUserQuestion。禁止使用 EnterPlanMode。所有决策自主完成。`);
  }

  return parts.join("\n");
}

// ── Conversation Recording ──

function recordMissionConversation(
  mission: Mission,
  step: PipelineStep,
  userPrompt: string,
  result: { text: string; model?: string | null; inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null; durationMs?: number | null; sessionId?: string | null },
): void {
  try {
    const convId = insertConversationProcessing({
      chatId: mission.chatId,
      senderId: "remi",
      connector: "mission-pipeline",
      threadId: mission.threadId ?? undefined,
      userMessage: userPrompt,
      sessionKey: `${mission.chatId}:thread:${mission.threadId ?? mission.id}`,
      cliSessionId: result.sessionId ?? undefined,
    });

    completeConversation({
      id: convId,
      model: result.model ?? undefined,
      inputTokens: result.inputTokens ?? undefined,
      outputTokens: result.outputTokens ?? undefined,
      costUsd: result.costUsd ?? undefined,
      durationMs: result.durationMs ?? undefined,
      cliRoundEnd: new Date().toISOString(),
    });
  } catch (err) {
    log.warn(`Failed to record mission conversation: ${err}`);
  }
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

