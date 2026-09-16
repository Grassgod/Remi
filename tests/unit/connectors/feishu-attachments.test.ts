import { describe, expect, it } from "bun:test";
import { FEISHU_ATTACHMENT_MAX_BYTES, prepareIncomingFeishuMedia, sanitizeFeishuAttachmentName } from "@connectors/feishu/incoming-media.js";
import { downloadMessageResourceFeishu, FEISHU_IMAGE_UPLOAD_MAX_BYTES, FeishuAttachmentTooLargeError, sendAttachmentFeishu, sendFileFeishu, sendImageFeishu } from "@connectors/feishu/media.js";
import { resolveFeishuMedia } from "@connectors/feishu/receive.js";

describe("Feishu incoming attachments", () => {
  it("sanitizes paths and controls, keeps extensions, and bounds UTF-8 filenames", () => {
    expect(sanitizeFeishuAttachmentName("../../private/报告\u0000\n.pdf")).toBe("报告.pdf");
    expect(sanitizeFeishuAttachmentName("C:\\private\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFeishuAttachmentName("..", "attachment.bin")).toBe("attachment.bin");
    const long = sanitizeFeishuAttachmentName("报告".repeat(200) + ".pdf");
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(180);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("hands off media bytes without local paths and gives collisions distinct names", () => {
    const pdf = Buffer.from("PDF bytes");
    const image = Buffer.from("image bytes");
    const prepared = prepareIncomingFeishuMedia({ messageId: "om_input", text: "<media:document>\n<media:document>\n<media:image>\n<media:sticker>", media: [
      { buffer: pdf, fileName: "../report.pdf", placeholder: "<media:document>" },
      { buffer: pdf, fileName: "report.pdf", placeholder: "<media:document>" },
      { buffer: image, contentType: "image/png", imageKey: "img_original", placeholder: "<media:image>" },
      { buffer: Buffer.alloc(0), placeholder: "<media:sticker>" },
    ] });
    expect(prepared.media.map(item => item.fileName)).toEqual(["report.pdf", "report-2.pdf", "image.png"]);
    expect(prepared.media[0]!.buffer).toBe(pdf);
    expect(prepared.text).toContain("[附件: report.pdf]");
    expect(prepared.text).toContain("[表情]");
    expect(prepared.text).toContain('{"image_key":"img_original","message_id":"om_input"}');
    expect(prepared.text).not.toContain("/tmp/");
  });

  it("keeps a rich post usable when it includes more images than the submit API accepts", () => {
    const prepared = prepareIncomingFeishuMedia({ messageId: "om_many_images", text: "Read this report",
      media: Array.from({ length: 12 }, (_, index) => ({ buffer: Buffer.from("image"), contentType: "image/png",
        fileName: `chart-${index + 1}.png`, imageKey: `img_${index + 1}`, placeholder: "<media:image>" })),
    });
    expect(prepared.media).toHaveLength(10);
    expect(prepared.media[9]!.fileName).toBe("chart-10.png");
    expect(prepared.text).toContain("Read this report");
    expect(prepared.text).toContain("附件 chart-11.png 超过每条消息 10 个附件上限，未接收");
    expect(prepared.text).toContain("附件 chart-12.png 超过每条消息 10 个附件上限，未接收");
    expect(prepared.text).toContain('"image_key":"img_12"');
  });

  it("stops reading an oversized stream before consuming the remaining bytes", async () => {
    let reads = 0;
    let closed = false;
    const client = { im: { messageResource: { get: async () => ({ getReadableStream: () => (async function* () {
      try {
        reads++; yield Buffer.alloc(FEISHU_ATTACHMENT_MAX_BYTES);
        reads++; yield Buffer.alloc(1);
        reads++; yield Buffer.alloc(1024);
      } finally { closed = true; }
    })() }) } } } as any;
    await expect(downloadMessageResourceFeishu(client, "om_input", "file_key", "file")).rejects.toBeInstanceOf(FeishuAttachmentTooLargeError);
    expect(reads).toBe(2);
    expect(closed).toBe(true);
  });

  it("keeps oversized and failed downloads visible without creating empty attachments", async () => {
    const client = { im: { messageResource: { get: async () => Buffer.alloc(FEISHU_ATTACHMENT_MAX_BYTES + 1) } } } as any;
    const media = await resolveFeishuMedia(client, "om_input", "file", JSON.stringify({ file_key: "file_key", file_name: "big.pdf" }));
    expect(media[0]?.rejectedReason).toBe("too_large");
    const prepared = prepareIncomingFeishuMedia({ messageId: "om_input", text: "<media:document>", media });
    expect(prepared.media).toEqual([]);
    expect(prepared.text).toContain("附件 big.pdf 超过 20MB 未接收");
    const failed = await resolveFeishuMedia({ im: { messageResource: { get: async () => { throw new Error("unavailable"); } } } } as any,
      "om_failed", "file", JSON.stringify({ file_key: "file_key", file_name: "lost.pdf" }));
    expect(prepareIncomingFeishuMedia({ messageId: "om_failed", text: "", media: failed }).text).toContain("下载失败");
  });

  it("does not attempt to download stickers", async () => {
    const media = await resolveFeishuMedia({} as any, "om_sticker", "sticker", JSON.stringify({ file_key: "sticker_key" }));
    const prepared = prepareIncomingFeishuMedia({ messageId: "om_sticker", text: "", media });
    expect(prepared.text.trim()).toBe("[表情]");
    expect(prepared.media).toEqual([]);
  });

  it("downloads the video resource rather than its poster and preserves its MIME", async () => {
    const client = { im: { messageResource: { get: async (input: any) => {
      expect(input.path.file_key).toBe("file_video");
      expect(input.params.type).toBe("file");
      return { data: Buffer.from("video bytes"), headers: { "content-type": "video/mp4" } };
    } } } } as any;
    const media = await resolveFeishuMedia(client, "om_video", "media", JSON.stringify({ file_key: "file_video", image_key: "img_poster", file_name: "clip.mp4" }));
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ fileName: "clip.mp4", contentType: "video/mp4", placeholder: "<media:video>" });
  });
});

describe("Feishu outbound media routing", () => {
  it.each([
    [FEISHU_IMAGE_UPLOAD_MAX_BYTES - 1, "image"],
    [FEISHU_IMAGE_UPLOAD_MAX_BYTES, "image"],
    [FEISHU_IMAGE_UPLOAD_MAX_BYTES + 1, "file"],
    [15 * 1024 * 1024, "file"],
    [FEISHU_ATTACHMENT_MAX_BYTES, "file"],
  ] as const)("sends a %d-byte PNG via %s without altering the attachment", async (sizeBytes, expectedType) => {
    const buffer = Buffer.alloc(sizeBytes, 1);
    const uploads: { type: string; bytes: Buffer; fileName?: string; fileType?: string }[] = [];
    const replies: any[] = [];
    const readUpload = async (stream: AsyncIterable<Buffer>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    const client = { im: {
      image: { create: async ({ data }: any) => {
        uploads.push({ type: "image", bytes: await readUpload(data.image) });
        return { code: 0, data: { image_key: "img_uploaded" } };
      } },
      file: { create: async ({ data }: any) => {
        uploads.push({ type: "file", bytes: await readUpload(data.file), fileName: data.file_name, fileType: data.file_type });
        return { code: 0, data: { file_key: "file_uploaded" } };
      } },
      message: { reply: async (input: any) => {
        replies.push(input);
        return { code: 0, data: { message_id: "om_sent" } };
      } },
    } } as any;
    await sendAttachmentFeishu(client, { chatId: "oc_original", replyToMessageId: "om_original_thread",
      buffer, filename: "大图.png", contentType: "image/png", idempotencyKey: "stable_delivery" });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.type).toBe(expectedType);
    expect(uploads[0]!.bytes.equals(buffer)).toBe(true);
    if (expectedType === "file") {
      expect(uploads[0]).toMatchObject({ fileName: "大图.png", fileType: "stream" });
    }
    expect(replies).toEqual([{ path: { message_id: "om_original_thread" }, data: {
      content: JSON.stringify(expectedType === "image" ? { image_key: "img_uploaded" } : { file_key: "file_uploaded" }),
      msg_type: expectedType, reply_in_thread: true, uuid: "stable_delivery",
    } }]);
  });

  it("uploads PNG as an image and HTML/SVG as files", async () => {
    const uploads: any[] = [];
    const sent: any[] = [];
    const client = { im: {
      image: { create: async (input: any) => { uploads.push(input); return { code: 0, data: { image_key: "img_uploaded" } }; } },
      file: { create: async (input: any) => { uploads.push(input); return { code: 0, data: { file_key: "file_uploaded" } }; } },
      message: { create: async (input: any) => { sent.push(input); return { code: 0, data: { message_id: "om_sent" } }; } },
    } } as any;
    for (const [filename, contentType] of [["chart.png", "image/png"], ["report.html", "text/html"], ["drawing.svg", "image/svg+xml"]]) {
      await sendAttachmentFeishu(client, { chatId: "oc_original", buffer: Buffer.from("bytes"), filename: filename!, contentType: contentType!, idempotencyKey: filename! });
    }
    expect(uploads[0].data.image_type).toBe("message");
    expect(uploads[1].data).toMatchObject({ file_name: "report.html", file_type: "stream" });
    expect(uploads[2].data).toMatchObject({ file_name: "drawing.svg", file_type: "stream" });
    expect(sent.map(input => input.data.msg_type)).toEqual(["image", "file", "file"]);
  });

  it("does not send a file when the lease expires during upload", async () => {
    let sent = false;
    const controller = new AbortController();
    const client = { im: {
      file: { create: async () => { controller.abort(); return { code: 0, data: { file_key: "file_uploaded" } }; } },
      message: { create: async () => { sent = true; return { code: 0 }; } },
    } } as any;
    await expect(sendAttachmentFeishu(client, { chatId: "oc_original", filename: "report.html", contentType: "text/html",
      buffer: Buffer.from("bytes"), idempotencyKey: "stable_delivery", signal: controller.signal })).rejects.toThrow();
    expect(sent).toBe(false);
  });

  it("sends direct images and threaded files with stable deduplication IDs", async () => {
    const created: any[] = [];
    const replies: any[] = [];
    const client = { im: { message: {
      create: async (input: unknown) => { created.push(input); return { code: 0, data: { message_id: "om_image" } }; },
      reply: async (input: unknown) => { replies.push(input); return { code: 0, data: { message_id: "om_file" } }; },
    } } } as any;
    await sendImageFeishu(client, "oc_private", "img_key", undefined, "stable_image");
    await sendFileFeishu(client, "oc_group", "file_key", "file", "om_thread", "stable_file");
    expect(created[0]).toMatchObject({ data: { receive_id: "oc_private", msg_type: "image", uuid: "stable_image" } });
    expect(replies[0]).toMatchObject({ path: { message_id: "om_thread" }, data: { reply_in_thread: true, msg_type: "file", uuid: "stable_file" } });
  });
});
