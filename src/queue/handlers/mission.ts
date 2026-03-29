/**
 * Mission queue handler — executes pipeline steps.
 */

import type { Remi } from "../../core.js";
import type { MissionJobData } from "../queues.js";
import { MissionStore } from "../../mission/store.js";
import type { PipelineStep } from "../../mission/model.js";
import { createLogger } from "../../logger.js";

const log = createLogger("mission");

/**
 * Handle a mission pipeline step job.
 * Each step = one provider.send() call with appropriate prompt + context.
 */
export async function handleMissionJob(
  job: { data: MissionJobData },
  remi: Remi,
): Promise<void> {
  const { missionId, step, attempt = 0 } = job.data;
  const store = new MissionStore();
  const mission = store.getById(missionId);

  if (!mission) {
    log.warn(`Mission ${missionId} not found, skipping`);
    return;
  }

  log.info(`Executing mission ${missionId} step: ${step} (attempt ${attempt})`);

  // Update current step
  store.updateStep(missionId, step as PipelineStep);
  if (mission.status !== "in_progress") {
    store.updateStatus(missionId, "in_progress");
  }

  try {
    // Build prompt for this step
    const prompt = buildStepPrompt(mission, step as PipelineStep);

    // Resolve project cwd
    const projectCwd = resolveProjectCwd(remi, mission.projectId);

    // Execute via provider
    const provider = remi._providers.values().next().value;
    if (!provider) {
      throw new Error("No provider available");
    }

    const result = await provider.send(prompt, {
      chatId: `mission-${missionId}`,
      sessionId: undefined, // fresh session per step
      cwd: projectCwd,
    });

    log.info(`Mission ${missionId} step ${step} completed (${result.text?.length ?? 0} chars)`);

    // Determine next step
    const nextStep = resolveNextStep(step as PipelineStep);
    if (nextStep) {
      await remi.queue.enqueueMission({ missionId, step: nextStep });
    } else {
      // Pipeline complete — move to in_review
      store.updateStatus(missionId, "in_review");
      log.info(`Mission ${missionId} pipeline complete, moved to in_review`);
    }
  } catch (err) {
    log.error(`Mission ${missionId} step ${step} failed:`, err);
    // Mark blocked — BunQueue handles retries via attempts:2 in enqueueMission()
    store.updateStatus(missionId, "blocked");
    store.recordFeedback(missionId, step as PipelineStep, step, "timeout", String(err));
    throw err; // Re-throw so BunQueue can retry
  }
}

function buildStepPrompt(mission: { title: string; description: string | null; outputDir: string | null }, step: PipelineStep): string {
  const base = `Mission: ${mission.title}\n${mission.description ?? ""}`;

  switch (step) {
    case "rfc":
      return `${base}\n\nPlease design an RFC (technical proposal) for this requirement. Read the relevant codebase first, then output:\n1. Background\n2. Goal\n3. Technical Design\n4. Impact Analysis\n5. Test Strategy\n\nSave the RFC to ${mission.outputDir}/rfc.md`;
    case "decompose":
      return `${base}\n\nBased on the RFC at ${mission.outputDir}/rfc.md, decompose the work into atomic tasks (2-5 minutes each). Include file paths and code change descriptions. Save to ${mission.outputDir}/tasks.md`;
    case "execute":
      return `${base}\n\nExecute the tasks listed in ${mission.outputDir}/tasks.md. Use git worktree for isolation. Run tests after each task. Create a PR when done.`;
    case "eval":
      return `${base}\n\nVerify the implementation against the contract cases. Run the test suite. Generate an evaluation report at ${mission.outputDir}/eval-report.md`;
    case "summary":
      return `${base}\n\nAnalyze the completed mission. Review the git branch diff, any MR comments, and the conversation history. Generate a summary at ${mission.outputDir}/summary.md with improvement suggestions for future missions.`;
    default:
      return base;
  }
}

function resolveProjectCwd(remi: Remi, projectId: string): string {
  const projects = remi.config.projects;
  const value = projects[projectId];
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return (value as any).cwd ?? process.env.HOME ?? "~";
  return process.env.HOME ?? "~";
}

function resolveNextStep(current: PipelineStep): PipelineStep | null {
  const flow: PipelineStep[] = ["rfc", "decompose", "execute", "eval", "summary"];
  const idx = flow.indexOf(current);
  if (idx < 0 || idx >= flow.length - 1) return null;
  return flow[idx + 1];
}
