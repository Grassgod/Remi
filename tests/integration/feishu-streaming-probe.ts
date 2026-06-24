#!/usr/bin/env bun
/**
 * Phase 2 实测脚本：飞书流式卡片 10-min 边界行为探针
 *
 * 用法:
 *   EXP=1 bun run tests/feishu-streaming-probe.ts            # 默认 18 min
 *   EXP=2 DURATION_MIN=15 bun run tests/feishu-streaming-probe.ts
 *
 * 实验:
 *   EXP=1: 在 t=8min 调 PATCH(streaming_mode:true) 带完整 streaming_config，看是否重置 10-min
 *   EXP=2: 全程纯 PUT，不调 PATCH，看 600s 后失败模式
 *   EXP=3: t=8min 主动 close + 新建卡 B 接续 (待实现)
 *   EXP=4: 极简卡片 (status_bar only) 对照
 *
 * 日志: /tmp/feishu-probe-exp{N}.log
 */

import { readFileSync, appendFileSync, writeFileSync } from "node:fs";

const CHAT_ID = "oc_47c65d5f9f30ecf69649b734b01cf3c9";
const EXP = process.env.EXP ?? "1";
const DURATION_MIN = Number(process.env.DURATION_MIN ?? "18");
const TICK_INTERVAL_MS = 10_000;
const LOG = `/tmp/feishu-probe-exp${EXP}.log`;
const API = "https://open.feishu.cn/open-apis";

writeFileSync(LOG, "");

function readCreds() {
  const toml = readFileSync(`${process.env.HOME}/.remi/remi.toml`, "utf-8");
  const m = toml.match(/\[feishu\]\s*([\s\S]*?)(\n\[|$)/);
  if (!m) throw new Error("no [feishu] section");
  const block = m[1];
  const appId = block.match(/^\s*app_id\s*=\s*"([^"]+)"/m)?.[1];
  const appSecret = block.match(/^\s*app_secret\s*=\s*"([^"]+)"/m)?.[1];
  if (!appId || !appSecret) throw new Error("missing app_id / app_secret in [feishu]");
  return { appId, appSecret };
}

const creds = readCreds();

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

async function getToken() {
  const r = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const d: any = await r.json();
  if (d.code !== 0) throw new Error(`token: ${d.msg}`);
  return d.tenant_access_token as string;
}

async function createCard(token: string, exp: string) {
  const cardJson: any = {
    schema: "2.0",
    config: {
      width_mode: "fill",
      streaming_mode: true,
      streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 2 } },
    },
    header: {
      title: {
        tag: "plain_text",
        content: `[PROBE-EXP${exp}] ${new Date().toLocaleTimeString("zh-CN")}`,
      },
    },
    body: {
      elements:
        exp === "4"
          ? [{ tag: "markdown", content: "init", element_id: "status_bar" }]
          : [
              { tag: "markdown", content: "init", element_id: "status_bar" },
              { tag: "markdown", content: "", element_id: "content" },
            ],
    },
  };
  const r = await fetch(`${API}/cardkit/v1/cards`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
  });
  const d: any = await r.json();
  log(`createCard HTTP=${r.status} code=${d.code} msg="${d.msg}" cardId=${d.data?.card_id}`);
  if (d.code !== 0) throw new Error(`createCard failed: ${d.msg}`);
  return d.data.card_id as string;
}

async function sendCard(token: string, cardId: string, replyToMessageId?: string) {
  const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });
  let r: Response;
  if (replyToMessageId) {
    r = await fetch(`${API}/im/v1/messages/${replyToMessageId}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "interactive", content: cardContent, reply_in_thread: true }),
    });
  } else {
    r = await fetch(`${API}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ receive_id: CHAT_ID, msg_type: "interactive", content: cardContent }),
    });
  }
  const d: any = await r.json();
  log(`sendCard${replyToMessageId ? "(reply)" : ""} HTTP=${r.status} code=${d.code} msg="${d.msg}" messageId=${d.data?.message_id}`);
  if (d.code !== 0) throw new Error(`sendCard failed: ${d.msg}`);
  return d.data.message_id as string;
}

let seq = 1;

