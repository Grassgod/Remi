/**
 * Test final card patch with many step divs.
 * Simulates what happens when session.close() tries to patch a card
 * with 50, 80, 100+ tool step divs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFeishuClient } from "../src/connectors/feishu/client.js";
import { FeishuStreamingSession, buildFinalCard } from "../src/connectors/feishu/streaming.js";
import type { ToolEntry } from "../src/connectors/feishu/tool-formatters.js";

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

function makeEntries(count: number): ToolEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: i % 3 === 0 ? "Bash" : i % 3 === 1 ? "Read" : "Edit",
    input: i % 3 === 0
      ? { command: `echo step_${i}` }
      : { file_path: `/data00/home/hehuajie/project/remi/src/file_${i}.ts` },
    status: "done" as const,
    durationMs: 100 + i * 10,
    thinkingBefore: i % 5 === 0 ? `Thinking about step ${i}...` : "",
  }));
}

async function testFinalCard(count: number, config: ReturnType<typeof loadConfig>) {
  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);
  const session = new FeishuStreamingSession(client, creds);

  await session.start(config.chatId, "open_id", { sessionId: `limit-test-${count}` });

  const entries = makeEntries(count);
  const card = buildFinalCard({
    text: `Test with ${count} tool entries`,
    toolEntries: entries,
    toolCount: count,
    stats: `10s · ${count} tools`,
  });

  const cardJson = JSON.stringify(card);
  console.log(`  Card JSON size: ${(cardJson.length / 1024).toFixed(1)}KB`);

  // Count elements
  const countElements = (obj: any): number => {
    let c = 0;
    if (obj && typeof obj === "object") {
      if (obj.tag) c++;
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) { for (const item of v) c += countElements(item); }
        else if (typeof v === "object") c += countElements(v);
      }
    }
    return c;
  };
  console.log(`  Element count (tagged): ${countElements(card)}`);

  try {
    await session.close({ finalText: `Test: ${count} tools`, toolEntries: entries, toolCount: count, stats: `10s · ${count} tools` });
    console.log(`  ✅ Close succeeded with ${count} entries`);
  } catch (e) {
    console.log(`  ❌ Close failed: ${e}`);
  }
}

async function main() {
  const config = loadConfig();

  for (const count of [30, 50, 60, 80, 100]) {
    console.log(`\n═══ Test: ${count} tool entries ═══`);
    await testFinalCard(count, config);
    await Bun.sleep(1000);
  }

  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
