/**
 * Interactive test: permission forms with real card action callbacks.
 *
 * Creates a streaming card, appends permission forms one by one,
 * waits for you to actually click, then shows what was received.
 *
 * NOTE: pm2 remi should be stopped first to avoid WebSocket conflict.
 * Usage: pm2 stop remi && bun run tests/manual/test-permission-callback.ts
 */

import { createFeishuClient } from "../../src/connectors/feishu/client.js";
import { FeishuStreamingSession } from "../../src/connectors/feishu/streaming.js";
import { registerPendingAction } from "../../src/connectors/feishu/card-actions.js";
import { buildToolApprovalForm, buildAskQuestionForm, buildPlanReviewForm } from "../../src/connectors/feishu/permission-ui.js";
import { startWebSocketListener } from "../../src/connectors/feishu/receive.js";
import { loadConfig } from "./_load-config.js";

function waitForAction(questions?: Array<{ question: string; options: Array<{ label: string }> }>, chatId?: string): { actionId: string; promise: Promise<unknown> } {
  let actionId = "";
  const promise = new Promise<unknown>((resolve, reject) => {
    actionId = registerPendingAction(resolve, reject, questions, chatId);
  });
  return { actionId, promise };
}

async function main() {
  const config = loadConfig();
  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);

  // Start WebSocket listener to receive card action callbacks
  console.log("Starting WebSocket listener...");
  const wsHandle = await startWebSocketListener({
    appId: config.appId,
    appSecret: config.appSecret,
    verificationToken: config.verificationToken,
    encryptKey: config.encryptKey,
  }, async () => {});
  console.log("WebSocket connected\n");

  const session = new FeishuStreamingSession(client, creds);
  await session.start(config.chatId, "open_id", { sessionId: "perm-callback-test" });
  console.log("Streaming card created\n");

  await session.update("Permission callback test — 请在卡片上操作");
  await session.updateStatus("Testing...");

  // ═══ Test 1: Tool Approval ═══
  console.log("═══ Test 1: Tool Approval ═══");
  console.log("  Appending tool approval form...");
  const tool = waitForAction(undefined, config.chatId);
  const toolForm = buildToolApprovalForm(tool.actionId, "Bash", "`$ rm -rf node_modules && bun install`", [
    { kind: "allow_once", name: "Allow", optionId: "allow_once" },
    { kind: "reject_once", name: "Reject", optionId: "reject_once" },
  ]);
  await session.appendPermissionForm(toolForm);
  await session.updateStatus("Waiting for tool approval...");

  console.log(`  Action ID: ${tool.actionId}`);
  console.log("  👉 Click Allow or Deny on the card...\n");

  try {
    const toolResult = await Promise.race([
      tool.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000)),
    ]);
    console.log(`  ✅ Received: ${JSON.stringify(toolResult)}\n`);
  } catch (e) {
    console.log(`  ⏰ Timed out or error: ${e}\n`);
  }
  await session.removePermissionForm(tool.actionId);

  // ═══ Test 2: AskUserQuestion ═══
  console.log("═══ Test 2: AskUserQuestion ═══");
  console.log("  Appending ask form...");
  const questions = [
    { question: "使用哪种包管理器？", options: [{ label: "npm" }, { label: "yarn" }, { label: "bun" }] },
  ];
  const ask = waitForAction(questions, config.chatId);
  const askForm = buildAskQuestionForm(ask.actionId, { questions: questions.map(q => ({ ...q, options: q.options.map(o => ({ ...o })) })) });
  await session.appendPermissionForm(askForm);
  await session.updateStatus("Waiting for input...");

  console.log(`  Action ID: ${ask.actionId}`);
  console.log("  👉 Select an option or type custom answer, then click Submit...\n");

  try {
    const askResult = await Promise.race([
      ask.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000)),
    ]);
    console.log(`  ✅ Received: ${JSON.stringify(askResult)}\n`);
  } catch (e) {
    console.log(`  ⏰ Timed out or error: ${e}\n`);
  }
  await session.removePermissionForm(ask.actionId);

  // ═══ Test 3: ExitPlanMode ═══
  console.log("═══ Test 3: ExitPlanMode ═══");
  console.log("  Appending plan review form...");
  const plan = waitForAction(undefined, config.chatId);
  const planForm = buildPlanReviewForm(plan.actionId, "## Plan\n\n1. Refactor config module\n2. Add tests\n3. Update docs");
  await session.appendPermissionForm(planForm);
  await session.updateStatus("Waiting for plan approval...");

  console.log(`  Action ID: ${plan.actionId}`);
  console.log("  👉 Click Approve or Deny (optionally add feedback)...\n");

  try {
    const planResult = await Promise.race([
      plan.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 60000)),
    ]);
    console.log(`  ✅ Received: ${JSON.stringify(planResult)}\n`);
  } catch (e) {
    console.log(`  ⏰ Timed out or error: ${e}\n`);
  }
  await session.removePermissionForm(plan.actionId);

  // Close
  console.log("═══ Closing ═══");
  await session.updateStatus("Done!");
  await session.close({
    finalText: "Permission callback test completed!",
    stats: "interactive test",
  });
  console.log("Card closed. Done!");

  wsHandle.stop();
  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
