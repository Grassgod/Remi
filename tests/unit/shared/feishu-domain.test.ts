import { describe, expect, it } from "bun:test";
import { resolveApiBase, resolveApiOrigin } from "@shared/feishu-domain.js";

describe("resolveApiOrigin", () => {
  it("routes the supported deployment domains", () => {
    expect(resolveApiOrigin()).toBe("https://open.feishu.cn");
    expect(resolveApiOrigin("feishu")).toBe("https://open.feishu.cn");
    expect(resolveApiOrigin("lark")).toBe("https://open.larksuite.com");
    expect(resolveApiOrigin("bytedance")).toBe("https://fsopen.bytedance.net");
  });

  it("preserves a custom http(s) origin and strips trailing slashes", () => {
    expect(resolveApiOrigin("https://feishu.example.com///")).toBe("https://feishu.example.com");
  });
});

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

  it("routes bytedance to the internal Feishu cloud", () => {
    expect(resolveApiBase("bytedance")).toBe("https://fsopen.bytedance.net/open-apis");
  });
});
