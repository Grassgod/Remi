/**
 * Project Init Orchestrator — runs 4-step init pipeline with SSE event emission.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  chmodSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ProjectStore } from "./store.js";
import type { ProjectInitInput, InitStepName } from "./model.js";
import { createProjectChat, setupProjectChat } from "../connectors/feishu/chat.js";
import { GroupConfigStore } from "../group/store.js";
import { loadConfig } from "../config.js";

/** Resolve the project owner's Feishu open_id from config. */
function getOwnerOpenId(): string {
  const config = loadConfig();
  return config.feishu.triggerUserIds[0] ?? "";
}

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
): Promise<void> {
  const projectId = input.alias;

  // Mark running
  store.updateInitStatus(projectId, "running");

  // Step 1: Create Feishu group + whitelist it
  const step1 = await runStep(store, projectId, "create_chat", async () => {
    const existing = store.getById(projectId);
    let chatId = existing?.chatId;

    if (!chatId) {
      const ownerOpenId = getOwnerOpenId();
      if (!ownerOpenId) {
        throw new Error("No owner open_id configured. Set feishu.trigger_user_ids in remi.toml.");
      }
      chatId = await createProjectChat(input.name, ownerOpenId);
      store.updateField(projectId, "chat_id", chatId);
    }

    // Register in group_configs for DB-based filtering (idempotent upsert)
    const gcStore = new GroupConfigStore();
    gcStore.upsert({
      chatId: chatId,
      projectId: projectId,
      monitor: true,           // project groups auto-reply by default
      missionEnabled: true,    // enable mission pipeline for project groups
      replyMode: "thread",
    });

    // Setup group: avatar + mission board tab
    await setupProjectChat(chatId, projectId);

    return chatId;
  });
  if (!step1) return;

  // Step 2: Setup directory
  const step2 = await runStep(store, projectId, "setup_dir", async () => {
    if (input.dirMode === "existing") {
      const path = realpathSync(input.existingPath!);
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

  // [DISABLED] Pipeline skills now referenced directly from /pipeline/skills/ (single source of truth).
  // Copy logic kept for reference — re-enable when per-project customization is needed.
  // try {
  //   const cwd = store.getById(projectId)?.cwd;
  //   if (cwd) {
  //     const srcSkillsDir = join(import.meta.dir, "../../pipeline/skills");
  //     const destSkillsDir = join(cwd, ".claude", "skills");
  //
  //     if (existsSync(srcSkillsDir)) {
  //       for (const stepDir of readdirSync(srcSkillsDir)) {
  //         const srcDir = join(srcSkillsDir, stepDir);
  //         const destDir = join(destSkillsDir, stepDir);
  //         const srcSkill = join(srcDir, "SKILL.md");
  //         if (existsSync(srcSkill)) {
  //           mkdirSync(destDir, { recursive: true });
  //           copyFileSync(srcSkill, join(destDir, "SKILL.md"));
  //         }
  //         const srcScript = join(srcDir, "mission-advance");
  //         if (existsSync(srcScript)) {
  //           copyFileSync(srcScript, join(destDir, "mission-advance"));
  //           try { chmodSync(join(destDir, "mission-advance"), 0o755); } catch {}
  //         }
  //       }
  //     }
  //   }
  // } catch (err) {
  //   log.warn(`Failed to copy pipeline skills: ${err}`);
  // }

  // Step 3: Link project CLAUDE.md to Remi wiki README (single source of truth at ~/.remi/)
  const step3 = await runStep(store, projectId, "link_claude_md", async () => {
    const cwd = store.getById(projectId)?.cwd;
    if (!cwd || !existsSync(cwd)) return "Skipped (no cwd)";
    return linkProjectClaudeMd(cwd, projectId);
  });
  if (!step3) return;

  // Step 4: Register complete
  await runStep(store, projectId, "register_complete", async () => {
    store.updateInitStatus(projectId, "completed");
    return "Project ready";
  });

  emit(projectId, { type: "done", data: { status: "completed" } });
}

/**
 * Ensure {cwd}/CLAUDE.md is a symlink pointing to
 * ~/.remi/wiki/projects/{alias}/README.md, making Remi's wiki the single
 * source of truth. Both CC (when running in cwd) and the Remi dashboard
 * show the same content.
 *
 * Handles four cases:
 *   1. cwd/CLAUDE.md already a symlink to the wiki README → no-op
 *   2. cwd/CLAUDE.md is a real file → migrate content to wiki README
 *      (if wiki README empty), back up the original to CLAUDE.md.bak,
 *      replace with symlink
 *   3. cwd/CLAUDE.md doesn't exist + wiki README exists → symlink
 *   4. Neither exists → write a minimal stub README, symlink
 */
function linkProjectClaudeMd(cwd: string, alias: string): string {
  const wikiDir = join(homedir(), ".remi", "wiki", "projects", alias);
  const wikiReadme = join(wikiDir, "README.md");
  const cwdClaudeMd = join(cwd, "CLAUDE.md");

  // Ensure wiki dir exists
  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });

  // Case 1: cwd/CLAUDE.md is already the right symlink → idempotent no-op
  try {
    const st = lstatSync(cwdClaudeMd);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(cwdClaudeMd);
      if (target === wikiReadme) return `Already linked: ${cwdClaudeMd} → ${wikiReadme}`;
      // Symlink pointing elsewhere — replace
      unlinkSync(cwdClaudeMd);
    } else if (st.isFile()) {
      // Case 2: real file — migrate / back up
      const existingContent = readFileSync(cwdClaudeMd, "utf-8");
      if (!existsSync(wikiReadme)) {
        // Wiki side empty → take the project's CLAUDE.md as the new canonical README
        writeFileSync(wikiReadme, existingContent, "utf-8");
      } else {
        // Both exist — don't destroy either; back up the project's to .bak
        const backupPath = join(cwd, "CLAUDE.md.bak");
        renameSync(cwdClaudeMd, backupPath);
      }
      // After either branch, cwdClaudeMd should no longer exist as a regular file
      if (existsSync(cwdClaudeMd)) unlinkSync(cwdClaudeMd);
    }
  } catch (e) {
    // lstat failed → file doesn't exist; fall through to create-symlink path
  }

  // Case 3 & 4: ensure wiki README exists
  if (!existsSync(wikiReadme)) {
    writeFileSync(
      wikiReadme,
      `# ${alias}\n\n(Remi-managed README. Edit via wiki-curate or directly at ~/.remi/wiki/projects/${alias}/README.md)\n`,
      "utf-8",
    );
  }

  // Create the symlink: {cwd}/CLAUDE.md → wiki README
  symlinkSync(wikiReadme, cwdClaudeMd);
  return `Linked: ${cwdClaudeMd} → ${wikiReadme}`;
}

/**
 * Retry a failed init from the first error step.
 */
export async function retryProjectInit(
  store: ProjectStore,
  projectId: string,
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

  await runProjectInit(store, input);
}
