/**
 * Agent registry — name → config mapping.
 * Add new agents here; AgentRunner reads this registry.
 */

import type { AgentConfig } from "./types.js";

export const AGENTS: Record<string, AgentConfig> = {
  "memory-extract": {
    name: "memory-extract",
    model: "haiku",
    trigger: "debounce",
    debounce_ms: 300_000, // 5 minutes
    timeoutMs: 120_000,
  },
  "memory-audit": {
    name: "memory-audit",
    model: "opus",
    trigger: "cron",
    cron: "30 3 * * *",
    timeoutMs: 600_000,
  },
  "memory-rerank": {
    name: "memory-rerank",
    model: "haiku",
    trigger: "on-demand",
    timeoutMs: 30_000,
  },
  "wiki-curate": {
    name: "wiki-curate",
    model: "opus",
    trigger: "cron",
    cron: "0 3 * * *",
    timeoutMs: 900_000, // 15 min — wiki curation reads many files
  },
};
