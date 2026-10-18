import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { buildAgentInstructions, buildTaskPrompt, buildTaskPromptArtifact } from "@daemon/agent-runtime/prompts/ephemeral.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import { buildSteerInjectionPrompt, steerMessageText } from "@multiremi/worker/steer.js";
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
    projectResources: [], repos: [], triggerCommentId: null, triggerSummary: null, requestingUserName: "Alice",
    agent: { id: AGENT, name: "Self", provider: "claude", model: null, instructions: "Answer briefly.", skills: [] },
    turn_id: "tsk_turn", attempt_id: "tsk_turn", input_from_seq: 0, input_to_seq: 2, input_messages: input,
    sessionProjection: { session_id: "chat_1", mode: "bootstrap", from_seq: 0, to_seq: 2, jsonl: projection.join("\n") },
    ...overrides,
  } as AgentTask;
}

function issueTurn(input: UnifiedMessage[], projection: string[], overrides: Partial<AgentTask> = {}): AgentTask {
  return chatTurn(input, projection, {
    chatSessionId: null, issueId: "iss_1", issueSessionId: "ises_1",
    issue: { id: "iss_1", key: "MUL-1", title: "Plain input", description: "Make input plain.", metadata: {} },
    issueSession: { id: "ises_1", title: "Default" },
    triggerCommentId: "msg_1", triggerSummary: "please do X", triggerAuthorType: "member", triggerAuthorName: "Alice",
    sessionProjection: { session_id: "ises_1", mode: "bootstrap", from_seq: 0, to_seq: 2, jsonl: projection.join("\n") },
    ...overrides,
  } as Partial<AgentTask>);
}

