import { describe, expect, it } from "bun:test";
import {
  classifyMarkdownImageSource,
  degradeMarkdownImages,
  findMarkdownImages,
  rewriteMarkdownImages,
} from "@shared/feishu-markdown-images.js";

describe("Feishu markdown images", () => {
  it("classifies Feishu keys, Multiremi attachments, files, remote URLs, and unsupported sources", () => {
    expect(classifyMarkdownImageSource("img_v3_abc-123")).toMatchObject({
      kind: "feishu",
      imageKey: "img_v3_abc-123",
    });
    expect(classifyMarkdownImageSource("feishu-image:img_v3_marker")).toMatchObject({
      kind: "feishu",
      imageKey: "img_v3_marker",
    });
    expect(classifyMarkdownImageSource("/api/attachments/att_local_1/content", {
      publicUrl: "https://remi.example/base/",
    })).toEqual({
      kind: "attachment",
      src: "/api/attachments/att_local_1/content",
      attachmentId: "att_local_1",
      fallbackUrl: "https://remi.example/api/attachments/att_local_1/content",
      name: "att_local_1",
    });
    expect(classifyMarkdownImageSource(
      "https://remi.example/api/attachments/att_remote_2/content?download=1",
    )).toMatchObject({ kind: "attachment", attachmentId: "att_remote_2" });
    expect(classifyMarkdownImageSource("/tmp/screenshot.png")).toMatchObject({
      kind: "local",
      filePath: "/tmp/screenshot.png",
      name: "screenshot.png",
    });
    expect(classifyMarkdownImageSource("file:///tmp/screenshot%202.png")).toMatchObject({
      kind: "local",
      filePath: "/tmp/screenshot 2.png",
    });
    expect(classifyMarkdownImageSource("https://cdn.example/image.png")).toMatchObject({
      kind: "http",
      url: "https://cdn.example/image.png",
    });
    expect(classifyMarkdownImageSource("images/screenshot.png")).toMatchObject({ kind: "unsupported" });
  });

  it("rewrites resolved images, preserves existing markers, and caches duplicate sources", async () => {
    const calls: string[] = [];
    const markdown = [
      "![first](https://cdn.example/image.png)",
      "![again](https://cdn.example/image.png)",
      "![existing](feishu-image:img_existing)",
      "![raw](img_raw)",
    ].join("\n");

    const rewritten = await rewriteMarkdownImages(markdown, async (source) => {
      calls.push(source.src);
      return "img_uploaded";
    });

    expect(rewritten).toBe([
      "![first](feishu-image:img_uploaded)",
      "![again](feishu-image:img_uploaded)",
      "![existing](feishu-image:img_existing)",
      "![raw](img_raw)",
    ].join("\n"));
    expect(calls).toEqual(["https://cdn.example/image.png"]);
  });

  it("degrades failed and unparseable images without leaving broken image markdown", async () => {
    const markdown = [
      "![diagram](https://cdn.example/diagram.png)",
      "![local shot](/tmp/shot.png)",
      "![](relative/image.png)",
    ].join("\n");

    const rewritten = await rewriteMarkdownImages(markdown, async () => null);

    expect(rewritten).toBe([
      "[图片: diagram](https://cdn.example/diagram.png)",
      "[图片: local shot]",
      "[图片: image.png]",
    ].join("\n"));
    expect(findMarkdownImages(rewritten)).toEqual([]);
  });

  it("degrades relative attachments to public links when a public URL is available", () => {
    expect(degradeMarkdownImages(
      "Before ![capture](/api/attachments/att_123/content) after",
      { publicUrl: "https://remi.example" },
    )).toBe(
      "Before [图片: capture](https://remi.example/api/attachments/att_123/content) after",
    );
  });

  it("ignores escaped image syntax", async () => {
    const input = String.raw`\![literal](https://cdn.example/image.png)`;
    expect(await rewriteMarkdownImages(input, async () => "img_unused")).toBe(input);
  });
});
