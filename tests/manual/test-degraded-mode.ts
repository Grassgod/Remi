/**
 * Test degraded mode: simulate streaming expiry and show im.message.patch fallback.
 *
 * Phase 1 (0-30s): Normal streaming — add steps, update content
 * Phase 2 (30s-3m): Force degraded mode — continue adding steps/content via im.message.patch
 * Phase 3: Close with final card
 *
 * Usage: bun run tests/manual/test-degraded-mode.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFeishuClient } from "../../src/connectors/feishu/client.js";
import { FeishuStreamingSession } from "../../src/connectors/feishu/streaming.js";

function loadConfig() {
  const paths = [join(process.cwd(), "remi.toml"), join(process.env.HOME || "/home", ".remi", "remi.toml")];
  let toml = "";
  for (const p of paths) { try { toml = readFileSync(p, "utf-8"); break; } catch {} }
  if (!toml) throw new Error("remi.toml not found");
  return {
    appId: toml.match(/app_id\s*=\s*"([^"]+)"/)?.[1] ?? "",
    appSecret: toml.match(/app_secret\s*=\s*"([^"]+)"/)?.[1] ?? "",
    domain: toml.match(/domain\s*=\s*"([^"]+)"/)?.[1] ?? "feishu",
    chatId: toml.match(/trigger_user_ids\s*=\s*\[\s*"([^"]+)"/)?.[1] ?? "",
  };
}

async function main() {
  const config = loadConfig();
  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);
  const session = new FeishuStreamingSession(client, creds);

  console.log("Creating streaming card...");
  await session.start(config.chatId, "open_id", { sessionId: "degraded-test" });
  console.log("Card created");

  // Phase 1: Normal streaming (30 seconds)
  console.log("\n═══ Phase 1: Normal streaming (30s) ═══");
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

    console.log(`  Step ${stepCount} (streaming)`);
    await Bun.sleep(5000);

    session.updateStepDuration(5000);
  }

  // Phase 2: Force degraded mode
  console.log("\n═══ Phase 2: Forcing degraded mode ═══");
  // Access private field to force degraded state
  (session as any)._degraded = true;
  (session as any)._clearRenewTimer();
  console.log(`  isDegraded: ${session.isDegraded()}`);

  // Continue for 2.5 minutes in degraded mode
  const degradedStart = Date.now();
  const degradedDuration = 150_000; // 2.5 min

  while (Date.now() - degradedStart < degradedDuration) {
    stepCount++;
    const elapsed = Math.round((Date.now() - degradedStart) / 1000);
    const toolName = stepCount % 3 === 0 ? "Edit" : stepCount % 3 === 1 ? "Bash" : "Grep";
    const desc = `${toolName} \`$ operation_${stepCount}\``;
    session.addStep(toolName, desc);
    await session.updateStatus(`Running ${toolName}... (degraded, ${elapsed}s)`);

    contentText += `Step ${stepCount} in degraded mode (${elapsed}s elapsed).\n`;
    await session.update(contentText);

    console.log(`  Step ${stepCount} (degraded, ${elapsed}s)`);
    await Bun.sleep(10000);

    session.updateStepDuration(10000);
  }

  // Phase 3: Close
  console.log("\n═══ Phase 3: Close ═══");
  const totalElapsed = Math.round((Date.now() - degradedStart + 30000) / 1000);
  await session.close({
    finalText: contentText,
    toolCount: stepCount,
    stats: `${totalElapsed}s · ${stepCount} tools · degraded mode test`,
  });
  console.log(`Closed. Total steps: ${stepCount}`);

  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
