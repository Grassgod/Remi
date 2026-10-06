import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { MessagesEndpoints } from "./messages";
import { messageFixture, turnFixture } from "./unified.fixture";
import { MessageSchema } from "../schemas/messages";
import { SessionLogEntrySchema } from "../schemas/session-log";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const api = () => new MessagesEndpoints(new HttpClient("https://api.example.test"));
afterEach(() => vi.unstubAllGlobals());
describe("unified messages and turns", () => {
  it("preserves opaque turn cursors and decimal message cursors supplied by the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json({ messages: [messageFixture()], next_cursor: "005" })));
    const first = await api().listMessages("chat_1", { unread_by: "agent_1" });
    await api().listMessages("chat_1", { unread_by: "agent_1", cursor: first.next_cursor! });
    expect(fetch).toHaveBeenLastCalledWith("https://api.example.test/api/sessions/chat_1/messages?unread_by=agent_1&cursor=005", expect.anything());
  });
  it("edits and deletes by message ID, and preserves consumption conflicts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ message: messageFixture({ id: "msg/1", body_md: "edited" }) })).mockResolvedValueOnce(json({ error: "Message has been consumed" }, 409)));
    await expect(api().editMessage("msg/1", "edited")).resolves.toMatchObject({ body_md: "edited" });
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/messages/msg%2F1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ body_md: "edited" }) }));
    await expect(api().deleteMessage("msg/1")).rejects.toMatchObject({ status: 409 });
  });
  it("serializes a decision reply with the option value and original conversation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: messageFixture({ message_kind: "reply", reply_to_id: "decision_1" }), wake_applied: "now", wake_reason: "human_sender" })));
    const body = { body_md: "", message_kind: "reply" as const, reply_to_id: "decision_1", metadata: { selected_options: ["approved"] } };
    await api().sendMessage("sess_2", body);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/sessions/sess_2/messages", expect.objectContaining({ body: JSON.stringify(body) }));
  });
  it("keeps the same turn on retry and loads attempt details only on request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json({ turn: turnFixture({ current_attempt_id: "attempt_3" }) })));
    await expect(api().retryTurn("turn_1", true)).resolves.toMatchObject({ turn: { id: "turn_1", current_attempt_id: "attempt_3" } });
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/turns/turn_1/retry", expect.objectContaining({ method: "POST", body: '{"cold":true}' }));
    await api().getTurn("turn_1", true);
    expect(fetch).toHaveBeenLastCalledWith("https://api.example.test/api/turns/turn_1?attempts=true", expect.anything());
  });
  it("retains future display enums and rejects malformed command data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ message: messageFixture({ wake_applied: "future_wake" }) })).mockResolvedValueOnce(json({ message: { id: "msg_1" } })));
    await expect(api().editMessage("msg_1", "edited")).resolves.toMatchObject({ wake_applied: "future_wake" });
    await expect(api().deleteMessage("msg_1")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("rejects a successful response for a different message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: messageFixture({ id: "other" }) })));
    await expect(api().editMessage("msg_1", "edited")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("adapts canonical attachments and reactions without exposing card credentials", () => {
    const message = MessageSchema.parse({ ...messageFixture(), card_token_hash: "private",
      attachments: [{ id: "att_1", workspaceId: "w", issueId: null, commentId: "msg_1", chatSessionId: "chat_1", chatMessageId: null,
        uploaderType: "member", uploaderId: "member_1", filename: "内容.txt", url: "/file", contentType: "text/plain", sizeBytes: 42, createdAt: "now" }],
      reactions: [{ id: "reaction_1", commentId: "msg_1", actorType: "member", actorId: "member_2", emoji: "👍", createdAt: "now" }],
    });
    expect(message.attachments[0]).toMatchObject({ filename: "内容.txt", content_type: "text/plain", download_url: "/api/attachments/att_1/file" });
    expect(message.reactions[0]).toMatchObject({ actor_id: "member_2", comment_id: "msg_1" });
    expect(message).not.toHaveProperty("card_token_hash");
    expect(SessionLogEntrySchema.parse({ ...messageFixture(), options: '[{"label":"批准","value":"approve"}]' }).options).toEqual([{ label: "批准", value: "approve" }]);
  });
});
