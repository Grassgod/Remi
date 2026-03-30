/**
 * Mission queue handler — unified pipeline execution.
 *
 * All steps (intake through summary) go through BunQueue.
 * Each step: resolve session → append-system-prompt pointing to skill → streamToThread → save session.
 * Eval result is handled by model calling mission-advance script directly.
 */

import type { Remi } from "../../core.js";
import type { MissionJobData } from "../queues.js";
import { MissionStore } from "../../mission/store.js";
import type { Mission, PipelineStep, Contract } from "../../mission/model.js";
import type { AgentResponse } from "../../providers/base.js";
import { sendToThread } from "../../connectors/feishu/thread.js";
import { insertConversationProcessing, completeConversation } from "../../db/index.js";
import { createLogger } from "../../logger.js";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
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
  intake: "description.md",
  rfc: "RFC.md",
  decompose: "tasks.md",
  execute: "execute-log.md",
  eval: "eval-report.md",
  summary: "summary.md",
};

/** PipelineStep → 中文标签 */
const STEP_LABEL: Record<string, string> = {
  intake: "需求澄清",
  rfc: "RFC 技术方案",
  decompose: "任务拆解",
  execute: "代码执行",
  eval: "Contract 验证",
  summary: "总结",
};

/** PipelineStep → session type (null = new session every time) */
const STEP_SESSION_TYPE: Record<string, string | null> = {
  intake: "intake",
  rfc: "plan",
  decompose: "plan",
  execute: "exec",
  eval: null,
  summary: null,
};

