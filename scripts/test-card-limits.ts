/**
 * Test Feishu CardKit element limits and operations.
 *
 * Tests:
 * 1. How many step divs can fit in a card (find the actual limit)
 * 2. Whether delete element API works
 * 3. Whether a div with icon+text counts as 1 or 3 elements
 *
 * Usage: bun run scripts/test-card-limits.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFeishuClient } from "../src/connectors/feishu/client.js";
import { FeishuStreamingSession } from "../src/connectors/feishu/streaming.js";
import { buildStepDiv } from "../src/connectors/feishu/tool-formatters.js";

function loadConfig() {
  const paths = [join(process.cwd(), "remi.toml"), join(process.env.HOME || "/home", ".remi", "remi.toml")];
  let toml = "";
  for (const p of paths) { try { toml = readFileSync(p, "utf-8"); break; } catch {} }
  if (!toml) throw new Error("remi.toml not found");
  const appId = toml.match(/app_id\s*=\s*"([^"]+)"/)?.[1] ?? "";
  const appSecret = toml.match(/app_secret\s*=\s*"([^"]+)"/)?.[1] ?? "";
  const domain = toml.match(/domain\s*=\s*"([^"]+)"/)?.[1] ?? "feishu";
  const chatId = toml.match(/trigger_user_ids\s*=\s*\[\s*"([^"]+)"/)?.[1] ?? "";
  return { appId, appSecret, domain, chatId };
}

async function getToken(config: ReturnType<typeof loadConfig>): Promise<string> {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    },
  );
  const data = await res.json() as any;
  return data.tenant_access_token;
}

async function main() {
  const config = loadConfig();
  const creds = { appId: config.appId, appSecret: config.appSecret, domain: config.domain as any };
  const client = createFeishuClient(creds);
  const session = new FeishuStreamingSession(client, creds);

  // Create streaming card
  await session.start(config.chatId, "open_id", { sessionId: "test-limits" });
  console.log("🎬 Card created");

  // Test 1: Add step divs one by one, count how many succeed
  console.log("\n═══ Test 1: Find element limit ═══");
  let added = 0;
  const stepIds: string[] = [];

  for (let i = 0; i < 100; i++) {
    const stepId = `step_${i}`;
    stepIds.push(stepId);
    const element = { ...buildStepDiv("Bash", `Step ${i}: echo test_${i}`), element_id: stepId };

    // Use the queue to serialize
    try {
      const token = await getToken(config);
      const res = await fetch(
        `https://open.feishu.cn/open-apis/cardkit/v1/cards/${(session as any).state.cardId}/elements`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "append",
            target_element_id: "process_panel",
            sequence: (session as any).state.sequence + i + 1,
            elements: JSON.stringify([element]),
          }),
        },
      );
      if (res.ok) {
        added++;
        if (added % 10 === 0) process.stdout.write(`${added}..`);
      } else {
        const body = await res.text();
        console.log(`\n❌ Failed at step ${i}: ${body.slice(0, 200)}`);
        break;
      }
    } catch (e) {
      console.log(`\n❌ Error at step ${i}: ${e}`);
      break;
    }
  }
  console.log(`\n✅ Successfully added ${added} step divs`);

  // Test 2: Delete element
  if (added > 0) {
    console.log("\n═══ Test 2: Delete element ═══");
    const deleteId = `step_0`;
    const token = await getToken(config);
    const seq = (session as any).state.sequence + added + 2;
    const res = await fetch(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${(session as any).state.cardId}/elements/${deleteId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sequence: seq,
          uuid: `del_${deleteId}_${seq}`,
        }),
      },
    );
    if (res.ok) {
      console.log(`✅ Delete step_0 succeeded`);
    } else {
      const body = await res.text();
      console.log(`❌ Delete failed: ${body.slice(0, 300)}`);
    }

    // Try adding one more after delete
    const addRes = await fetch(
      `https://open.feishu.cn/open-apis/cardkit/v1/cards/${(session as any).state.cardId}/elements`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "append",
          target_element_id: "process_panel",
          sequence: seq + 1,
          elements: JSON.stringify([{ ...buildStepDiv("Bash", `Step AFTER DELETE`), element_id: "step_after_delete" }]),
        }),
      },
    );
    if (addRes.ok) {
      console.log(`✅ Add after delete succeeded (total capacity freed)`);
    } else {
      const body = await addRes.text();
      console.log(`❌ Add after delete failed: ${body.slice(0, 200)}`);
    }
  }

  // Test 3: Close with final card to see if the limit applies to final card too
  console.log("\n═══ Test 3: Close card ═══");
  await session.close({ finalText: `Element limit test: added ${added} divs` });
  console.log("✅ Card closed");

  process.exit(0);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
