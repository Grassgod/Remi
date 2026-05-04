import { AcpProvider } from "../src/providers/acp/provider.js";

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
      const kind = event.kind;
      if (kind === "content_delta") {
        text += (event as any).text;
        process.stdout.write(".");
      } else if (kind === "thinking_delta") {
        process.stdout.write("t");
      } else if (kind === "tool_use") {
        const e = event as any;
        console.log(`\n  tool_use: ${e.name} input=${JSON.stringify(e.input)}`);
      } else if (kind === "tool_result") {
        const e = event as any;
        console.log(`  tool_result: ${e.name} (${e.durationMs}ms) preview=${e.resultPreview?.slice(0, 100)}`);
      } else if (kind === "result") {
        gotResult = true;
        const r = (event as any).response;
        console.log(`\n  result: session=${r.sessionId} model=${r.model} cost=$${r.costUsd} duration=${r.durationMs}ms tools=${JSON.stringify(r.toolCalls)}`);
      } else if (kind === "error") {
        console.log(`\n  ERROR: ${(event as any).error}`);
      } else {
        console.log(`\n  ${kind}`);
      }
    }
  } catch (err: any) {
    console.log(`\n  EXCEPTION: ${err.message}`);
  }

  clearTimeout(timeout);

  console.log(`\nEvents: ${eventCount}, result: ${gotResult}`);
  console.log(`Text: "${text.slice(0, 100)}"`);

  await provider.close();
  process.exit(0);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
