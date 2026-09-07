/**
 * Probe full-card element limits using message patches, without CardKit.
 * Usage: bun run tests/manual/test-card-limits.ts
 */
import { createFeishuClient } from "@connectors/feishu/client.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { buildStepDiv } from "@connectors/feishu/tool-formatters.js";
import { loadConfig } from "./_load-config.js";

async function main() {
  const config = loadConfig();
  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);
  const session = new FeishuStreamingSession(client, creds);
  await session.start(config.chatId, "open_id", { displayName: "Card limit probe" });
  const messageId = session.getMessageId()!;
  session.detach();

  const elements: Record<string, unknown>[] = [];
  for (let index = 0; index < 100; index++) {
    elements.push(buildStepDiv("Bash", `Step ${index}: echo test_${index}`));
    const result = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ schema: "2.0", body: { elements } }) },
    });
    if (result.code !== 0) {
      elements.pop();
      console.log(`Rejected at ${index + 1} elements: ${result.msg}`);
      break;
    }
    console.log(`Patched ${elements.length} elements`);
    await Bun.sleep(1000);
  }

  const resumed = new FeishuStreamingSession(client, creds);
  await resumed.start(config.chatId, "open_id", {
    displayName: "Card limit probe",
    durable: { messageId, idempotencyKey: `card-limit-${Date.now()}` },
  });
  await resumed.close({ finalText: `Full-card patches accepted ${elements.length} step elements.` });
}

main().catch(error => { console.error("Fatal:", error); process.exit(1); });
