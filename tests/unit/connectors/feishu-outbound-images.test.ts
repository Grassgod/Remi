import { describe, expect, it } from "bun:test";
import { classifyMarkdownImageSource, rewriteMarkdownImages } from "@shared/feishu-markdown-images.js";
import {
  createFeishuImageResolver,
  loadFeishuImage,
  responseToFeishuImage,
  validateFeishuImage,
} from "@connectors/feishu/outbound-images.js";

describe("Feishu outbound image loading", () => {
  it("rejects non-image and oversized content before upload", async () => {
    expect(() => validateFeishuImage({
      buffer: Buffer.from("not an image"),
      contentType: "text/plain",
    })).toThrow("non-image");
    expect(() => validateFeishuImage({
      buffer: Buffer.alloc(9),
      contentType: "image/png",
    }, 8)).toThrow("10MB limit");

    await expect(responseToFeishuImage(new Response(Buffer.alloc(9), {
      headers: { "content-type": "image/png", "content-length": "9" },
    }), "large.png", 8)).rejects.toThrow("10MB limit");
  });

  it("bounds streamed responses even when content-length is absent", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    }), { headers: { "content-type": "image/png" } });

    await expect(responseToFeishuImage(response, "stream.png", 8)).rejects.toThrow("10MB limit");
  });

  it("does not upload remote non-image responses", async () => {
    const source = classifyMarkdownImageSource("https://cdn.example/not-image.txt");
    await expect(loadFeishuImage(source, {
      fetchFn: async () => new Response("plain", { headers: { "content-type": "text/plain" } }),
    })).rejects.toThrow("non-image");
  });

  it("keeps the timeout active while a remote response body is streaming", async () => {
    const source = classifyMarkdownImageSource("https://cdn.example/stalled.png");
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("download aborted")));
        },
      }),
      { headers: { "content-type": "image/png" } },
    );

    await expect(loadFeishuImage(source, { fetchFn, timeoutMs: 5 })).rejects.toThrow();
  });

  it("uploads duplicate sources once and reuses the image key across rewrites", async () => {
    let loads = 0;
    let uploads = 0;
    const resolver = createFeishuImageResolver({
      loadAttachment: async () => {
        loads += 1;
        return { buffer: Buffer.from("png"), contentType: "image/png", fileName: "capture.png" };
      },
      uploadImage: async () => {
        uploads += 1;
        return "img_cached";
      },
    });
    const input = "![capture](/api/attachments/att_cache/content)";

    expect(await rewriteMarkdownImages(input, resolver)).toBe("![capture](feishu-image:img_cached)");
    expect(await rewriteMarkdownImages(input, resolver)).toBe("![capture](feishu-image:img_cached)");
    expect(loads).toBe(1);
    expect(uploads).toBe(1);
  });

  it("degrades loader failures instead of retaining broken image syntax", async () => {
    const resolver = createFeishuImageResolver({
      loadAttachment: async () => ({ buffer: Buffer.from("text"), contentType: "text/plain" }),
      uploadImage: async () => "img_unused",
    });

    expect(await rewriteMarkdownImages(
      "![bad](/api/attachments/att_bad/content)",
      resolver,
      { publicUrl: "https://remi.example" },
    )).toBe("[图片: bad](https://remi.example/api/attachments/att_bad/content)");
  });
});
