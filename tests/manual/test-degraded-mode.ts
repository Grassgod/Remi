/**
 * Test patch-only updates and resuming the same message after a local restart.
 *
 * Phase 1 (0-30s): Interactive updates via im.message.patch
 * Phase 2 (30s-3m): Reattach to the message and continue via the same patch path
 * Phase 3: Close with final card
 *
 * Usage: bun run tests/manual/test-degraded-mode.ts
 */

import { createFeishuClient } from "@connectors/feishu/client.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { loadConfig } from "./_load-config.js";

async function main() {
  const config = loadConfig();
  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);
  let session = new FeishuStreamingSession(client, creds);

  console.log("Creating patch-only card...");
  await session.start(config.chatId, "open_id", { sessionId: "degraded-test" });
  console.log("Card created");

  // Phase 1: Interactive patches (30 seconds)
  console.log("\n═══ Phase 1: Interactive patches (30s) ═══");
  let contentText = "";
  let stepCount = 0;

  for (let i = 0; i < 6; i++) {
    stepCount++;
    const toolName = i % 2 === 0 ? "Bash" : "Read";
    const desc = `${toolName} \`$ echo step_${stepCount}\``;
    session.addStep(toolName, desc);
    await session.updateStatus(`Running ${toolName}...`);

    contentText += `Step ${stepCount} completed.\n`;
    await session.update(contentText);

    console.log(`  Step ${stepCount} (patch)`);
    await Bun.sleep(5000);

    session.updateStepDuration(5000);
  }

  // Phase 2: Resume by message identity, replaying earlier steps.
  console.log("\n═══ Phase 2: Resume message ═══");
  const messageId = session.getMessageId();
  const previousSteps = session.getSteps();
  session.detach();
  session = new FeishuStreamingSession(client, creds);
  await session.start(config.chatId, "open_id", { durable: { idempotencyKey: `patch-probe-${Date.now()}`, messageId } });
  for (const step of previousSteps) session.addStep(step.tool, step.desc);

  // Continue for 2.5 minutes on the same message.
  const degradedStart = Date.now();
  const degradedDuration = 150_000; // 2.5 min

  while (Date.now() - degradedStart < degradedDuration) {
    stepCount++;
    const elapsed = Math.round((Date.now() - degradedStart) / 1000);
    const toolName = stepCount % 3 === 0 ? "Edit" : stepCount % 3 === 1 ? "Bash" : "Grep";
    const desc = `${toolName} \`$ operation_${stepCount}\``;
    session.addStep(toolName, desc);
    await session.updateStatus(`Running ${toolName}... (resumed, ${elapsed}s)`);

    contentText += `Step ${stepCount} after resuming (${elapsed}s elapsed).\n`;
    await session.update(contentText);

    console.log(`  Step ${stepCount} (resumed, ${elapsed}s)`);
    await Bun.sleep(10000);

    session.updateStepDuration(10000);
  }

  // Phase 3: Close
  console.log("\n═══ Phase 3: Close ═══");
  const totalElapsed = Math.round((Date.now() - degradedStart + 30000) / 1000);
  await session.close({
    finalText: contentText,
    toolCount: stepCount,
    stats: `${totalElapsed}s · ${stepCount} tools · patch resume test`,
  });
  console.log(`Closed. Total steps: ${stepCount}`);

  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
