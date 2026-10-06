import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentsEndpoints } from "./comments";
import { HttpClient } from "../http";
import { messageFixture } from "./unified.fixture";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const api = () => new CommentsEndpoints(new HttpClient("https://api.example.test"));
afterEach(() => vi.unstubAllGlobals());
describe("Issue message actions", () => {
  it("retains the server's final conversation for a routed role message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: messageFixture({ session_id: "destination" }), wake_applied: "inbox_only", wake_reason: "source_side_session" })));
    expect(await api().createComment("issue_1", "request", undefined, undefined, undefined, "source")).toMatchObject({ id: "msg_1", issue_session_id: "destination" });
  });
  it("preserves reactions from two members using the same emoji", async () => {
    const reactions = ["member_1", "member_2"].map((actorId, index) => ({ id: `r${index}`, commentId: "msg_1", actorType: "member", actorId, emoji: "👍", createdAt: "now" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ reactions })));
    expect((await api().addReaction("msg_1", "👍")).map(r => r.actor_id)).toEqual(["member_1", "member_2"]);
  });
  it("refuses attachment changes instead of reporting a body-only edit as successful", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: messageFixture() })));
    await expect(api().updateComment("msg_1", "edited", ["new_attachment"])).rejects.toThrow("attachments cannot be changed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/messages/msg_1", expect.not.objectContaining({ method: "PATCH" }));
  });
  it("preserves original-sender authorization failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "not sender" }, 403)));
    await expect(api().deleteComment("msg_1")).rejects.toMatchObject({ status: 403 });
  });
});