/** Step flow: current → next */
const STEP_FLOW: Record<string, PipelineStep | null> = {
  intake: null,     // intake → approval card, not auto-advance
  rfc: "decompose",
  decompose: "execute",
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
  // Intake stays "inbox"; post-intake steps go "in_progress"
  if (step !== "intake" && mission.status !== "in_progress") {
    store.updateStatus(missionId, "in_progress");
  }

  try {
    const projectCwd = resolveProjectCwd(remi, mission.projectId);

    // ── 1. Resolve session ──
    const sessionType = STEP_SESSION_TYPE[step] ?? null;
    const existingSessionId = sessionType ? (mission.sessions[sessionType] ?? null) : null;

    // ── 2. Build prompt ──
    let prompt: string;
    if (userMessage) {
      // Intake multi-turn: user's reply is the prompt
      prompt = userMessage;
    } else {
      prompt = buildStepPrompt(mission, step as PipelineStep);
      if (step === "execute" && evalFailureInfo) {
        prompt += `\n\n## 上次 Eval 失败详情\n${evalFailureInfo}`;
      }
    }

    // ── 3. Build append-system-prompt ──
    const skillDir = STEP_SKILL_DIR[step];
    const label = STEP_LABEL[step] ?? step;
    const outputFile = STEP_OUTPUT_FILE[step] ? `${mission.outputDir}/${STEP_OUTPUT_FILE[step]}` : null;
    let systemPrompt = `执行 Mission Pipeline 的 ${label} 阶段。阅读并严格遵循 .claude/skills/${skillDir}/SKILL.md 的指示。\n\nMission ID: ${missionId}\n产出目录: ${mission.outputDir}`;
    if (outputFile) {
      systemPrompt += `\n\n重要：本阶段的产出文件必须写到 ${outputFile}，不要写到其他位置（如 docs/superpowers/）。`;
    }
    // Inject pipeline config (release branch, test command, etc.)
    if (step === "execute" || step === "rfc") {
      try {
        const { ProjectStore } = require("../../project/store.js");
        const project = new ProjectStore().getById(mission.projectId);
        const pc = project?.pipelineConfig as any;
        if (pc?.pipeline?.releaseBranch) {
          systemPrompt += `\nMR 目标分支: ${pc.pipeline.releaseBranch}（功能分支合入此分支）`;
        }
        if (pc?.pipeline?.testCommand) {
          systemPrompt += `\n测试命令: ${pc.pipeline.testCommand}`;
        }
        if (pc?.pipeline?.lintCommand) {
          systemPrompt += `\nLint 命令: ${pc.pipeline.lintCommand}`;
        }
      } catch {}
    }
    if (step !== "intake") {
      systemPrompt += `\n\n此阶段完全自动化。禁止使用 AskUserQuestion。禁止使用 EnterPlanMode。所有决策自主完成。`;
    }

    // ── 4. Stream to Feishu thread ──
    let result: AgentResponse;
    const feishu = remi.getFeishuConnector();

    if (mission.chatId && mission.threadId && feishu) {
      // Send stage label (only for first message of a step, not multi-turn replies)
      if (!userMessage) {
        try {
          await sendToThread(mission.chatId, mission.threadId, `── **${label}** ──`);
        } catch (err) {
          log.warn(`Failed to send stage label for ${missionId}/${step}: ${err}`);
        }
      }

      const incoming: import("../../connectors/base.js").IncomingMessage = {
        text: prompt,
        chatId: mission.chatId,
        sender: "mission-pipeline",
        connectorName: "feishu",
        metadata: {
          missionId,
          pipelineStep: step,
          systemPromptOverride: systemPrompt,
          missionSessionId: existingSessionId,
          missionCwd: projectCwd,
          // rootId is needed by core._resolveSessionKey to isolate session per thread
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
        sessionId: existingSessionId,
        cwd: projectCwd,
        systemPrompt,
      });
    }

    log.info(`Mission ${missionId} step ${step} completed (${result.text?.length ?? 0} chars)`);

    // ── 5. Save session ID ──
    if (sessionType && result.sessionId) {
      const sessions = { ...mission.sessions, [sessionType]: result.sessionId };
      store.updateSessions(missionId, sessions);
      log.info(`Saved session ${sessionType}=${result.sessionId} for mission ${missionId}`);
    }

    // ── 6. Record conversation + accumulate stats ──
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

    // ── 7. Write output file ──
    writeStepOutput(mission.outputDir, step as PipelineStep, result.text);

    // ── 8. Validate output ──
    if (step !== "eval" && step !== "intake") {
      // eval: model calls mission-advance, handler doesn't judge
      // intake: multi-turn, description.md may not exist yet
      const outputFile = STEP_OUTPUT_FILE[step];
      if (outputFile && mission.outputDir && !existsSync(join(mission.outputDir, outputFile))) {
        log.warn(`Mission ${missionId} step ${step} did not produce expected output: ${outputFile}`);
        // Don't block — the text output was still captured
      }
    }

    // ── 9. Step-specific post-processing ──

    if (step === "intake") {
      // Check if intake produced description.md → send approval card
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
      // Don't auto-advance — wait for user approval or next message
      return;
    }

    if (step === "eval") {
      // Model should call mission-advance script to advance state.
      // Handler does nothing — state transition is script's responsibility.
      log.info(`Mission ${missionId} eval step completed, awaiting mission-advance script`);
      return;
    }

    // Other steps: auto-advance to next
    const nextStep = STEP_FLOW[step];
    if (nextStep) {
      await remi.queue.enqueueMission({ missionId, step: nextStep, attempt });
    } else {
      // Pipeline complete (summary finished)
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

function buildStepPrompt(
  mission: { title: string; description: string | null; outputDir: string | null; contract: Contract | null; id: string },
  step: PipelineStep,
): string {
  const parts: string[] = [];

  parts.push(`# Mission: ${mission.title}`);
  if (mission.description) parts.push(`\n## 需求描述\n${mission.description}`);
  if (mission.outputDir) parts.push(`\n## 产出目录\n${mission.outputDir}`);
  parts.push(`\n## Mission ID\n${mission.id}`);

  // Inject contract for eval and execute steps
  if (mission.contract && (step === "eval" || step === "execute")) {
    parts.push(`\n## Contract Cases\n\`\`\`json\n${JSON.stringify(mission.contract, null, 2)}\n\`\`\``);
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

// ── Helpers ──

function resolveProjectCwd(_remi: Remi, projectId: string): string {
  const { ProjectStore } = require("../../project/store.js");
  const store = new ProjectStore();
  const project = store.getById(projectId);
  return project?.cwd ?? process.env.HOME ?? "~";
}