async function updateElement(
  token: string,
  cardId: string,
  elementId: string,
  content: string,
  elapsed: number,
) {
  seq += 1;
  const t0 = Date.now();
  const r = await fetch(
    `${API}/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content, sequence: seq, uuid: `probe_${cardId}_${seq}` }),
    },
  );
  const body = await r.text();
  let d: any = {};
  try { d = JSON.parse(body); } catch {}
  const dt = Date.now() - t0;
  log(`PUT t=${elapsed}s ${elementId} HTTP=${r.status} code=${d.code} seq=${seq} dt=${dt}ms body="${body.slice(0, 200).replace(/\n/g, " ")}"`);
  return r.status === 200 && d.code === 0;
}

async function patchSettings(
  token: string,
  cardId: string,
  settings: object,
  label: string,
  elapsed: number,
) {
  seq += 1;
  const t0 = Date.now();
  const r = await fetch(`${API}/cardkit/v1/cards/${cardId}/settings`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      settings: JSON.stringify(settings),
      sequence: seq,
      uuid: `probe_${label}_${cardId}_${seq}`,
    }),
  });
  const body = await r.text();
  let d: any = {};
  try { d = JSON.parse(body); } catch {}
  const dt = Date.now() - t0;
  log(`PATCH(${label}) t=${elapsed}s HTTP=${r.status} code=${d.code} seq=${seq} dt=${dt}ms body="${body.slice(0, 400).replace(/\n/g, " ")}"`);
  return r.status === 200 && d.code === 0;
}

async function tickLoop(
  token: string,
  cardId: string,
  t0: number,
  endAt: number,
  label: string,
): Promise<{ firstFailureAt: number; lastSuccessAt: number }> {
  let firstFailureAt = -1;
  let lastSuccessAt = -1;
  while (true) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (elapsed >= endAt) break;
    const tickText = `[${label}] tick=${seq + 1} elapsed=${elapsed}s wallclock=${new Date().toLocaleTimeString("zh-CN")}`;
    const ok = await updateElement(token, cardId, "status_bar", tickText, elapsed);
    if (ok) lastSuccessAt = elapsed;
    if (!ok && firstFailureAt < 0) {
      firstFailureAt = elapsed;
      log(`!!! [${label}] FIRST FAILURE at t=${elapsed}s`);
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
  return { firstFailureAt, lastSuccessAt };
}

async function runExp1Or2(token: string) {
  const cardId = await createCard(token, EXP);
  await sendCard(token, cardId);
  log(`>>> Card live: cardId=${cardId} — Phase 2 timer starts now`);

  const t0 = Date.now();
  let renewedAt = -1;
  let firstFailureAt = -1;

  while (true) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (elapsed >= DURATION_MIN * 60) break;

    if (EXP === "1" && elapsed >= 480 && renewedAt < 0) {
      renewedAt = elapsed;
      const ok = await patchSettings(
        token,
        cardId,
        {
          config: {
            streaming_mode: true,
            streaming_config: {
              print_frequency_ms: { default: 50 },
              print_step: { default: 2 },
            },
          },
        },
        "renew-full-config",
        elapsed,
      );
      log(`>>> EXP1 PATCH renew at t=${elapsed}s → ok=${ok}`);
    }

    const tickText = `tick=${seq + 1} elapsed=${elapsed}s wallclock=${new Date().toLocaleTimeString("zh-CN")}`;
    const ok = await updateElement(token, cardId, "status_bar", tickText, elapsed);
    if (!ok && firstFailureAt < 0) {
      firstFailureAt = elapsed;
      log(`!!! FIRST FAILURE at t=${elapsed}s`);
    }

    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }

  const finalElapsed = Math.round((Date.now() - t0) / 1000);
  await patchSettings(
    token,
    cardId,
    { config: { streaming_mode: false, summary: { content: "[PROBE END]" } } },
    "close",
    finalElapsed,
  );
  log(`=== EXP${EXP} END elapsed=${finalElapsed}s renewedAt=${renewedAt}s firstFailureAt=${firstFailureAt}s ===`);
}

async function runExp3(token: string) {
  // Card A: 0~8min, then close + create B as thread reply
  log(`>>> EXP3 — Card A starts now`);
  const cardA = await createCard(token, "3-A");
  const msgA = await sendCard(token, cardA);
  const t0 = Date.now();
  log(`>>> Card A live: cardId=${cardA} messageId=${msgA}`);

  const aResult = await tickLoop(token, cardA, t0, 480, "A");
  log(`>>> Card A tick window done. lastSuccess=${aResult.lastSuccessAt}s firstFailure=${aResult.firstFailureAt}s`);

  // Close A with summary
  const closeAElapsed = Math.round((Date.now() - t0) / 1000);
  await patchSettings(
    token,
    cardA,
    {
      config: {
        streaming_mode: false,
        summary: { content: `[A→B handoff at t=${closeAElapsed}s]` },
      },
    },
    "close-A",
    closeAElapsed,
  );

  // Create B as thread reply to A's message
  const cardB = await createCard(token, "3-B");
  const msgB = await sendCard(token, cardB, msgA);
  log(`>>> Card B live: cardId=${cardB} messageId=${msgB} (thread reply to ${msgA})`);

  const bStartElapsed = Math.round((Date.now() - t0) / 1000);
  log(`>>> EXP3 — Card B handoff complete at t=${bStartElapsed}s, will tick until t=${bStartElapsed + 480}s`);
  // B runs for another 8 min (relative to A's t0)
  const bEndAt = Math.min(DURATION_MIN * 60, bStartElapsed + 480);
  const bResult = await tickLoop(token, cardB, t0, bEndAt, "B");
  log(`>>> Card B tick window done. lastSuccess=${bResult.lastSuccessAt}s firstFailure=${bResult.firstFailureAt}s`);

  const finalElapsed = Math.round((Date.now() - t0) / 1000);
  await patchSettings(
    token,
    cardB,
    { config: { streaming_mode: false, summary: { content: "[PROBE END]" } } },
    "close-B",
    finalElapsed,
  );
  log(`=== EXP3 END elapsed=${finalElapsed}s | A: lastOk=${aResult.lastSuccessAt}s firstFail=${aResult.firstFailureAt}s | B: lastOk=${bResult.lastSuccessAt}s firstFail=${bResult.firstFailureAt}s ===`);
}

async function main() {
  log(`=== EXP${EXP} START duration=${DURATION_MIN}min chat=${CHAT_ID} ===`);
  const token = await getToken();
  if (EXP === "3") return runExp3(token);
  return runExp1Or2(token);
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
