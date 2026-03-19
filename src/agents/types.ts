/**
 * Agent system type definitions.
 */

export interface AgentConfig {
  name: string;
  model: string;
  trigger: "debounce" | "cron" | "on-demand";
  debounce_ms?: number;
  cron?: string;
  timeoutMs?: number; // default 600_000 (10min)
}

export interface AgentRunResult {
  agent: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timestamp: string;
}
