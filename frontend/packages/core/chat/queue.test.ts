import { describe, expect, it } from "vitest";
import type { QueuedChatMessage } from "../api/schemas/chat-queue";
import { ApiError } from "../api/http";
import { applyQueueItem, isQueueDeliveryUnconfirmed, queueErrorItem, queuedAttachmentBindings, queuePreviewText, truncatePreview } from "./queue";

const row = (fields: Partial<QueuedChatMessage> = {}): QueuedChatMessage => ({
  id: "qmsg_1", session_id: "chat-1", body_md: "Next", attachments: [], client_id: "client-1", status: "queued",
  error: null, revision: 1, released_message_id: null, released_via: null, released_at: null,
  created_at: "t", updated_at: "t", ...fields,
});

describe("queue previews", () => {
  it("collapses whitespace into one line", () => {
    expect(queuePreviewText("  first line\n\n  second\tline  ")).toBe("first line second line");
  });

  it("cuts at 80 characters, the ellipsis included, without splitting a character", () => {
    expect(truncatePreview("a".repeat(80))).toBe("a".repeat(80));
    const cut = truncatePreview("a".repeat(81));
    expect(cut).toBe(`${"a".repeat(79)}…`);
    expect(Array.from(cut)).toHaveLength(80);
    expect(truncatePreview("😀".repeat(81)).endsWith("😀…")).toBe(true);
  });
});

describe("queued attachment bindings", () => {
  it("maps each attachment URL found in the body to its id", () => {
    const body = "See ![](/api/attachments/att_1/content) and [report.pdf](https://remi.test/api/attachments/att_2/content?x=1)";
    expect(queuedAttachmentBindings(body, [
      { id: "att_1", filename: "a.png", content_type: "image/png", size: 1 },
      { id: "att_2", filename: "report.pdf", content_type: "application/pdf", size: 2 },
      { id: "att_3", filename: "unreferenced.txt", content_type: "text/plain", size: 3 },
    ])).toEqual({
      "/api/attachments/att_1/content": "att_1",
      "https://remi.test/api/attachments/att_2/content?x=1": "att_2",
    });
  });
});

describe("applying a command's row to the cached queue", () => {
  it("replaces a live row, appends a new one and drops released or deleted rows", () => {
    const queue = { items: [row()], paused: null };
    expect(applyQueueItem(queue, row({ body_md: "Edited", revision: 2 }))?.items).toEqual([row({ body_md: "Edited", revision: 2 })]);
    expect(applyQueueItem(queue, row({ id: "qmsg_2" }))?.items.map((item) => item.id)).toEqual(["qmsg_1", "qmsg_2"]);
    expect(applyQueueItem(queue, row({ status: "released" }))?.items).toEqual([]);
    expect(applyQueueItem(queue, row({ status: "deleted" }))?.items).toEqual([]);
    expect(applyQueueItem(undefined, row())).toBeUndefined();
  });
});

describe("queue error classification", () => {
  it("treats gateway and timeout answers as unconfirmed and other statuses as refusals", () => {
    for (const status of [408, 502, 503, 504]) expect(isQueueDeliveryUnconfirmed(new ApiError("x", status, "x"))).toBe(true);
    for (const status of [400, 403, 404, 409, 500]) expect(isQueueDeliveryUnconfirmed(new ApiError("x", status, "x"))).toBe(false);
    expect(isQueueDeliveryUnconfirmed(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("uses only a failed row that parses", () => {
    const body = (item: unknown) => new ApiError("send failed", 409, "Conflict", { error: "send failed", code: "queued_message_send_failed", item });
    expect(queueErrorItem(body(row({ status: "failed" })))).toMatchObject({ id: "qmsg_1", status: "failed" });
    expect(queueErrorItem(body({ id: "qmsg_1" }))).toBeNull();
    expect(queueErrorItem(new ApiError("sent", 409, "Conflict", { error: "sent", code: "queued_message_consumed", item: row() }))).toBeNull();
  });
});
