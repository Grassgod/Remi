/**
 * System tools — restart and other lifecycle operations.
 *
 * Exposed to the AI agent so it can respond to natural language
 * requests like "重启一下" or "restart yourself".
 */

import type { Remi } from "../core.js";

export function getSystemTools(
  remi: Remi,
): Record<string, (...args: unknown[]) => string> {
  function restart_remi(reason?: string | null): string {
    return remi.triggerRestart(reason ?? undefined);
  }
  (restart_remi as { __doc__?: string }).__doc__ =
    "重启 Remi。当用户要求重启、重新启动、restart 时调用此工具。" +
    "可选参数 reason 说明重启原因。";

  return {
    restart_remi: restart_remi as (...args: unknown[]) => string,
  };
}
