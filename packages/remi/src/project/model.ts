/**
 * Project data model — type definitions for Project Init and management.
 */

// ── Init Step ──

export type InitStepName =
  | "create_chat"
  | "setup_dir"
  | "link_claude_md"
  | "register_complete";

export type InitStepStatus = "pending" | "running" | "done" | "error";

export type ProjectInitStatus = "pending" | "running" | "completed" | "failed";

export interface InitStep {
  name: InitStepName;
  label: string;
  status: InitStepStatus;
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ── Project ──

export interface Project {
  id: string;                          // alias/slug
  name: string;                        // display name
  chatId: string | null;               // Feishu group chat ID
  repoUrl: string | null;              // GitHub repo URL
  cwd: string | null;                  // local code path
  pipelineConfig: unknown | null;      // JSON pipeline config (future)
  initStatus: ProjectInitStatus;
  initSteps: InitStep[];
  createdAt: string;
  updatedAt: string;
}

// ── Project Init Input (from frontend form) ──

export interface ProjectInitInput {
  alias: string;                       // project slug (e.g. "larkparser-ts")
  name: string;                        // display name (e.g. "LarkParser TS")
  repoUrl?: string;                    // GitHub repo URL (optional)
  dirMode: "clone" | "existing";       // directory setup mode
  parentDir?: string;                  // clone mode: target parent directory
  existingPath?: string;               // existing mode: path to existing directory
}

// ── Default init steps ──

export const DEFAULT_INIT_STEPS: InitStep[] = [
  { name: "create_chat", label: "Create Feishu group", status: "pending" },
  { name: "setup_dir", label: "Setup directory", status: "pending" },
  { name: "link_claude_md", label: "Link CLAUDE.md to Remi wiki", status: "pending" },
  { name: "register_complete", label: "Register project", status: "pending" },
];
