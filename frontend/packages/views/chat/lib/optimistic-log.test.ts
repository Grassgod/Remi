import { describe, expect, it } from "vitest";
import type { SessionLogEntry } from "@multiremi/core/replica";
import type { Attachment } from "@multiremi/core/types";
import { mergeOptimisticChatRows, type OptimisticChatRow } from "./optimistic-log";

const sessionId = "chat-1";

function entry(seq: number, clientId?: string): SessionLogEntry {
  return {
    session_id: sessionId, seq, id: `server-${seq}`, revision: 1,
    kind: "message", body_md: "same text", body_html: null, render_version: null,
    dedupe_key: clientId ?? null, metadata: {},
  } as SessionLogEntry;
}

function local(clientId: string, localSeq: number): OptimisticChatRow {
  return { clientId, sessionId, content: "same text", createdAt: "2026-09-29T00:00:00Z",
    localSeq, status: "sending" };
}

function attachment(id: string): Attachment {
  return { id, filename: "draft.txt", workspace_id: "w", issue_id: null, comment_id: null,
    chat_session_id: sessionId, chat_message_id: null, uploader_type: "member", uploader_id: "u",
    url: `/api/attachments/${id}/content`, download_url: `/api/attachments/${id}/download`,
    content_type: "text/plain", size_bytes: 5, created_at: "2026-09-29T00:00:00Z" };
}

describe("optimistic chat log merge", () => {
  it("matches by canonical dedupe_key, keeps the DOM identity and position as each send is confirmed", () => {
    const first = local("send-1", 5.000001);
    const second = local("send-2", 5.000002);
    const initial = mergeOptimisticChatRows([entry(5)], [first, second]);
    const afterFirst = mergeOptimisticChatRows([entry(5), entry(6, "send-1")], [first, second]);
    const afterBoth = mergeOptimisticChatRows([entry(5), entry(6, "send-1"), entry(7, "send-2")], [first, second]);
    expect([initial, afterFirst, afterBoth].map(rows => rows.map(row => row.id)))
      .toEqual(Array.from({ length: 3 }, () => ["server-5", "optimistic-send-1", "optimistic-send-2"]));
  });

  it("does not collapse different sends with the same text or duplicate a replayed server entry", () => {
    const rows = mergeOptimisticChatRows([
      entry(6, "send-1"), entry(6, "send-1"), entry(7, "send-2"),
    ], [local("send-1", 5.000001), local("send-2", 5.000002)]);
    expect(rows.map(row => row.id)).toEqual(["optimistic-send-1", "optimistic-send-2"]);
    expect(rows.map(row => row.seq)).toEqual([5.000001, 5.000002]);
  });

  it("shows local upload metadata until the hydrated server row replaces it", () => {
    const sending = { ...local("send-1", 5.000001), attachments: [attachment("local-file")] };
    const initial = mergeOptimisticChatRows([], [sending]);
    expect((initial[0] as SessionLogEntry & { metadata: { attachments: unknown[] } }).metadata.attachments)
      .toMatchObject([{ id: "local-file" }]);
    const confirmed = mergeOptimisticChatRows([{ ...entry(6, "send-1"),
      metadata: { attachments: [{ id: "server-file", filename: "draft.txt" }] },
    } as SessionLogEntry], [sending]);
    expect(confirmed[0]?.id).toBe(initial[0]?.id);
    expect((confirmed[0] as SessionLogEntry & { metadata: { attachments: unknown[] } }).metadata.attachments)
      .toMatchObject([{ id: "server-file" }]);
  });
});
