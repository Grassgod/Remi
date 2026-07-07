/**
 * `remi auth` — Legacy Feishu OAuth CLI command.
 */

import { runAuth } from "../auth/oauth-cli.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("auth-cmd");

export async function runAuthCmd(args: string[]): Promise<void> {
  try {
    await runAuth();
  } catch (e) {
    log.error("Auth error:", e);
    process.exit(1);
  }
}
