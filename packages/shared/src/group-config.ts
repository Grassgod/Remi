/**
 * GroupConfig — per-group configuration stored in DB.
 * chat_id is the primary key; each group optionally links to a project.
 *
 * Lives in @shared so both the remi core and the daemon package can reference
 * it without a back-edge into src/remi.
 */

export interface GroupConfig {
  chatId: string;
  projectId: string;
  name: string;
  monitor: boolean;
  replyMode: "thread" | "direct";
  systemPrompt: string;
  allowedTools: string[];
  allowedMcps: string[];
  addDirs: string[];
  provider?: string;
  cwd?: string;
  launchCommand?: string;
  injectChatContext: boolean;
  createdAt: string;
  updatedAt: string;
  /** Joined from projects table — not stored in group_configs */
  projectCwd?: string;
}
