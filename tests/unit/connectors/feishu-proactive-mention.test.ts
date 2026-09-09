import { describe, expect, it } from "bun:test";
import { resolveProactiveMention } from "@connectors/feishu/proactive-mention.js";
import { parseOutboundMention } from "@shared/feishu-mention.js";

describe("proactive Feishu mention resolution", () => {
  it("requests the owner in the sending bot's open_id namespace", async () => {
    const calls: unknown[] = [];
    const client = { request: async (input: unknown) => { calls.push(input); return { code: 0, data: {
      owner_id: "ou_owner", owner_id_type: "open_id",
    } }; } };
    const result = await resolveProactiveMention(client as any, "oc_topic", { mode: "group_owner" }, { warn: () => {} });
    expect(result).toBe("ou_owner");
    expect(calls).toEqual([{ method: "GET", url: "/open-apis/im/v1/chats/oc_topic",
      params: { user_id_type: "open_id" }, timeout: 5000 }]);
  });

  it("uses a new owner for a new notification but never re-resolves a checkpoint", async () => {
    let owner = "ou_old";
    let calls = 0;
    const client = { request: async () => { calls++; return { code: 0, data: { owner_id: owner, owner_id_type: "open_id" } }; } };
    const options = { warn: () => {} };
    expect(await resolveProactiveMention(client as any, "oc_topic", { mode: "group_owner" }, options)).toBe("ou_old");
    owner = "ou_new";
    expect(await resolveProactiveMention(client as any, "oc_topic", { mode: "group_owner", resolvedOpenId: "ou_old" }, options)).toBe("ou_old");
    expect(await resolveProactiveMention(client as any, "oc_topic", { mode: "group_owner" }, options)).toBe("ou_new");
    expect(calls).toBe(2);
  });

  it("does not query for explicit recipients, none, or a saved no-mention outcome", async () => {
    const client = { request: async () => { throw new Error("must not query"); } };
    const options = { warn: () => { throw new Error("unexpected warning"); } };
    expect(await resolveProactiveMention(client as any, "oc_topic", { mode: "person", openId: "ou_reviewer" }, options)).toBe("ou_reviewer");
    expect(await resolveProactiveMention(client as any, "oc_topic", { mode: "none" }, options)).toBeNull();
    expect(await resolveProactiveMention(client as any, "oc_topic", { mode: "group_owner", resolvedOpenId: null }, options)).toBeNull();
  });

  it("fails closed on unknown wire policies and malformed mention IDs", () => {
    for (const raw of [null, [], {}, { mode: "all" }, { mode: "person", openId: "all" },
      { mode: "group_owner", resolvedOpenId: "ou_x><at id=all" }, { mode: "person", openId: 1 }]) {
      expect(parseOutboundMention(raw)).toBeUndefined();
    }
    expect(parseOutboundMention({ mode: "group_owner", resolvedOpenId: null })).toEqual({ mode: "group_owner", resolvedOpenId: null });
  });

  for (const response of [
    { code: 99991672 }, { code: 0, data: {} },
    { code: 0, data: { owner_id: "ou_owner", owner_id_type: "union_id" } },
    { code: 0, data: { owner_id: "all", owner_id_type: "open_id" } },
  ]) it(`omits invalid/unavailable owners without preventing delivery: ${JSON.stringify(response)}`, async () => {
    const warnings: string[] = [];
    expect(await resolveProactiveMention({ request: async () => response } as any, "oc_topic", { mode: "group_owner" },
      { warn: message => warnings.push(message) })).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("bounds lookup latency and never logs SDK credentials", async () => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    expect(await resolveProactiveMention({ request: () => new Promise(() => {}) } as any, "oc_topic", { mode: "group_owner" },
      { warn, timeoutMs: 5 })).toBeNull();
    expect(await resolveProactiveMention({ request: async () => { throw new Error("Authorization: SECRET"); } } as any,
      "oc_topic", { mode: "group_owner" }, { warn })).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).not.toContain("SECRET");
  });

  it("does not turn an aborted delivery into a no-mention send", async () => {
    const abort = new AbortController();
    const client = { request: async () => {
      abort.abort(new Error("lease lost"));
      return { code: 0, data: { owner_id: "ou_owner", owner_id_type: "open_id" } };
    } };
    await expect(resolveProactiveMention(client as any, "oc_topic", { mode: "group_owner" }, {
      signal: abort.signal, warn: () => { throw new Error("must not downgrade cancellation"); },
    })).rejects.toThrow("lease lost");
  });
});
