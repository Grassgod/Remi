import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { messageFixture } from "../unified.fixture";
import { ChatQueueEndpoints } from "./chat-queue";
import { QueueErrorBodySchema, QueuedMessageSchema } from "../schemas/chat-queue";
import { isQueueConsumed, isQueueDeliveryUnconfirmed, queueErrorCode, queueErrorItem } from "../../chat/queue";

const item = {
  id: "qmsg_1", session_id: "chat_1", body_md: "Next", attachments: [{ id: "att_1", filename: "a.png", content_type: "image/png", size: 3 }],
  client_id: "client-1", status: "queued", error: null, revision: 1, released_message_id: null, released_via: null,
  released_at: null, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function endpoints(...bodies: Response[]): { api: ChatQueueEndpoints; fetch: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn();
  for (const body of bodies) fetchMock.mockResolvedValueOnce(body);
  vi.stubGlobal("fetch", fetchMock);
  return { api: new ChatQueueEndpoints(new HttpClient("https://api.example.test")), fetch: fetchMock };
}

function sent(fetchMock: ReturnType<typeof vi.fn>, index = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined };
}

afterEach(() => vi.unstubAllGlobals());

describe("queued message schema", () => {
  it("reads the Phase A row and keeps unknown display enums", () => {
    expect(QueuedMessageSchema.parse({ ...item, status: "future" })).toMatchObject({ status: "future", attachments: [{ id: "att_1", size: 3 }] });
  });

  it("rejects a row without its revision or with a malformed attachment", () => {
    const { revision: _revision, ...withoutRevision } = item;
    expect(QueuedMessageSchema.safeParse(withoutRevision).success).toBe(false);
    expect(QueuedMessageSchema.safeParse({ ...item, attachments: [{ id: "att_1" }] }).success).toBe(false);
  });

  it("reads the {error, code} body of a refused command", () => {
    expect(QueueErrorBodySchema.parse({ error: "sent", code: "queued_message_consumed" })).toEqual({ error: "sent", code: "queued_message_consumed" });
  });
});

describe("ChatQueueEndpoints", () => {
  it("reads live rows and the pause of one chat", async () => {
    const { api, fetch } = endpoints(json({ items: [item], paused: { reason: "interrupted", at: "2026-10-15T00:00:01Z" } }));
    await expect(api.getChatQueue("chat_1")).resolves.toEqual({ items: [item], paused: { reason: "interrupted", at: "2026-10-15T00:00:01Z" } });
    expect(sent(fetch)).toMatchObject({ url: "https://api.example.test/api/sessions/chat_1/queue", method: "GET" });
  });

  it("rejects a queue answer without its pause field", async () => {
    const { api } = endpoints(json({ items: [item] }));
    await expect(api.getChatQueue("chat_1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("enqueues with the client id, omitting empty attachments, and reads an immediate release", async () => {
    const message = messageFixture({ dedupe_key: "queue:qmsg_1" });
    const { api, fetch } = endpoints(json({ item: { ...item, status: "released" }, released: { message, turn_id: "turn_1" } }));
    const result = await api.enqueueChatMessage("chat_1", { body_md: "Next", attachment_ids: [], client_id: "client-1" });
    expect(result.released).toMatchObject({ message: { id: "msg_1", dedupe_key: "queue:qmsg_1" }, turn_id: "turn_1" });
    expect(sent(fetch)).toEqual({ url: "https://api.example.test/api/sessions/chat_1/queue", method: "POST", body: { body_md: "Next", client_id: "client-1" } });
  });

  it("does not accept an enqueue answer for another client id", async () => {
    const { api } = endpoints(json({ item: { ...item, client_id: "other" }, released: null }));
    await expect(api.enqueueChatMessage("chat_1", { body_md: "Next", client_id: "client-1" })).rejects.toBeInstanceOf(ApiContractError);
  });

  it("patches with the expected revision and attachment ids", async () => {
    const { api, fetch } = endpoints(json({ item: { ...item, body_md: "Edited", revision: 2 } }));
    await expect(api.updateQueuedChatMessage("chat_1", "qmsg_1", { body_md: "Edited", attachment_ids: [], expected_revision: 1 }))
      .resolves.toMatchObject({ body_md: "Edited", revision: 2 });
    expect(sent(fetch)).toEqual({
      url: "https://api.example.test/api/sessions/chat_1/queue/qmsg_1", method: "PATCH",
      body: { body_md: "Edited", attachment_ids: [], expected_revision: 1 },
    });
  });

  it("deletes, steers and resumes with the routes and bodies of Phase A", async () => {
    const message = messageFixture();
    const { api, fetch } = endpoints(
      json({ item: { ...item, status: "deleted" } }),
      json({ item: { ...item, status: "released", released_via: "steer" }, message, turn_id: "turn_1" }),
      json({ items: [], paused: null, released: [{ message }] }),
    );
    await expect(api.deleteQueuedChatMessage("chat_1", "qmsg_1")).resolves.toMatchObject({ status: "deleted" });
    await expect(api.steerQueuedChatMessage("chat_1", "qmsg_1")).resolves.toMatchObject({ item: { released_via: "steer" }, turn_id: "turn_1" });
    await expect(api.resumeChatQueue("chat_1")).resolves.toMatchObject({ items: [], paused: null, released: [{ message: { id: "msg_1" } }] });
    expect([sent(fetch, 0), sent(fetch, 1), sent(fetch, 2)]).toEqual([
      { url: "https://api.example.test/api/sessions/chat_1/queue/qmsg_1", method: "DELETE", body: undefined },
      { url: "https://api.example.test/api/sessions/chat_1/queue/qmsg_1/steer", method: "POST", body: {} },
      { url: "https://api.example.test/api/sessions/chat_1/queue/resume", method: "POST", body: {} },
    ]);
  });

  it("refuses an answer for a different row", async () => {
    const { api } = endpoints(json({ item: { ...item, id: "qmsg_2" } }));
    await expect(api.deleteQueuedChatMessage("chat_1", "qmsg_1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("surfaces the error code, the failed row and the consumed conflict", async () => {
    const { api } = endpoints(
      json({ error: "The queued message was already sent", code: "queued_message_consumed" }, 409),
      json({ error: "send failed", code: "queued_message_send_failed", item: { ...item, status: "failed", error: "agent archived" } }, 409),
    );
    const consumed = await api.updateQueuedChatMessage("chat_1", "qmsg_1", { body_md: "x" }).catch((error: unknown) => error);
    expect(consumed).toBeInstanceOf(ApiError);
    expect(queueErrorCode(consumed)).toBe("queued_message_consumed");
    expect(isQueueConsumed(consumed)).toBe(true);
    expect(isQueueDeliveryUnconfirmed(consumed)).toBe(false);
    const failed = await api.steerQueuedChatMessage("chat_1", "qmsg_1").catch((error: unknown) => error);
    expect(queueErrorItem(failed)).toMatchObject({ id: "qmsg_1", status: "failed", error: "agent archived" });
    expect(isQueueConsumed(failed)).toBe(false);
  });

  it("treats a failure without an HTTP status as unconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const api = new ChatQueueEndpoints(new HttpClient("https://api.example.test"));
    const error = await api.steerQueuedChatMessage("chat_1", "qmsg_1").catch((caught: unknown) => caught);
    expect(isQueueDeliveryUnconfirmed(error)).toBe(true);
    expect(queueErrorCode(error)).toBeNull();
  });
});
