/**
 * Project Init Orchestrator — runs 4-step init pipeline with SSE event emission.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore } from "./store.js";
import type { ProjectInitInput, InitStepName } from "./model.js";
import { createProjectChat } from "../connectors/feishu/chat.js";
import { getActiveFeishuConnector } from "../connectors/feishu/registry.js";
import type { RemiData } from "../../web/remi-data.js";

// Jack's hardcoded open_id — only group member besides Remi Bot
const OWNER_OPEN_ID = "ou_f4ed0b435518ee382e7e06c147a9db9f";

// ── SSE Event System ──

export interface SSEEvent {
  type: "step" | "done" | "error";
  data: {
    step?: InitStepName;
    status?: string;
    result?: string;
    error?: string;
  };
}

type SSECallback = (event: SSEEvent) => void;

const listeners = new Map<string, Set<SSECallback>>();

export function subscribe(projectId: string, cb: SSECallback): () => void {
  if (!listeners.has(projectId)) listeners.set(projectId, new Set());
  listeners.get(projectId)!.add(cb);
  return () => {
    listeners.get(projectId)?.delete(cb);
    if (listeners.get(projectId)?.size === 0) listeners.delete(projectId);
  };
}

function emit(projectId: string, event: SSEEvent): void {
  listeners.get(projectId)?.forEach((cb) => cb(event));
}

// ── Step Runner Helper ──

async function runStep(
  store: ProjectStore,
  projectId: string,
  stepName: InitStepName,
  fn: () => Promise<string | undefined>,
): Promise<boolean> {
  // Check if already done (idempotent)
  const project = store.getById(projectId);
  if (!project) return false;
  const step = project.initSteps.find((s) => s.name === stepName);
  if (step?.status === "done") {
    emit(projectId, { type: "step", data: { step: stepName, status: "done", result: step.result } });
    return true;
  }

  // Mark running
  store.updateInitStep(projectId, stepName, "running");
  emit(projectId, { type: "step", data: { step: stepName, status: "running" } });

  try {
    const result = await fn();
    store.updateInitStep(projectId, stepName, "done", result);
    emit(projectId, { type: "step", data: { step: stepName, status: "done", result } });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateInitStep(projectId, stepName, "error", undefined, message);
    store.updateInitStatus(projectId, "failed");
    emit(projectId, { type: "step", data: { step: stepName, status: "error", error: message } });
    emit(projectId, { type: "error", data: { error: message } });
    return false;
  }
}

// ── Main Orchestrator ──

export async function runProjectInit(
  store: ProjectStore,
  input: ProjectInitInput,
  remiData: RemiData,
): Promise<void> {
  const projectId = input.alias;

  // Mark running
  store.updateInitStatus(projectId, "running");

  // Step 1: Create Feishu group + whitelist it
  const step1 = await runStep(store, projectId, "create_chat", async () => {
    const existing = store.getById(projectId);
    let chatId = existing?.chatId;

    if (!chatId) {
      chatId = await createProjectChat(input.name, OWNER_OPEN_ID);
      store.updateField(projectId, "chat_id", chatId);
    }

    // Always ensure whitelist (idempotent — runs even if group already existed)
    remiData.addGroupToWhitelist(chatId);
    getActiveFeishuConnector()?.addGroups([chatId]);

    return chatId;
  });
  if (!step1) return;

  // Step 2: Setup directory
  const step2 = await runStep(store, projectId, "setup_dir", async () => {
    if (input.dirMode === "existing") {
      const path = input.existingPath!;
      if (!existsSync(path)) throw new Error(`Directory not found: ${path}`);
      store.updateField(projectId, "cwd", path);
      return path;
    }

    // Clone mode
    const repoUrl = input.repoUrl;
    if (!repoUrl) throw new Error("Repo URL required for clone mode");

    const parentDir = input.parentDir || join(process.env.HOME ?? "~", "project");
    const targetDir = join(parentDir, input.alias);

    if (existsSync(targetDir)) {
      // Already cloned — skip
      store.updateField(projectId, "cwd", targetDir);
      return targetDir;
    }

    // Git clone
    const proc = Bun.spawn(["git", "clone", repoUrl, targetDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git clone failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    store.updateField(projectId, "cwd", targetDir);
    return targetDir;
  });
  if (!step2) return;

  // Step 3: Write config (toml) — project + bot profile
  const step3 = await runStep(store, projectId, "write_config", async () => {
    const project = store.getById(projectId)!;
    const ok = remiData.saveProject(projectId, project.cwd!);
    if (!ok) throw new Error("Failed to write remi.toml");

    // Write bot profile so this group uses the project's cwd
    if (project.chatId) {
      remiData.addBotProfile({
        id: `project-${projectId}`,
        name: input.name,
        groups: [project.chatId],
        cwd: project.cwd!,
        reply_mode: "thread",
      });
    }

    return "remi.toml updated";
  });
  if (!step3) return;

  // Step 4: Register complete + activate bot profile in live connector
  await runStep(store, projectId, "register_complete", async () => {
    const project = store.getById(projectId)!;

    // Register bot profile in running connector so cwd takes effect immediately
    if (project.chatId && project.cwd) {
      getActiveFeishuConnector()?.addBotProfile({
        id: `project-${projectId}`,
        name: input.name,
        groups: [project.chatId],
        cwd: project.cwd,
        allowedTools: [],
        addDirs: [],
        replyMode: "thread",
        systemPrompt: "",
      });
    }

    store.updateInitStatus(projectId, "completed");
    return "Project ready";
  });

  emit(projectId, { type: "done", data: { status: "completed" } });
}

/**
 * Retry a failed init from the first error step.
 */
export async function retryProjectInit(
  store: ProjectStore,
  projectId: string,
  remiData: RemiData,
): Promise<void> {
  const project = store.getById(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (project.initStatus !== "failed") {
    throw new Error(`Project is not in failed state: ${project.initStatus}`);
  }

  // Reconstruct input from stored project
  const input: ProjectInitInput = {
    alias: project.id,
    name: project.name,
    repoUrl: project.repoUrl ?? undefined,
    dirMode: project.repoUrl ? "clone" : "existing",
    existingPath: project.cwd ?? undefined,
  };

  // Reset error steps to pending
  for (const step of project.initSteps) {
    if (step.status === "error") {
      store.updateInitStep(projectId, step.name, "pending");
    }
  }

  await runProjectInit(store, input, remiData);
}
