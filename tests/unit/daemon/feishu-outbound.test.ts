import { describe, expect, it } from "bun:test";
import { deliverFeishuOutbound } from "@multiremi/worker/feishu-outbound.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

const delivery = { id: "fbo_1", taskId: "tsk_1", claimToken: "claim_1", chatId: "oc_1", threadId: "om_root",
  replyToMessageId: "om_root", body: "", bodyOrigin: "agent" as const, idempotencyKey: "fbo_1" };

describe("proactive delivery execution", () => {
  it("renews a binary delivery lease while upload is pending without a task ID", async () => {
    const reports: any[] = [];
    let unblock!: () => void;
    await deliverFeishuOutbound({ ...delivery, taskId: undefined, attachments: [{ id: "att_1", filename: "report.html", contentType: "text/html", sizeBytes: 8 }] }, {
      signal: new AbortController().signal, renewMs: 2,
      send: async () => {
        await new Promise<void>(resolve => { unblock = resolve; });
        return { messageId: "om_file" };
      },
      report: async input => { reports.push(input); if (input.status === "streaming") unblock(); },
    });
    expect(reports[0]).toMatchObject({ status: "streaming" });
    expect(reports.at(-1)).toMatchObject({ status: "sent", externalMessageId: "om_file" });
  });

  it("renews while task consumption is blocked and persists the card before success", async () => {
    const reports: any[] = [];
    let unblock!: () => void;
    await deliverFeishuOutbound(delivery, { signal: new AbortController().signal, renewMs: 2,
      send: async ({ onStarted }) => {
        await onStarted("om_card");
        await new Promise<void>(resolve => { unblock = resolve; });
        return { messageId: "om_card" };
      },
      report: async input => { reports.push(input); if (reports.length === 3) unblock(); },
    });
    expect(reports[0]).toMatchObject({ status: "streaming", externalMessageId: "om_card" });
    expect(reports.filter(r => r.status === "streaming")).toHaveLength(3);
    expect(reports.at(-1)).toMatchObject({ status: "sent", externalMessageId: "om_card" });
  });

  it("aborts the stream and never marks sent after losing the lease", async () => {
    const reports: any[] = [];
    await expect(deliverFeishuOutbound(delivery, { signal: new AbortController().signal, renewMs: 2,
      send: async ({ signal }) => {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        return { messageId: "unreachable" };
      },
      report: async input => { reports.push(input); throw new Error("stale lease"); },
    })).rejects.toThrow("stale lease");
    expect(reports.some(r => r.status === "sent")).toBe(false);
  });

  it("queues sends without blocking daemon heartbeats and suppresses duplicate claims", async () => {
    const daemon = Object.create(MultiremiDaemon.prototype) as any;
    let finish!: () => void;
    let sends = 0;
    Object.assign(daemon, { pollAbort: new AbortController(), feishuOutboundRuns: new Map(),
      handleFeishuBotOutbound: async () => { sends++; await new Promise<void>(resolve => { finish = resolve; }); },
    });
    expect(daemon.queueFeishuBotOutbound("rt_1", delivery)).toBeUndefined();
    daemon.queueFeishuBotOutbound("rt_1", delivery);
    await Promise.resolve();
    expect(sends).toBe(1);
    const done = daemon.feishuOutboundRuns.get(delivery.id).done;
    finish();
    await done;
    expect(daemon.feishuOutboundRuns.size).toBe(0);
  });
});
