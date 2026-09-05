import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiFeishuBotOutboundDelivery } from "@multiremi/contracts/types.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

interface Harness {
  run: (delivery: MultiremiFeishuBotOutboundDelivery) => Promise<void>;
  sentBodies: string[];
  uploaded: Buffer[];
  reports: Array<Record<string, unknown>>;
}

function harness(): Harness {
  const daemon = Object.create(MultiremiDaemon.prototype) as MultiremiDaemon & Record<string, unknown>;
  const sentBodies: string[] = [];
  const uploaded: Buffer[] = [];
  const reports: Array<Record<string, unknown>> = [];
  Object.assign(daemon, {
    options: { serverUrl: "https://remi.example.test" },
    client: {
      fetchFeishuBotOutboundAttachment: async () => {
        throw new Error("attachment unavailable");
      },
      reportFeishuBotOutboundResult: async (
        _runtimeId: string,
        _deliveryId: string,
        input: Record<string, unknown>,
      ) => { reports.push(input); },
    },
    feishuConcierge: {
      uploadImage: async (image: Buffer) => {
        uploaded.push(image);
        return { imageKey: "img_uploaded" };
      },
      sendOutbound: async (delivery: MultiremiFeishuBotOutboundDelivery) => {
        sentBodies.push(delivery.body);
        return { messageId: "om_sent" };
      },
    },
  });
  return {
    run: (delivery) => (
      daemon as unknown as {
        handleFeishuBotOutbound(runtimeId: string, input: MultiremiFeishuBotOutboundDelivery): Promise<void>;
      }
    ).handleFeishuBotOutbound("rt_images", delivery),
    sentBodies,
    uploaded,
    reports,
  };
}

function delivery(
  body: string,
  bodyOrigin: MultiremiFeishuBotOutboundDelivery["bodyOrigin"],
): MultiremiFeishuBotOutboundDelivery {
  return {
    id: `fbo_${bodyOrigin}`,
    claimToken: `claim_${bodyOrigin}`,
    chatId: "oc_images",
    threadId: null,
    replyToMessageId: null,
    body,
    bodyOrigin,
    idempotencyKey: `fbo_${bodyOrigin}`,
  };
}

describe("daemon Feishu outbound image resolution", () => {
  it("rejects Issue local paths but uploads Agent local images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-feishu-image-"));
    const imagePath = join(directory, "chart.png");
    await writeFile(imagePath, Buffer.from("png"));
    const test = harness();
    try {
      await test.run(delivery(`![chart](${imagePath})`, "issue"));
      expect(test.sentBodies).toEqual(["[图片: chart]"]);
      expect(test.uploaded).toHaveLength(0);

      await test.run(delivery(`![chart](${imagePath})`, "agent"));
      expect(test.sentBodies.at(-1)).toBe("![chart](feishu-image:img_uploaded)");
      expect(test.uploaded).toEqual([Buffer.from("png")]);
      expect(test.reports.map((report) => report.status)).toEqual(["sent", "sent"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the server URL for clickable attachment fallback without failing delivery", async () => {
    const test = harness();

    await test.run(delivery("![capture](/api/attachments/att_capture/content)", "issue"));

    expect(test.sentBodies).toEqual([
      "[图片: capture](https://remi.example.test/api/attachments/att_capture/content)",
    ]);
    expect(test.reports).toEqual([{
      claimToken: "claim_issue",
      status: "sent",
      externalMessageId: "om_sent",
    }]);
  });
});
