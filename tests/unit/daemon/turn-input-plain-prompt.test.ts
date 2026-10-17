import { describe, expect, it } from "bun:test";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import { buildSteerInjectionPrompt } from "@multiremi/worker/steer.js";
import { replayInputHint, unreadRangeHint } from "@multiremi/contracts/session-input.js";
import type { UnifiedMessage } from "@multiremi/contracts/unified-model.js";

const AGENT = "agt_self";

/** The unread_range record as the server builds it; only a complete record carries `complete: true`. */
function range(session: string, from: number, to: number, unread: number, complete = false, coldStart = from === 0): string {
  return JSON.stringify({ type: "unread_range", session_id: session, from_seq: from, to_seq: to, unread_count: unread,
    instruction: unreadRangeHint(session, from, to, unread, coldStart), ...(complete ? { complete: true } : {}) });
}

function message(seq: number, body: string, overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: `msg_${seq}`, session_id: "chat_1", seq, kind: "message", visibility: "shown", task_id: null,
    sender_type: "member", sender_id: "mem_alice", to_type: "agent", to_ref: AGENT, to_agent_id: AGENT, to_member_id: null,
    message_kind: "request", wake_requested: "now", wake_applied: "now", wake_reason: "human_sender",
    reply_to_id: null, dedupe_key: null, options: null, card_token_hash: null, card_token_recipient: null, card_token_consumed_at: null,
    body_md: body, body_html: null, render_version: null, resolved_at: null, resolved_by_type: null, resolved_by_id: null,
    metadata: { execution_scope: "" }, revision: 1, created_at: "2026-10-17T00:00:00.000Z",
    updated_at: "2026-10-17T00:00:00.000Z", deleted_at: null, ...overrides,
  } as UnifiedMessage;
}

/** Offer input as the bridge projects it: the range record leads the first message. */
function offered(rangeLine: string, messages: UnifiedMessage[]): UnifiedMessage[] {
  return messages.map((entry, index) => index ? entry : { ...entry, body_md: `${rangeLine}\n${entry.body_md}` });
}

function triggering(entry: UnifiedMessage, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "triggering_message", seq: entry.seq, id: entry.id, author_type: entry.sender_type,
    author_id: entry.sender_id, task_id: null, body: entry.body_md, ...extra });
}

function chatTurn(input: UnifiedMessage[], projection: string[], overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "tsk_turn", workspaceId: "local", prompt: "", issueId: null, issue: null, chatSessionId: "chat_1",
    autopilotRunId: null, createdAt: "2026-10-17T00:00:00.000Z", completedAt: null, project: null,
    projectResources: [], repos: [], triggerCommentId: null, triggerSummary: null,
    agent: { id: AGENT, name: "Self", provider: "claude", model: null, instructions: "", skills: [] },
    turn_id: "tsk_turn", attempt_id: "tsk_turn", input_from_seq: 0, input_to_seq: 2, input_messages: input,
    sessionProjection: { session_id: "chat_1", mode: "bootstrap", from_seq: 0, to_seq: 2, jsonl: projection.join("\n") },
    ...overrides,
  } as AgentTask;
}

function issueTurn(input: UnifiedMessage[], projection: string[], overrides: Partial<AgentTask> = {}): AgentTask {
  return chatTurn(input, projection, {
    chatSessionId: null, issueId: "iss_1", issueSessionId: "ises_1",
    issue: { id: "iss_1", key: "MUL-1", title: "Plain input", description: null, metadata: {} },
    issueSession: { id: "ises_1", title: "Default" },
    triggerCommentId: "msg_1", triggerSummary: "please do X", triggerAuthorType: "member", triggerAuthorName: "Alice",
    sessionProjection: { session_id: "ises_1", mode: "bootstrap", from_seq: 0, to_seq: 2, jsonl: projection.join("\n") },
    ...overrides,
  } as Partial<AgentTask>);
}

function section(prompt: string, title: string): string | null {
  const start = prompt.indexOf(`\n## ${title}\n`);
  if (start < 0) return null;
  const body = prompt.slice(start + title.length + 5);
  const end = body.indexOf("\n## ");
  return end < 0 ? body : body.slice(0, end);
}

