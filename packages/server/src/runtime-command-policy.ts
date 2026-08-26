export const RUNTIME_COMMAND_PENDING_TIMEOUT_MS = 3 * 60 * 1000;
export const RUNTIME_COMMAND_RUNNING_TIMEOUT_MS = 20 * 60 * 1000;
export const DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS = 60 * 1000;
export const MAX_RUNTIME_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_NPM_GLOBAL_PROVISION_TIMEOUT_MS = 15 * 60 * 1000;

export function normalizeRuntimeCommandTimeout(value: unknown, maximum = MAX_RUNTIME_COMMAND_TIMEOUT_MS): number {
  if (value === undefined || value === null || value === "") return DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > maximum) {
    throw new Error(`timeout_ms must be an integer between 100 and ${maximum}`);
  }
  return timeoutMs;
}
