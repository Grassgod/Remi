import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MemoryWebhookRateLimiter,
  readRequestBodyLimited,
  resolveWebhookClientIpAddress,
  setWebhookClientIpAddress,
  webhookClientIpKey,
} from "@multiremi/api/helpers/webhooks.js";

describe("public webhook request boundaries", () => {
  it("keeps socket IP rate limits independent", () => {
    const first = new Request("https://multiremi.test/hook", { method: "POST" });
    const second = new Request("https://multiremi.test/hook", { method: "POST" });
    setWebhookClientIpAddress(first, "10.0.0.1");
    setWebhookClientIpAddress(second, "10.0.0.2");

    const limiter = new MemoryWebhookRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.allow(webhookClientIpKey(first))).toBe(true);
    expect(limiter.allow(webhookClientIpKey(first))).toBe(false);
    expect(limiter.allow(webhookClientIpKey(second))).toBe(true);
  });

  it("trusts forwarding headers only from loopback or configured proxies", () => {
    const request = new Request("https://multiremi.test/hook", {
      headers: {
        "X-Forwarded-For": "192.0.2.99, 203.0.113.8, 127.0.0.1",
        "X-Real-IP": "203.0.113.8",
      },
    });
    expect(resolveWebhookClientIpAddress(request, "127.0.0.1")).toBe("203.0.113.8");
    expect(resolveWebhookClientIpAddress(request, "198.51.100.4")).toBe("198.51.100.4");
    expect(resolveWebhookClientIpAddress(request, "10.1.2.3", "10.1.2.3")).toBe("203.0.113.8");
    expect(resolveWebhookClientIpAddress(request, "10.1.2.4", "10.1.2.3")).toBe("10.1.2.4");
  });

  it("keeps the SCM webhook public before nginx's member-only API location", () => {
    const config = readFileSync("scripts/nginx-remi.conf", "utf8");
    const publicScm = config.indexOf("location ^~ /api/webhooks/scm/");
    const memberApi = config.indexOf("location ^~ /api/ {");

    expect(publicScm).toBeGreaterThan(-1);
    expect(memberApi).toBeGreaterThan(publicScm);
    const publicBlock = config.slice(publicScm, config.indexOf("}", publicScm) + 1);
    expect(publicBlock).toContain("client_max_body_size 1m;");
    expect(publicBlock).toContain("proxy_request_buffering off;");
    expect(publicBlock).toContain("proxy_pass http://remi_web;");
    expect(publicBlock).not.toContain("auth_request");
  });

  it("rejects declared oversized bodies before reading the stream", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const request = new Request("https://multiremi.test/hook", {
      method: "POST",
      headers: { "Content-Length": "1001" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(await readRequestBodyLimited(request, 1_000)).toEqual({
      apiError: "payload too large",
      statusCode: 413,
    });
    expect(pulled).toBe(false);
  });

  it("stops a chunked body once its accumulated size exceeds the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(400));
        controller.close();
      },
    });
    const request = new Request("https://multiremi.test/hook", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    expect(await readRequestBodyLimited(request, 1_000)).toEqual({
      apiError: "payload too large",
      statusCode: 413,
    });
  });

  it("returns an exact byte body within the limit", async () => {
    const request = new Request("https://multiremi.test/hook", {
      method: "POST",
      body: "hello",
    });
    const result = await readRequestBodyLimited(request, 5);
    expect("bytes" in result ? Buffer.from(result.bytes).toString("utf8") : result).toBe("hello");
  });
});