describe("turn input (ADR 0023)", () => {
  const hello = message(1, "你好");

  it("sends a complete one-to-one Chat message exactly as typed, and keeps the rest in AGENTS.md", () => {
    const artifact = buildTaskPromptArtifact(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]),
      [range("chat_1", 0, 2, 1, true), triggering(hello)]));
    expect(artifact.prompt).toBe("你好");
    for (const removed of ["# Bootstrap Prompt", "## Current Request", "## Current Turn", "unread_range", "Attachment Delivery"]) {
      expect(artifact.prompt).not.toContain(removed);
    }
    expect(artifact.instructions.startsWith("# Self\n\nAnswer briefly.\n\n# Remi\n")).toBe(true);
    expect(artifact.instructions).toContain("talking with Alice in a Remi Chat");
    expect(artifact.instructions).toContain("`remi message list chat_1`");
    expect(artifact.instructions).toContain("remi message send --attachment");
    expect(artifact.instructions).toContain("This Chat has no project, so no code is checked out for it.");
    expect(artifact.instructions).not.toMatch(/Bootstrap|Delta|tsk_turn/);
    expect(artifact.instructions).toMatchSnapshot();
  });

  it("lists attachments in one line each and drops nothing else into the text", () => {
    const prompt = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]),
      [range("chat_1", 0, 2, 1, true), triggering(hello)], { chatMessageAttachments: [
        { id: "att_1", filename: "photo.png", content_type: "image/png", size_bytes: 10, localPath: "/tmp/w/photo.png" },
        { id: "att_2", filename: "report.pdf", content_type: "application/pdf", size_bytes: 10, localDownloadError: "Download failed" },
      ] }));
    expect(prompt).toBe([
      "你好", "Attachments:\n- photo.png: /tmp/w/photo.png\n- report.pdf: not downloaded (Download failed); run `remi attachment download att_2 --output-dir <dir>`",
    ].join("\n\n"));
  });

  it("adds one plain sentence with the read command when the input is not complete", () => {
    const incomplete = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1), [hello]),
      [range("chat_1", 0, 2, 1), triggering(hello)]));
    expect(incomplete).toBe("你好\n\n(Some unread messages aren't shown here. Read them before you answer: `remi message list chat_1 --from 0 --to 2`)");
    // A cold start lists the earlier history without bodies: the sentence counts it.
    const earlier = message(1, "", { to_agent_id: null, wake_applied: "inbox_only" });
    const cold = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 3, 2), [earlier, message(2, "继续")]),
      [range("chat_1", 0, 3, 2), triggering(message(2, "继续"))]));
    expect(cold).toBe("继续\n\n(1 earlier unread message isn't shown here. Read it before you answer: `remi message list chat_1 --from 0 --to 3`)");
    expect(cold).not.toContain("{");
  });

  it("labels only when several authors speak, and leaves out own range-only entries", () => {
    const own = message(2, "", { sender_type: "agent", sender_id: AGENT, message_kind: "reply", to_agent_id: null, wake_applied: "inbox_only" });
    const second = message(3, "在吗");
    const projection = [range("chat_1", 1, 4, 1, true, false), triggering(second)];
    expect(buildTaskPrompt(chatTurn(offered(range("chat_1", 1, 4, 1, true, false), [own, second]), projection,
      { sessionProjection: { session_id: "chat_1", mode: "delta", jsonl: projection.join("\n") } }))).toBe("在吗");
    const coalesced = offered(range("chat_1", 0, 3, 2, true), [hello, message(2, "在吗")]);
    expect(buildTaskPrompt(chatTurn(coalesced, [range("chat_1", 0, 3, 2, true), triggering(hello), triggering(message(2, "在吗"))])))
      .toBe("你好\n\n在吗");
    const peer = message(2, "子单完成", { sender_type: "agent", sender_id: "agt_peer", message_kind: "report", wake_reason: "agent_dispatch" });
    const self = message(3, "自己的提醒", { sender_type: "agent", sender_id: AGENT });
    const doorbell = message(4, "后台任务已结束：build（已完成，用时 2 分）", { sender_type: "platform", sender_id: null, message_kind: "status" });
    const many = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 4, 3, true), [hello, peer, self, doorbell]),
      [range("chat_1", 0, 4, 3, true), triggering(hello), triggering(peer), triggering(self), triggering(doorbell)]));
    expect(many).toBe("[Alice] 你好\n\n[Agent agt_peer] 子单完成\n\n[You] 自己的提醒\n\n[Remi] 后台任务已结束：build（已完成，用时 2 分）");
    // Without a requester name the person is just the user.
    expect(buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 2, true), [hello, peer]),
      [range("chat_1", 0, 2, 2, true), triggering(hello), triggering(peer)], { requestingUserName: null })))
      .toBe("[User] 你好\n\n[Agent agt_peer] 子单完成");
    const alone = buildTaskPrompt(chatTurn(offered(range("chat_1", 3, 4, 1, true, false), [doorbell]),
      [range("chat_1", 3, 4, 1, true, false), triggering(doorbell)]));
    expect(alone).toBe("[Remi] 后台任务已结束：build（已完成，用时 2 分）");
    // A trigger only the projection carries names its author the log's way (`system`): still Remi.
    const relay = message(2, "MUL-1 有新日志", { id: "msg_relay" });
    const relayed = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 2, true), [hello]),
      [range("chat_1", 0, 2, 2, true), triggering(hello), triggering(relay, { author_type: "system", author_id: null })]));
    expect(relayed).toBe("你好\n\n[Remi] MUL-1 有新日志");
  });

  it("asks for the read of folded input, and adds nothing for a cold replacement's own replay", () => {
    const folded = buildTaskPrompt(chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]),
      [range("chat_1", 0, 2, 1, true), triggering(hello, { body_folded: true, body_omitted_chars: 3 })]));
    expect(folded).toBe("你好\n\n(Part of this input isn't shown here. Read it before you answer: `remi message list chat_1 --from 0 --to 2`)");
    const replay = offered(range("chat_1", 1, 3, 1, true, false), [hello]);
    replay[0] = { ...replay[0]!, body_md: replay[0]!.body_md.replace("\n", `\n${replayInputHint("chat_1", 0, 1)}\n`) };
    const replayed = buildTaskPrompt(chatTurn(replay, [range("chat_1", 1, 3, 1, true, false)]));
    expect(replayed).toBe("你好");
  });

  it("gives an Issue turn the labelled comment and the comment to reply to, and the Issue rules to AGENTS.md", () => {
    const comment = message(1, "please do X", { session_id: "ises_1", id: "msg_1" });
    const complete = buildTaskPromptArtifact(issueTurn(offered(range("ises_1", 0, 2, 1, true), [comment]),
      [range("ises_1", 0, 2, 1, true), triggering(comment)]), { platform: "linux" });
    expect(complete.prompt).toBe("[Alice] please do X\n\n(Reply to comment msg_1: `remi message send ises_1 --kind reply --reply-to msg_1`.)");
    expect(complete.instructions).toContain("working on Issue MUL-1 (\"Plain input\") in its Session \"Default\"");
    expect(complete.instructions).toContain("## Issue\nKey: MUL-1\nTitle: Plain input\nMake input plain.");
    expect(complete.instructions).toContain("cat <<'COMMENT' | remi message send ises_1 --kind reply --reply-to <comment-id> --content-stdin");
    expect(complete.instructions).toContain("## Issue Execution and Escalation");
    expect(complete.instructions).toContain("## Finishing");
    expect(complete.instructions).toMatchSnapshot();
    // A comment for another agent before it is unread context: the sentence asks for the read.
    const aside = message(1, "", { session_id: "ises_1", id: "msg_0", to_agent_id: "agt_other", to_ref: "agt_other" });
    const later = { ...comment, seq: 2 };
    const incomplete = buildTaskPrompt(issueTurn(offered(range("ises_1", 0, 3, 2), [aside, later]),
      [range("ises_1", 0, 3, 2), triggering(later)], { input_to_seq: 3 }));
    expect(incomplete).toBe([
      "[Alice] please do X",
      "(1 earlier unread message isn't shown here. Read it before you answer: `remi message list ises_1 --from 0 --to 3`)",
      "(Reply to comment msg_1: `remi message send ises_1 --kind reply --reply-to msg_1`.)",
    ].join("\n\n"));
    // A wake for this agent in another delegation's scope arrives blanked and is not this turn's trigger.
    const otherScope = message(1, "", { session_id: "ises_1", id: "msg_other" });
    expect(buildTaskPrompt(issueTurn(offered(range("ises_1", 0, 3, 2), [otherScope, later]),
      [range("ises_1", 0, 3, 2), triggering(later)], { input_to_seq: 3 }))).toBe(incomplete);
  });

  it("keeps a side Session's inheritance and boundary in AGENTS.md and only its input in the turn", () => {
    const side = buildTaskPromptArtifact(chatTurn(offered(range("ises_side", 0, 2, 1, true), [hello]), [range("ises_side", 0, 2, 1, true), triggering(hello)], {
      chatSessionId: null, issueId: "iss_1", issueSessionId: "ises_side",
      issueSession: { id: "ises_side", title: "Side", inheritMode: "snapshot", parentSessionId: "ises_parent" },
      inheritedSessionProjection: { session_id: "ises_parent", session_title: "Main", mode: "inherited_delta", jsonl: range("ises_parent", 0, 5, 3) },
    } as Partial<AgentTask>));
    expect(side.prompt).toBe("[Member mem_alice] 你好");
    expect(side.instructions).toContain("## Inherited Context From Session \"Main\"");
    expect(side.instructions).toContain("`remi message list ises_parent --from 0 --to 5` (3 events)");
    expect(side.instructions).toContain("## Side Conversation Boundary\nThe new input of each turn is the only active request.");
  });

  it("decides a doorbell re-prompt from the projection when its first input left", () => {
    const user = message(3, "顺便看看这个");
    expect(buildTaskPrompt(chatTurn([user], [range("chat_1", 1, 3, 2, true, false), triggering(user)]))).toBe("顺便看看这个");
    expect(buildTaskPrompt(chatTurn([user], [range("chat_1", 1, 3, 2, false, false), triggering(user)])))
      .toBe("顺便看看这个\n\n(Some unread messages aren't shown here. Read them before you answer: `remi message list chat_1 --from 1 --to 3`)");
  });

  it("does not depend on the provider session being new or resumed", () => {
    const input = offered(range("chat_1", 0, 2, 1, true), [hello]);
    const projection = [range("chat_1", 0, 2, 1, true), triggering(hello)];
    const fresh = buildTaskPromptArtifact(chatTurn(input, projection));
    const resumed = buildTaskPromptArtifact(chatTurn(input, projection,
      { sessionProjection: { session_id: "chat_1", mode: "delta", jsonl: projection.join("\n") } }));
    expect(resumed.prompt).toBe(fresh.prompt);
    expect(resumed.instructions).toBe(fresh.instructions);
    expect(fresh.mode).toBe("bootstrap");
    expect(resumed.mode).toBe("delta");
  });

  it("keeps AGENTS.md the same when the sender, warnings or bound status change, and says them in the turn", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const input = offered(range("chat_1", 0, 2, 1, true), [hello]);
    const projection = [range("chat_1", 0, 2, 1, true), triggering(hello)];
    const project = { id: "prj_1", title: "Live", description: null, instructions: "", workspaceId: "local" };
    const base = { sessionOwnerName: "Alice", sessionOwnerProfileDescription: "Owns this Chat.", project, chatProjectId: "prj_1",
      projectResources: [], repos: [{ url: "https://example.com/r.git" }] } as unknown as Partial<AgentTask>;
    const owner = buildTaskPromptArtifact(chatTurn(input, projection, base));
    // A Feishu group member who is not the owner sends the turn; Wiki and a repository are unavailable for it.
    const other = buildTaskPromptArtifact(chatTurn(input, projection, { ...base, requestingUserName: "Bob",
      requestingUserProfileDescription: "Infra on-call.", knowledgeWarnings: ["1 页暂不可用，用 remi wiki 取；保留上次成功的本地版本。"] } as Partial<AgentTask>),
    { repoWarnings: [{ repoUrl: "https://example.com/r.git", kind: "unavailable", message: "fetch timed out" }] });
    expect(sha(other.instructions)).toBe(sha(owner.instructions));
    expect(owner.instructions).toContain("talking with Alice in a Remi Chat");
    expect(owner.instructions).toContain("## Session Owner\nName: Alice\nOwns this Chat.");
    expect(owner.instructions).not.toMatch(/Bob|Infra on-call|Availability Warnings|fetch timed out|页暂不可用/);
    expect(owner.prompt).toBe("你好");
    expect(other.prompt).toBe([
      "[Bob] 你好",
      "(About Bob: Infra on-call.)",
      "(Repository warnings, diagnostic only: `https://example.com/r.git` is unavailable, preparation failed: `fetch timed out`. Don't claim to have inspected code that isn't available, or that a stale checkout has the latest remote changes; `remi repo checkout <repo-id>` retries a failed checkout, and an existing worktree with uncommitted changes must be preserved.)",
      "(Knowledge warnings: 1 页暂不可用，用 remi wiki 取；已有本地副本仅代表上次成功版本。)",
    ].join("\n\n"));

    // A bound topic's Issue status moves between turns: the file does not name it, the log line does.
    const bound = (status: string) => buildTaskPromptArtifact(chatTurn(input, projection, { sessionOwnerName: "Alice",
      boundIssue: { id: "iss_1", key: "MUL-1", title: "Bound", status },
      bound_issue_log: { session_id: "ises_1", from_seq: 0, to_seq: 3, content_jsonl: range("ises_1", 0, 3, 2) } } as unknown as Partial<AgentTask>));
    expect(sha(bound("todo").instructions)).toBe(sha(bound("in_review").instructions));
    expect(bound("in_review").prompt).toContain("(Issue MUL-1 (in_review) has 2 new log entries since you last read it: `remi message list ises_1 --from 0 --to 3`)");
  });

  it("shortens user-written parts to the budget, each with a pointer to the rest", () => {
    const task = chatTurn(offered(range("chat_1", 0, 2, 1, true), [hello]), [range("chat_1", 0, 2, 1, true), triggering(hello)],
      { agent: { id: AGENT, name: "Self", provider: "claude", model: null, instructions: "规则".repeat(20_000), skills: [] } } as unknown as Partial<AgentTask>);
    const instructions = buildAgentInstructions(task, { instructionsMaxBytes: 16 * 1024 });
    expect(Buffer.byteLength(instructions)).toBeLessThanOrEqual(16 * 1024);
    expect(instructions).toContain("characters omitted; read the rest with `remi agent get agt_self`)");
    expect(instructions).toContain("remi message send --attachment");
  });
});

