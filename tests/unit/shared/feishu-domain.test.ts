import { describe, expect, it } from "bun:test";
import { resolveApiBase } from "@shared/feishu-domain.js";

describe("resolveApiBase", () => {
  it("defaults to the Feishu cloud", () => {
    expect(resolveApiBase()).toBe("https://open.feishu.cn/open-apis");
    expect(resolveApiBase("feishu")).toBe("https://open.feishu.cn/open-apis");
    expect(resolveApiBase("")).toBe("https://open.feishu.cn/open-apis");
  });

  it("routes lark to the international cloud", () => {
    expect(resolveApiBase("lark")).toBe("https://open.larksuite.com/open-apis");
  });

  it("treats an http(s) domain as a self-hosted deployment and strips trailing slashes", () => {
    expect(resolveApiBase("https://feishu.example.com")).toBe("https://feishu.example.com/open-apis");
    expect(resolveApiBase("https://feishu.example.com///")).toBe("https://feishu.example.com/open-apis");
  });

  it("falls back to the Feishu cloud for an unrecognised, non-URL domain", () => {
    expect(resolveApiBase("bytedance")).toBe("https://open.feishu.cn/open-apis");
  });
});
