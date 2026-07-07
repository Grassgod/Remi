/**
 * GroupConfig moved to @shared/group-config so the daemon package can reference
 * it without a back-edge into src/remi. Re-exported here for existing callers.
 */

export type { GroupConfig } from "@shared/group-config.js";

export interface GroupConfigInput {
  chatId: string;
  projectId?: string;
  name?: string;
  monitor?: boolean;
  replyMode?: "thread" | "direct";
  systemPrompt?: string;
  allowedTools?: string[];
  allowedMcps?: string[];
  addDirs?: string[];
  provider?: string;
  cwd?: string;
  launchCommand?: string;
  injectChatContext?: boolean;
}