describe("steer input (ADR 0023)", () => {
  const steer = (content: string, overrides: Record<string, unknown> = {}) => ({ id: "msg_5", taskId: "tsk_turn", kind: "steer" as const, content,
    authorType: "user" as const, authorId: "mem_alice", createdAt: "2026-10-17T00:00:00.000Z", consumedAt: null, ...overrides });

  it("is the user's text, with the unread sentence when its range is not complete", () => {
    expect(buildSteerInjectionPrompt([steer(`${range("chat_1", 0, 5, 1, true)}\n改用中文输出`)])).toBe("改用中文输出");
    expect(buildSteerInjectionPrompt([steer(`${range("chat_1", 0, 5, 2, false)}\n改用中文输出`)]))
      .toBe("改用中文输出\n\n(Some unread messages aren't shown here. Read them before you continue: `remi message list chat_1 --from 0 --to 5`)");
    expect(steerMessageText(`${range("chat_1", 0, 5, 2, false)}\n改用中文输出`)).toBe("改用中文输出");
  });

  it("labels several authors, an Issue's always, and keeps the wrap-up notice", () => {
    expect(buildSteerInjectionPrompt([steer("看这个"), steer("我来补充", { id: "msg_6", authorType: "agent", authorId: "agt_peer" })]))
      .toBe("[User] 看这个\n\n[Agent agt_peer] 我来补充");
    expect(buildSteerInjectionPrompt([steer("看这个")], { alwaysLabel: true })).toBe("[Member mem_alice] 看这个");
    const force = buildSteerInjectionPrompt([steer("", { id: "wrap", kind: "force_answer", authorType: "system", authorId: null })]);
    expect(force).toStartWith("[Deliver now] The user asked for the result immediately.");
    expect(force).toEndWith("Close out directly: summarize what was done, state your conclusion, and finish.");
  });
});
