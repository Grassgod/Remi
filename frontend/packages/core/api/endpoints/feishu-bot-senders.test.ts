import { describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { FeishuBotEndpoints } from "./feishu-bot";

const sender = {
  id: "sender-1",
  app_id: "cli_1",
  display_name: "Sender",
  open_id: "ou_1",
  union_id: null,
  allowed: false,
  first_seen_at: "2026-09-13T00:00:00.000Z",
  last_seen_at: "2026-09-13T01:00:00.000Z",
};

function endpoints(response: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  const http = { fetch: fetchMock } as unknown as HttpClient;
  return { api: new FeishuBotEndpoints(http), fetchMock };
}

describe("Feishu bot sender allowlist endpoints", () => {
  it("reads discovered senders for the requested workspace", async () => {
    const { api, fetchMock } = endpoints({ senders: [sender] });
    await expect(api.listFeishuBotSenders("ws_1")).resolves.toEqual({ senders: [sender] });
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws_1/feishu-bot/senders");
  });

  it("accepts an explicitly empty list and nullable provider identifiers", async () => {
    const { api, fetchMock } = endpoints({ senders: [] });
    await expect(api.listFeishuBotSenders("ws_1")).resolves.toEqual({ senders: [] });
    fetchMock.mockResolvedValue({ senders: [{ ...sender, open_id: null, union_id: "on_1" }] });
    await expect(api.listFeishuBotSenders("ws_1")).resolves.toMatchObject({
      senders: [{ open_id: null, union_id: "on_1" }],
    });
  });

  it.each(["Test Chen", null])("preserves optional English names: %j", async (name_en) => {
    const resolved = { ...sender, name_en };
    const { api } = endpoints({ senders: [resolved] });
    await expect(api.listFeishuBotSenders("ws_1")).resolves.toEqual({ senders: [resolved] });
  });

  it.each([null, {}, { senders: null }, { senders: "none" }])(
    "rejects a malformed list instead of showing an empty allowlist: %j",
    async (response) => {
      const { api } = endpoints(response);
      await expect(api.listFeishuBotSenders("ws_1")).rejects.toBeInstanceOf(ApiContractError);
    },
  );

  it.each(Object.keys(sender))("requires sender field %s in list and update responses", async (field) => {
    const incomplete: Record<string, unknown> = { ...sender };
    delete incomplete[field];
    const { api, fetchMock } = endpoints({ senders: [incomplete] });
    await expect(api.listFeishuBotSenders("ws_1")).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue(incomplete);
    await expect(api.updateFeishuBotSender("ws_1", "sender-1", { allowed: true }))
      .rejects.toBeInstanceOf(ApiContractError);
  });

  it.each([
    { allowed: "true" },
    { allowed: 1 },
    { display_name: 42 },
    { name_en: 42 },
    { open_id: false },
    { union_id: [] },
    { first_seen_at: null },
  ])("rejects invalid sender field types in list and update responses: %j", async (invalid) => {
    const malformed = { ...sender, ...invalid };
    const { api, fetchMock } = endpoints({ senders: [malformed] });
    await expect(api.listFeishuBotSenders("ws_1")).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue(malformed);
    await expect(api.updateFeishuBotSender("ws_1", "sender-1", { allowed: true }))
      .rejects.toBeInstanceOf(ApiContractError);
  });

  it.each([true, false])("sends the explicit allowed=%s decision and parses the result", async (allowed) => {
    const updated = { ...sender, allowed };
    const { api, fetchMock } = endpoints(updated);
    await expect(api.updateFeishuBotSender("ws_1", "sender-1", { allowed })).resolves.toEqual(updated);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/ws_1/feishu-bot/senders/sender-1", {
      method: "PUT",
      body: JSON.stringify({ allowed }),
    });
  });
});