describe("plain turn input", () => {
  const hello = message(1, "你好");

  it("renders a complete one-to-one Chat message as the user's text", () => {
    const prompt = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]),
      [range("chat_1", 0, 2, 1, true), triggering(hello)]));
    expect(section(prompt, "Current Request")).toBe("你好\n");
    expect(prompt).not.toContain("unread_range");
    expect(prompt).not.toContain("动手前");
    expect(prompt).not.toContain("remi message list chat_1");
    expect(prompt).not.toContain("## Current Session Context");
    expect(prompt).toMatchSnapshot();
  });

  it("keeps the attachment sections of complete input", () => {
    const attachment = { id: "att_1", filename: "photo.png", content_type: "image/png", size: 10 };
    const prompt = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]),
      [range("chat_1", 0, 2, 1, true), triggering(hello)], { chatMessageAttachments: [attachment] }));
    expect(section(prompt, "Current Request")).toBe("你好\n");
    expect(prompt).toContain("Attachments:\n- id: att_1; filename: photo.png; content-type: image/png");
  });

  it("keeps today's prompt when the input is not complete or comes from an older server", () => {
    const prompt = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1), [hello]),
      [range("chat_1", 0, 2, 1), triggering(hello)]));
    expect(section(prompt, "Current Request")).toContain('{"type":"unread_range"');
    expect(section(prompt, "Current Session Context")).toContain("动手前先读完未读的部分");
    expect(prompt).toMatchSnapshot();
  });

  it("labels each message when several arrive and leaves out own range-only entries", () => {
    const own = message(2, "", { sender_type: "agent", sender_id: AGENT, message_kind: "reply", to_agent_id: null, wake_applied: "inbox_only" });
    const second = message(3, "在吗");
    const input = offered(range("chat_1", 1, 4, 1, true, false), [own, second]);
    const prompt = buildTaskPrompt(chatTurn(input, [range("chat_1", 1, 4, 1, true, false), triggering(second)],
      { sessionProjection: { session_id: "chat_1", mode: "delta", jsonl: [range("chat_1", 1, 4, 1, true, false), triggering(second)].join("\n") } }));
    // The own reply the range only listed drops out, leaving one human message: plain text.
    expect(section(prompt, "Current Request")).toBe("在吗\n");
    const coalesced = offered(range("chat_1", 0, 3, 2, true), [hello, message(2, "在吗")]);
    const many = buildTaskPrompt(chatTurn(coalesced, [range("chat_1", 0, 3, 2, true), triggering(hello), triggering(message(2, "在吗"))]));
    expect(section(many, "Current Request")).toBe("[1 · member mem_alice · request]\n你好\n\n[2 · member mem_alice · request]\n在吗\n");
  });

  it("labels authors in multi-author input, marking an agent's and the reader's own words", () => {
    const peer = message(2, "子单完成", { sender_type: "agent", sender_id: "agt_peer", message_kind: "report", wake_reason: "agent_dispatch" });
    const own = message(3, "自己的提醒", { sender_type: "agent", sender_id: AGENT });
    const input = offered(range("chat_1", 0, 3, 2, true), [hello, peer, own]);
    const prompt = buildTaskPrompt(chatTurn(input, [range("chat_1", 0, 3, 2, true), triggering(hello), triggering(peer), triggering(own)]));
    expect(section(prompt, "Current Request")).toBe([
      "[1 · member mem_alice · request]\n你好",
      "[2 · agent agt_peer · report]\n子单完成",
      `[3 · agent ${AGENT} (you) · request]\n自己的提醒\n`,
    ].join("\n\n"));
  });

  it("keeps range context for folded, replayed, side-conversation and partially marked input", () => {
    const folded = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]),
      [range("chat_1", 0, 2, 1, true), triggering(hello, { body_folded: true, body_omitted_chars: 3 })]));
    expect(section(folded, "Current Session Context")).toContain("动手前先读完未读的部分");
    const projectionIncomplete = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]),
      [range("chat_1", 0, 2, 1, false), triggering(hello)]));
    expect(section(projectionIncomplete, "Current Request")).toContain('{"type":"unread_range"');
    const replay = offered(range("chat_1", 1, 3, 1, true, false), [hello]);
    replay[0] = { ...replay[0]!, body_md: replay[0]!.body_md.replace("\n", `\n${replayInputHint("chat_1", 0, 1)}\n`) };
    expect(section(buildTaskPrompt(chatTurn(replay, [range("chat_1", 1, 3, 1, true, false)])), "Current Request"))
      .toContain("原始输入：remi message list chat_1 --from 0 --to 1");
    const side = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]), [range("chat_1", 0, 2, 1, true), triggering(hello)], {
      chatSessionId: null, issueId: "iss_1", issueSession: { id: "ises_side", title: "Side", inheritMode: "snapshot", parentSessionId: "ises_parent" },
      inheritedSessionProjection: { session_id: "ises_parent", mode: "inherited_delta", jsonl: range("ises_parent", 0, 5, 3) },
    } as Partial<AgentTask>));
    expect(section(side, "Current Request")).toContain('{"type":"unread_range"');
    expect(side).toContain("## Inherited Context From Session");
  });

  it("drops the Issue range read when the triggering comment is complete", () => {
    const comment = message(1, "please do X", { session_id: "ises_1", id: "msg_1" });
    const complete = buildTaskPrompt(issueTurn(offered(range("ises_1", 0, 2, 1, true), [comment]),
      [range("ises_1", 0, 2, 1, true), triggering(comment)]));
    expect(section(complete, "Current Request")).toBe("[1 · member mem_alice · request]\nplease do X\n");
    expect(complete).not.toContain("动手前");
    expect(complete).not.toContain("## Current Session Context");
    expect(section(complete, "Triggering Comment")).toContain("The comment body appears once in Current Request");
    expect(complete).toMatchSnapshot();
    // The comment for another agent before it is unread context: the range read stays.
    const aside = message(1, "", { session_id: "ises_1", id: "msg_0", to_agent_id: "agt_other", to_ref: "agt_other" });
    const later = { ...comment, seq: 2 };
    const incomplete = buildTaskPrompt(issueTurn(offered(range("ises_1", 0, 3, 2), [aside, later]),
      [range("ises_1", 0, 3, 2), triggering(later)], { input_to_seq: 3 }));
    expect(section(incomplete, "Triggering Comment")).toContain("动手前先执行 Current Session Context 中的范围读取命令");
    expect(incomplete).toMatchSnapshot();
  });

  it("decides a doorbell re-prompt from the projection when its first input left", () => {
    const user = message(3, "顺便看看这个");
    const projection = [range("chat_1", 1, 3, 2, true, false), triggering(user)];
    const prompt = buildTaskPrompt(chatTurn([user], projection));
    expect(section(prompt, "Current Request")).toBe("顺便看看这个\n");
    expect(prompt).not.toContain("动手前");
    const incomplete = buildTaskPrompt(chatTurn([user], [range("chat_1", 1, 3, 2, false, false), triggering(user)]));
    expect(section(incomplete, "Current Session Context")).toContain("动手前先读完未读的部分");
  });
});

describe("plain steer input", () => {
  const steer = (content: string) => ({ id: "msg_5", taskId: "tsk_turn", kind: "steer" as const, content,
    authorType: "user" as const, authorId: "mem_alice", createdAt: "2026-10-17T00:00:00.000Z", consumedAt: null });

  it("injects a complete steer as its text and keeps an incomplete one's range", () => {
    expect(buildSteerInjectionPrompt([steer(`${range("chat_1", 0, 5, 1, true)}\n改用中文输出`)])).toMatchSnapshot();
    expect(buildSteerInjectionPrompt([steer(`${range("chat_1", 0, 5, 1, true)}\n改用中文输出`)])).toContain("- 改用中文输出\n");
    const incomplete = buildSteerInjectionPrompt([steer(`${range("chat_1", 0, 5, 2, false)}\n改用中文输出`)]);
    expect(incomplete).toContain('- {"type":"unread_range"');
    expect(incomplete).toMatchSnapshot();
  });
});
