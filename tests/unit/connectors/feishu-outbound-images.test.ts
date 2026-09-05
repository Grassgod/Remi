import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMarkdownImageSource, rewriteMarkdownImages } from "@shared/feishu-markdown-images.js";
import {
  assertPublicFeishuImageHost,
  createFeishuImageResolver,
  isNonGlobalFeishuImageIp,
  loadFeishuImage,
  responseToFeishuImage,
  validateFeishuImage,
} from "@connectors/feishu/outbound-images.js";

describe("Feishu outbound image loading", () => {
  it.each([
    "0.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.0.1",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "64:ff9b::1",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001:2::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:192.0.2.1",
    "::ffff:c000:201",
  ])("classifies non-global address %s", (address) => {
    expect(isNonGlobalFeishuImageIp(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "192.0.0.9",
    "192.31.196.1",
    "2001:1::1",
    "2001:3::1",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("keeps globally reachable address %s eligible", (address) => {
    expect(isNonGlobalFeishuImageIp(address)).toBe(false);
  });

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
      assertRemoteHost: async () => undefined,
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

    await expect(loadFeishuImage(source, {
      fetchFn,
      timeoutMs: 5,
      assertRemoteHost: async () => undefined,
    })).rejects.toThrow();
  });

  it("rejects private hosts before fetching and checks every redirect target", async () => {
    await expect(assertPublicFeishuImageHost("127.0.0.1")).rejects.toThrow("non-global address");

    const checked: string[] = [];
    let fetches = 0;
    const source = classifyMarkdownImageSource("https://cdn.example/start.png");
    await expect(loadFeishuImage(source, {
      assertRemoteHost: async (hostname) => {
        checked.push(hostname);
        if (hostname === "127.0.0.1") throw new Error("private redirect blocked");
      },
      fetchFn: async () => {
        fetches += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/internal.png" },
        });
      },
    })).rejects.toThrow("private redirect blocked");
    expect(checked).toEqual(["cdn.example", "127.0.0.1"]);
    expect(fetches).toBe(1);
  });

  it("rejects a DNS answer set when any address is non-global before connecting", async () => {
    const source = classifyMarkdownImageSource("https://mixed.example/image.png");

    await expect(loadFeishuImage(source, {
      lookupFn: (_hostname, _options, callback) => callback(null, [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    })).rejects.toThrow("non-global address");
  });

  it("rejects non-global IP literals before Bun can bypass the lookup hook", async () => {
    let localConnections = 0;
    const local = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        localConnections += 1;
        return new Response(Buffer.from("png"), { headers: { "content-type": "image/png" } });
      },
    });
    const source = classifyMarkdownImageSource(`http://127.0.0.1:${local.port}/image.png`);
    try {
      await expect(loadFeishuImage(source)).rejects.toThrow("non-global address");
      expect(localConnections).toBe(0);
    } finally {
      local.stop(true);
    }
  });

  it("uses one pinned DNS answer and never reconnects with a rebound private answer", async () => {
    let localConnections = 0;
    let lookupCalls = 0;
    const local = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        localConnections += 1;
        return new Response(Buffer.from("png"), { headers: { "content-type": "image/png" } });
      },
    });
    const source = classifyMarkdownImageSource(`http://rebind.example:${local.port}/image.png`);
    try {
      await expect(loadFeishuImage(source, {
        timeoutMs: 20,
        lookupFn: (_hostname, _options, callback) => {
          lookupCalls += 1;
          callback(null, [{
            address: lookupCalls === 1 ? "8.8.8.8" : "127.0.0.1",
            family: 4,
          }]);
        },
      })).rejects.toThrow();
      expect(lookupCalls).toBe(1);
      expect(localConnections).toBe(0);
    } finally {
      local.stop(true);
    }
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

  it("rejects Issue local paths while preserving Agent local image uploads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "feishu-image-origin-"));
    const imagePath = join(directory, "chart.png");
    await writeFile(imagePath, Buffer.from("png"));
    const input = `![chart](${imagePath})`;
    const uploaded: Buffer[] = [];
    try {
      const issueResolver = createFeishuImageResolver({
        allow: { local: false },
        uploadImage: async (image) => {
          uploaded.push(image.buffer);
          return "img_issue_unexpected";
        },
      });
      expect(await rewriteMarkdownImages(input, issueResolver)).toBe("[图片: chart]");
      expect(uploaded).toHaveLength(0);

      const agentResolver = createFeishuImageResolver({
        allow: { local: true },
        uploadImage: async (image) => {
          uploaded.push(image.buffer);
          return "img_agent_chart";
        },
      });
      expect(await rewriteMarkdownImages(input, agentResolver))
        .toBe("![chart](feishu-image:img_agent_chart)");
      expect(uploaded).toEqual([Buffer.from("png")]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
