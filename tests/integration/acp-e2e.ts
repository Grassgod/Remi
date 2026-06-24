import { AcpProvider } from "../../src/providers/acp/provider.js";

async function main() {
  console.log("=== ACP E2E Smoke Test ===\n");

  const provider = new AcpProvider({
    agentType: "claude",
    cwd: "/data00/home/hehuajie",
  });

  console.log("Provider:", provider.name);

  // Health check
  const healthy = await provider.healthCheck();
  console.log("Health:", healthy ? "OK" : "FAIL");

  // Stream a simple prompt
  console.log("\n--- Streaming prompt ---");
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, 180000);

  let eventCount = 0;
  let gotResult = false;
  let text = "";

  try {
    for await (const event of provider.sendStream("读取 /tmp/acp_sdk_test.txt 的内容然后告诉我", {
      chatId: "e2e_test",
      signal: controller.signal,
    })) {
      eventCount++;
      const su = event.sessionUpdate;
      if (su === "agent_message_chunk") {
        const blocks = Array.isArray(event.content) ? event.content : [event.content];
        for (const b of blocks) { if (b.type === "text") text += b.text; }
        process.stdout.write(".");
      } else if (su === "agent_thought_chunk") {
        process.stdout.write("t");
      } else if (su === "tool_call") {
        const e = event as any;
        console.log(`\n  tool_call: ${e.title} rawInput=${JSON.stringify(e.rawInput)?.slice(0, 100)}`);
      } else if (su === "tool_call_update" && (event as any).status === "completed") {
        const e = event as any;
        console.log(`  tool_done: ${e.toolCallId}`);
      } else {
        // usage_update, plan, etc.
      }
    }
  } catch (err: any) {
    console.log(`\n  EXCEPTION: ${err.message}`);
  }

  clearTimeout(timeout);

  gotResult = true; // stream ended naturally = success
  const lastResponse = provider.getLastResponse?.();
  if (lastResponse) {
    console.log(`\n  result: session=${lastResponse.sessionId} model=${lastResponse.model} cost=$${lastResponse.costUsd}`);
  }
  console.log(`\nEvents: ${eventCount}, result: ${gotResult}`);
  console.log(`Text: "${text.slice(0, 100)}"`);

  await provider.close();
  process.exit(0);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
