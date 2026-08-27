import { afterEach, describe, expect, it } from "bun:test";
import { MenuSyncer } from "@connectors/feishu/sdk.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Feishu bot menu publisher", () => {
  it("validates a dry run without requesting a token or publishing", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error("dry run must not access the network");
    }) as unknown as typeof globalThis.fetch;

    const result = await new MenuSyncer({ appId: "test-app", appSecret: "test-secret" }).syncAll({
      default: [{ name: "Default", behaviors: [{ type: "send_message" }] }],
      users: [{
        userId: "union-target",
        userIdType: "union_id",
        items: [{ name: "Personal", behaviors: [{ type: "event_key", eventKey: "personal" }] }],
      }],
    }, { dryRun: true });

    expect(result).toEqual({ dryRun: true, defaultPublished: true, userMenuCount: 1 });
    expect(fetchCount).toBe(0);
  });

  it("keeps the resolved identifier type when publishing personalized menus", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("tenant_access_token")) {
        return Response.json({ code: 0, tenant_access_token: "test-token", expire: 7200 });
      }
      return Response.json({ code: 0 });
    }) as typeof globalThis.fetch;

    const result = await new MenuSyncer({ appId: "test-app", appSecret: "test-secret" }).syncAll({
      users: [{
        userId: "union-target",
        userIdType: "union_id",
        items: [{ name: "Personal", behaviors: [{ type: "send_message" }] }],
      }],
    });

    expect(result).toEqual({ dryRun: false, defaultPublished: false, userMenuCount: 1 });
    const publish = requests.find((request) => request.url.includes("/bot/v3/bot_menu"));
    expect(publish?.url).toContain("user_id_type=union_id");
    expect(JSON.parse(String(publish?.init?.body))).toEqual({
      user_id: "union-target",
      bot_menu: { bot_menu_items: [{ name: "Personal", i18n_name: { en_us: "Personal" }, behaviors: [{ type: "send_message" }] }] },
    });
  });
});
