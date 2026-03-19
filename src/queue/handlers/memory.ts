/**
 * Memory extraction Worker handler.
 *
 * Receives aggregated conversation text, runs the memory-extract agent
 * (Haiku via CC CLI) to extract entities/decisions/observations.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "bunqueue/client";
import type { MemoryJobData } from "../queues.js";
import type { MemoryStore } from "../../memory/store.js";
import { AgentRunner } from "../../agents/index.js";
import { createLogger } from "../../logger.js";

const log = createLogger("queue:memory");

/**
 * Describe current memory structure for the agent prompt context.
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

  const prompt = `
## 当前记忆结构
${describeMemoryStructure(memory)}

## 对话上下文
Session: ${sessionKey}

## 对话内容（最近部分）
${aggregatedText.slice(0, 8000)}

请分析以上对话，提取值得长期记忆的信息。使用 recall 工具检查已有记忆避免重复，使用 remember 工具写入新信息。
`;

  const runner = new AgentRunner();
  const result = await runner.run("memory-extract", prompt);

  if (result.exitCode !== 0) {
    log.error(
      `memory-extract agent failed (exit=${result.exitCode}): ${result.stderr.slice(0, 500)}`,
    );
    throw new Error(`memory-extract agent failed with exit code ${result.exitCode}`);
  }

  log.info(
    `Memory extraction complete: session=${sessionKey}, duration=${result.durationMs}ms`,
  );
}
