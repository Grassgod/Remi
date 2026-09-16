import { describe, expect, it } from "bun:test";
import { controlPlaneConciergeHost, createFeishuTaskHandler } from "../../../apps/remi/cli/multiremi.js";
import type { FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type { MultiremiFeishuBotOutboundDelivery } from "@multiremi/contracts/types.js";

describe("Feishu attachment Task handoff", () => {
  it("uploads every media item before submitting a claimable Task", async () => {
    const events: string[] = [];
    const daemon = {
      uploadFeishuBotAttachment: async (input: any) => {
        expect(input).toMatchObject({ revision: 4, externalSessionKey: "oc_private", externalMessageId: "om_input" });
        events.push(`upload:${input.fileName}`);
        return { id: `att_${input.fileName}` };
      },
      submitFeishuBotMessage: async (input: any) => {
        events.push("submit");
        expect(input.attachmentIds).toEqual(["att_report.pdf", "att_chart.png"]);
        return { deliveryQueued: true };
      },
    } as unknown as MultiremiDaemon;
    await createFeishuTaskHandler(daemon, 4, "Remi")({ chatId: "oc_private", text: "Read attachments",
      metadata: { messageId: "om_input", chatType: "p2p" }, media: [
        { fileName: "report.pdf", buffer: Buffer.from("pdf"), contentType: "application/pdf", mediaType: "file" },
        { fileName: "chart.png", buffer: Buffer.from("png"), contentType: "image/png", mediaType: "image" },
      ] }, "oc_private", async () => { throw new Error("queued delivery must not create another stream"); });
    expect(events).toEqual(["upload:report.pdf", "upload:chart.png", "submit"]);
  });

  it("does not submit a Task without its attachments when upload fails", async () => {
    let submitted = false;
    const daemon = {
      uploadFeishuBotAttachment: async () => { throw new Error("Attachment upload failed"); },
      submitFeishuBotMessage: async () => { submitted = true; },
    } as unknown as MultiremiDaemon;
    await expect(createFeishuTaskHandler(daemon, 4, "Remi")({ chatId: "oc_private", text: "Read attachment",
      metadata: { messageId: "om_input" }, media: [
        { fileName: "report.pdf", buffer: Buffer.from("pdf"), contentType: "application/pdf", mediaType: "file" },
      ] }, "oc_private", async () => {})).rejects.toThrow("Attachment upload failed");
    expect(submitted).toBe(false);
  });
});

describe("Feishu attachment concierge delivery", () => {
  const base: MultiremiFeishuBotOutboundDelivery = {
    id: "fbo_attachments", claimToken: "claim_attachment_lease", chatId: "oc_original", threadId: null,
    replyToMessageId: null, body: "", bodyOrigin: "agent", idempotencyKey: "delivery_attachment_uuid",
    attachments: [
      { id: "att_report", filename: "report.html", contentType: "text/html", sizeBytes: 4 },
      { id: "att_image", filename: "chart.png", contentType: "image/png", sizeBytes: 4 },
    ],
  };

  for (const route of [
    { name: "private chat", threadId: null, replyToMessageId: null, expected: undefined },
    { name: "thread root", threadId: "om_root", replyToMessageId: null, expected: "om_root" },
    { name: "thread reply", threadId: "om_root", replyToMessageId: "om_reply", expected: "om_reply" },
  ]) {
    it(`downloads through the delivery lease and sends to the original ${route.name}`, async () => {
      const sent: any[] = [];
      const downloads: string[] = [];
      const bytes = Buffer.from("data");
      const daemon = { downloadFeishuBotOutboundAttachment: async (deliveryId: string, claimToken: string, id: string) => {
        expect(deliveryId).toBe(base.id);
        expect(claimToken).toBe(base.claimToken);
        downloads.push(id);
        return bytes;
      } } as unknown as MultiremiDaemon;
      const handle = { sendProactiveAttachment: async (input: any) => { sent.push(input); return { messageId: `om_${input.filename}` }; } } as FeishuChannelHandle;
      const host = controlPlaneConciergeHost({ daemon: () => daemon, current: () => handle, attach: () => {}, workspacesRoot: () => "/tmp/test" });
      const delivery = { ...base, threadId: route.threadId, replyToMessageId: route.replyToMessageId };
      const result = await host.sendOutbound!(delivery);
      expect(result.messageId).toBe("om_chart.png");
      expect(downloads).toEqual(["att_report", "att_image"]);
      expect(sent[0]).toMatchObject({ chatId: "oc_original", replyToMessageId: route.expected, filename: "report.html", buffer: bytes });
      expect(sent[1]).toMatchObject({ chatId: "oc_original", replyToMessageId: route.expected, filename: "chart.png", contentType: "image/png" });
      expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey);
      expect(sent[0].idempotencyKey.length).toBeLessThanOrEqual(50);
      await host.sendOutbound!(delivery);
      expect(sent[2].idempotencyKey).toBe(sent[0].idempotencyKey);
      expect(sent[3].idempotencyKey).toBe(sent[1].idempotencyKey);
    });
  }

  it("awaits the caption before sending the first file and keeps retry UUIDs and the original thread", async () => {
    const events: string[] = [];
    const captions: any[] = [];
    const sent: any[] = [];
    const claims: string[] = [];
    let releaseCaption!: () => void;
    const captionGate = new Promise<void>(resolve => { releaseCaption = resolve; });
    const daemon = { downloadFeishuBotOutboundAttachment: async (_id: string, claimToken: string) => {
      events.push("download");
      claims.push(claimToken);
      return Buffer.from("html");
    } } as unknown as MultiremiDaemon;
    const handle = {
      sendProactiveThreadReply: async (input: any) => {
        captions.push(input);
        events.push("caption:start");
        if (captions.length === 1) await captionGate;
        events.push("caption:sent");
        return { messageId: "om_caption" };
      },
      sendProactiveAttachment: async (input: any) => {
        sent.push(input);
        events.push("attachment");
        if (sent.length === 1) throw new Error("attachment acknowledgement lost");
        return { messageId: "om_file" };
      },
    } as unknown as FeishuChannelHandle;
    const host = controlPlaneConciergeHost({ daemon: () => daemon, current: () => handle, attach: () => {}, workspacesRoot: () => "/tmp/test" });
    // The server creates one delivery per file; only the first has a caption.
    const delivery = { ...base, body: "Report attached", threadId: "om_root", replyToMessageId: "om_reply",
      attachments: base.attachments!.slice(0, 1) };
    const first = host.sendOutbound!(delivery);
    expect(events).toEqual(["caption:start"]);
    expect(sent).toHaveLength(0);
    releaseCaption();
    await expect(first).rejects.toThrow("attachment acknowledgement lost");
    expect(events).toEqual(["caption:start", "caption:sent", "download", "attachment"]);

    await expect(host.sendOutbound!({ ...delivery, claimToken: "retry_lease" })).resolves.toEqual({ messageId: "om_file" });
    expect(events).toEqual(["caption:start", "caption:sent", "download", "attachment",
      "caption:start", "caption:sent", "download", "attachment"]);
    expect(claims).toEqual([base.claimToken, "retry_lease"]);
    expect(captions[0]).toMatchObject({ chatId: "oc_original", replyToMessageId: "om_reply", body: "Report attached" });
    expect(captions[1]).toEqual(captions[0]);
    for (const attachment of sent) {
      expect(attachment).toMatchObject({ chatId: "oc_original", replyToMessageId: "om_reply", filename: "report.html" });
      expect(attachment.idempotencyKey).not.toBe(captions[0].idempotencyKey);
    }
    expect(sent[1].idempotencyKey).toBe(sent[0].idempotencyKey);
  });

  it("stops before sending when the attachment download loses its lease", async () => {
    let sent = false;
    const controller = new AbortController();
    const daemon = { downloadFeishuBotOutboundAttachment: async () => { controller.abort(); return Buffer.from("data"); } } as unknown as MultiremiDaemon;
    const handle = { sendProactiveAttachment: async () => { sent = true; return { messageId: "om_sent" }; } } as unknown as FeishuChannelHandle;
    const host = controlPlaneConciergeHost({ daemon: () => daemon, current: () => handle, attach: () => {}, workspacesRoot: () => "/tmp/test" });
    await expect(host.sendOutbound!(base, { signal: controller.signal, onStarted: async () => {} })).rejects.toThrow();
    expect(sent).toBe(false);
  });
});
