import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { controlPlaneConciergeHost } from "../../../apps/remi/cli/multiremi.js";
import type { FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import { deliverFeishuOutbound } from "@multiremi/worker/feishu-outbound.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

function fixture() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Ordered attachments", provider: "codex", workspaceId: "local" });
  for (const id of ["rt_files", "rt_other"]) {
    store.registerRuntime({ id, name: id, provider: "codex", workspaceId: "local", daemonId: id });
    store.heartbeatRuntime(id, { supportsFeishuBotConfig: true });
  }
  const config = store.upsertFeishuBotConfig("local", { agentId: agent.id, runtimeId: "rt_files", enabled: true,
    appId: "cli_order", appSecretOp: "set", appSecret: "test-order-secret", domain: "feishu" });
  store.reportFeishuBotRuntimeStatus("local", "rt_files", { state: "online", appliedRevision: config.revision });
  const submitted = store.submitFeishuBotMessage("local", "rt_files", { revision: config.revision,
    externalSessionKey: "ou_order", externalMessageId: "om_input", chatType: "p2p", chatId: "oc_order",
    senderOpenId: "ou_order", text: "Send reports" });
  const send = (filenames: string[], body = "") => store.sendChatAttachments(submitted.taskId,
    filenames.map(filename => ({ filename, sizeBytes: 4, contentType: filename.endsWith("png") ? "image/png" : "text/html",
      url: "/api/attachments/test/content" })), body);
  const claim = (now = new Date(Date.now() + 1_000), runtimeId = "rt_files") =>
    store.claimFeishuBotOutbound("local", runtimeId, now, true, true, true);
  return { store, send, claim };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Feishu attachment batch ordering", () => {
  it("waits for caption and a slow first file before a second worker can claim the next file", async () => {
    const f = fixture();
    const batch = f.send(["large-report.html", "small-chart.png"], "Report attached");
    const first = f.claim()!;
    expect(first.id).toBe(batch.delivery_ids[0]);
    const events: string[] = [];
    const caption = gate();
    const uploadStarted = gate();
    const uploaded = gate();
    const daemon = { downloadFeishuBotOutboundAttachment: async () => Buffer.from("data") } as unknown as MultiremiDaemon;
    const handle = {
      sendProactiveThreadReply: async () => { events.push("caption:start"); await caption.promise;
        events.push("caption:sent"); return { messageId: "om_caption" }; },
      sendProactiveAttachment: async (input: { filename: string }) => {
        events.push(`file:start:${input.filename}`);
        uploadStarted.resolve();
        await uploaded.promise;
        events.push(`file:sent:${input.filename}`);
        return { messageId: "om_file" };
      },
    } as unknown as FeishuChannelHandle;
    const host = controlPlaneConciergeHost({ daemon: () => daemon, current: () => handle,
      attach: () => {}, workspacesRoot: () => "/tmp/test" });
    const delivered = deliverFeishuOutbound(first, { signal: new AbortController().signal,
      send: options => host.sendOutbound!(first, options),
      report: async input => { expect(f.store.reportFeishuBotOutbound("local", "rt_files", first.id, input)).toBe(true); },
    });
    expect(events).toEqual(["caption:start"]);
    expect(f.claim()).toBeNull();
    caption.resolve();
    await uploadStarted.promise;
    expect(events).toEqual(["caption:start", "caption:sent", "file:start:large-report.html"]);
    expect(f.claim()).toBeNull();
    uploaded.resolve();
    await delivered;
    const second = f.claim()!;
    expect(second.id).toBe(batch.delivery_ids[1]);
    expect(second.body).toBe("");
    expect(second.attachments?.[0]?.filename).toBe("small-chart.png");
    expect(events.at(-1)).toBe("file:sent:large-report.html");
  });

  it("keeps later files waiting through retry backoff while another batch in the same Chat can run", () => {
    const f = fixture();
    const batch = f.send(["first.html", "second.png"]);
    const now = new Date(Date.now() + 1_000);
    const first = f.claim(now)!;
    const independent = f.send(["other.html"]);
    expect(f.claim(now, "rt_other")).toBeNull();
    const other = f.claim(now)!;
    expect(other.id).toBe(independent.delivery_ids[0]);
    expect(f.claim(now)).toBeNull();
    expect(f.store.reportFeishuBotOutbound("local", "rt_files", first.id,
      { claimToken: first.claimToken, status: "failed", error: "temporary upload error" }, now)).toBe(true);
    expect(f.claim(new Date(now.getTime() + 4_999))).toBeNull();
    const retry = f.claim(new Date(now.getTime() + 5_000))!;
    expect(retry.id).toBe(first.id);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(f.claim(new Date(now.getTime() + 5_001))).toBeNull();
    expect(f.store.reportFeishuBotOutbound("local", "rt_files", retry.id,
      { claimToken: retry.claimToken, status: "sent", externalMessageId: "om_retry" }, new Date(now.getTime() + 5_002))).toBe(true);
    expect(f.claim(new Date(now.getTime() + 5_003))?.id).toBe(batch.delivery_ids[1]);
  });

  it("reclaims an expired predecessor lease without releasing its successor or accepting the stale worker", async () => {
    const f = fixture();
    const batch = f.send(["first.html", "second.png"]);
    const now = new Date(Date.now() + 1_000);
    const claims = await Promise.all([Promise.resolve().then(() => f.claim(now)), Promise.resolve().then(() => f.claim(now))]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    const reclaimed = f.claim(new Date(now.getTime() + 120_001))!;
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.claimToken).not.toBe(first.claimToken);
    expect(reclaimed.idempotencyKey).toBe(first.idempotencyKey);
    expect(f.store.reportFeishuBotOutbound("local", "rt_files", first.id,
      { claimToken: first.claimToken, status: "sent", externalMessageId: "om_stale" })).toBe(false);
    expect(f.store.reportFeishuBotOutbound("local", "rt_files", first.id,
      { claimToken: first.claimToken, status: "failed", retryable: false, error: "stale failure" })).toBe(false);
    expect(f.claim(new Date(now.getTime() + 120_002))).toBeNull();
    expect(f.store.reportFeishuBotOutbound("local", "rt_files", reclaimed.id,
      { claimToken: reclaimed.claimToken, status: "sent", externalMessageId: "om_current" }, new Date(now.getTime() + 120_003))).toBe(true);
    expect(f.claim(new Date(now.getTime() + 120_004))?.id).toBe(batch.delivery_ids[1]);
  });

  for (const failure of ["non-retryable", "retry-exhausted"] as const) {
    it(`marks all remaining files failed after a ${failure} predecessor without blocking other batches`, () => {
      const f = fixture();
      const batch = f.send(["first.html", "second.png", "third.html", "fourth.png"]);
      const first = f.claim()!;
      expect(f.store.reportFeishuBotOutbound("local", "rt_files", first.id,
        { claimToken: first.claimToken, status: "sent", externalMessageId: "om_first" })).toBe(true);
      let now = new Date(Date.now() + 1_000);
      let failed = f.claim(now)!;
      expect(failed.id).toBe(batch.delivery_ids[1]);
      if (failure === "retry-exhausted") {
        for (let attempt = 0; attempt < 5; attempt++) {
          expect(f.store.reportFeishuBotOutbound("local", "rt_files", failed.id,
            { claimToken: failed.claimToken, status: "failed", error: "upload unavailable" }, now)).toBe(true);
          expect(f.claim(now)).toBeNull();
          now = new Date(now.getTime() + 300_000);
          failed = f.claim(now)!;
          expect(failed.id).toBe(batch.delivery_ids[1]);
        }
      }
      const other = f.send(["unrelated.html"]);
      expect(f.store.reportFeishuBotOutbound("local", "rt_files", failed.id,
        { claimToken: failed.claimToken, status: "failed", retryable: failure !== "non-retryable", error: "upload unavailable" }, now)).toBe(true);
      const rows = db!.query("SELECT id, status, last_error FROM multiremi_feishu_bot_outbound_deliveries WHERE id IN (?, ?, ?, ?) ORDER BY id")
        .all(...batch.delivery_ids) as Array<{ id: string; status: string; last_error: string | null }>;
      expect(rows.map(row => row.status)).toEqual(["sent", "failed", "failed", "failed"]);
      for (const row of rows.slice(2)) {
        expect(row.last_error).toContain(`earlier batch delivery ${failed.id} failed`);
        expect(row.last_error).toContain("upload unavailable");
      }
      expect(f.claim(now)?.id).toBe(other.delivery_ids[0]);
      expect(f.claim(now)).toBeNull();
    });
  }
});
