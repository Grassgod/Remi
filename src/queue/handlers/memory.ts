/**
 * Memory extraction Worker handler.
 *
 * Receives aggregated conversation text and extracts entities/decisions/observations
 * into the memory store via the maintenance prompt + LLM pipeline.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "bunqueue/client";
import type { MemoryJobData } from "../queues.js";
import type { MemoryStore } from "../../memory/store.js";
import {
  buildMaintenancePrompt,
  parseMaintenanceResponse,
  executeMaintenanceActions,
} from "../../memory/maintenance.js";
import { createLogger } from "../../logger.js";

const log = createLogger("queue:memory");

/**
 * Describe current memory structure for the maintenance prompt.
 * Adapted from MemoryDaemon._describeMemoryStructure().
 */
function describeMemoryStructure(store: MemoryStore): string {
  const lines: string[] = [];
  const entitiesDir = join(store.root, "entities");
  if (existsSync(entitiesDir)) {
    for (const entry of readdirSync(entitiesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const count = readdirSync(join(entitiesDir, entry.name)).filter((f) =>
          f.endsWith(".md"),
        ).length;
        lines.push(`  entities/${entry.name}/: ${count} files`);
      }
    }
  }

  const dailyDir = join(store.root, "daily");
  if (existsSync(dailyDir)) {
    const count = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).length;
    lines.push(`  daily/: ${count} files`);
  }

  return lines.length > 0 ? lines.join("\n") : "  (empty)";
}

export async function handleMemoryJob(
  job: Job<MemoryJobData>,
  memory: MemoryStore,
): Promise<void> {
  const { aggregatedText, sessionKey, roundCount, contentHash } = job.data;

  log.info(
    `Processing memory extraction: session=${sessionKey}, rounds=${roundCount}, hash=${contentHash}`,
  );

  // 1. Build maintenance prompt
  const prompt = buildMaintenancePrompt(
    null, // cwd — not available in queue context
    "", // summary
    aggregatedText.slice(0, 8000), // recent turns (limit to avoid token overflow)
    describeMemoryStructure(memory),
  );

  // 2. Call LLM for extraction
  // TODO: Wire up a lightweight LLM call (e.g. Haiku) here.
  // For now, log the prompt size and skip LLM. When ready:
  //   const response = await callLLM(prompt);
  //   const actions = parseMaintenanceResponse(response);
  //   const executed = executeMaintenanceActions(memory, actions);
  //   log.info(`Memory extraction complete: ${executed} actions executed`);

  log.info(
    `Maintenance prompt built (${prompt.length} chars), LLM call pending — same as daemon.ts TODO`,
  );
}
