/**
 * Turn input (ADR 0023). Each turn gives the agent only what is new: the
 * messages that woke it, a short author label where that matters, one plain
 * sentence when unread messages are not shown, and the few per-turn facts it
 * needs (the comment to reply to, a bound Issue's new log entries, an
 * automation's trigger payload, a sender who is not the session's owner, what
 * this turn's repository and knowledge preparation could not provide).
 * Everything that holds for the session lives in the provider home's
 * `AGENTS.md` instead (`buildAgentInstructions`), so that file stays the same
 * from turn to turn.
 */
import { readFileSync, statSync } from "node:fs";
import type { MediaAttachment } from "@multiremi/contracts/acp-protocol.js";
import { parseUnreadRange, splitProjectedInput, TRIGGER_MESSAGE_INLINE_CHARS, type UnreadRangeRecord } from "@multiremi/contracts/session-input.js";
import type { MultiremiTaskSteerMessage } from "@multiremi/contracts/types.js";
import type { UnifiedMessage } from "@multiremi/contracts/unified-model.js";
import type { AgentTask } from "@daemon/contracts/types.js";

/** A Chat that is not a Feishu topic bound to an Issue: its input reads as a plain conversation. */
export function isPrivateChatTask(task: AgentTask): boolean {
  return Boolean(task.chatSessionId && !(task.boundIssue ?? task.bound_issue));
}

/** Images the providers accept inline; larger ones stay files the agent reads. */
const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Anthropic rejects a base64 image above 5 MB; 3.75 MB of bytes is that limit encoded. */
export const NATIVE_IMAGE_MAX_BYTES = 3_750_000;

interface InputAttachment {
  id: string;
  filename: string;
  contentType: string;
  localPath?: string;
  localDownloadError?: string;
}

function inputAttachment(value: unknown): InputAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" ? record[key] as string : "";
  const id = text("id");
  if (!id) return null;
  return {
    id,
    // A name is shown, never used as a path; control characters and directories are dropped.
    filename: text("filename").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).filter(Boolean).at(-1) || id,
    contentType: text("content_type") || text("contentType"),
    ...(text("localPath") ? { localPath: text("localPath") } : {}),
    ...(text("localDownloadError") ? { localDownloadError: text("localDownloadError") } : {}),
  };
}

/** One line per attachment: where it is, or how to fetch it. */
export function attachmentLines(values: readonly unknown[] | undefined): string[] {
  const attachments = (values ?? []).map(inputAttachment).filter((value): value is InputAttachment => value !== null);
  if (!attachments.length) return [];
  return ["Attachments:", ...attachments.map(attachment => attachment.localPath
    ? `- ${attachment.filename}: ${attachment.localPath}`
    : `- ${attachment.filename}: ${attachment.localDownloadError ? `not downloaded (${attachment.localDownloadError}); ` : ""}run \`remi attachment download ${attachment.id} --output-dir <dir>\``)];
}

/**
 * The turn's downloaded images, for ACP image blocks. The bridge drops them
 * when the agent does not advertise image prompts; the attachment line with
 * the path stays in the text either way.
 */
export function turnImages(values: readonly unknown[] | undefined): MediaAttachment[] {
  const images: MediaAttachment[] = [];
  for (const attachment of (values ?? []).map(inputAttachment)) {
    if (!attachment?.localPath || !NATIVE_IMAGE_TYPES.has(attachment.contentType.toLowerCase())) continue;
    try {
      const stat = statSync(attachment.localPath);
      if (!stat.isFile() || stat.size > NATIVE_IMAGE_MAX_BYTES) continue;
      images.push({ buffer: readFileSync(attachment.localPath), contentType: attachment.contentType.toLowerCase(),
        fileName: attachment.filename, mediaType: "image" });
    } catch { /* The file stays listed; a vanished download is read through its path or not at all. */ }
  }
  return images;
}

interface Speaker { type: string; id: string | null; name?: string | null }

/** Steers and conversation-log entries name their authors `user`/`system`; messages `member`/`platform`. */
const SPEAKER_TYPE: Record<string, string> = { user: "member", system: "platform" };
function speakerType(type: string): string {
  return SPEAKER_TYPE[type] ?? type;
}

/**
 * Author labels. A private Chat labels only when they tell the agent something
 * (several people, another agent, Remi itself); an Issue or a bound topic always
 * names the author, since several people and agents write there.
 */
function speakerLabeler(speakers: readonly Speaker[], agentId: string | null, always: boolean): (speaker: Speaker) => string | null {
  const members = new Set(speakers.filter(speaker => speaker.type === "member").map(speaker => speaker.id ?? ""));
  const agents = speakers.some(speaker => speaker.type === "agent");
  return (speaker) => {
    if (speaker.type === "platform") return "[Remi]";
    if (speaker.type === "timer") return "[Remi automation]";
    if (speaker.type === "agent") return speaker.id && speaker.id === agentId ? "[You]" : `[Agent ${speaker.name?.trim() || speaker.id || "unknown"}]`;
    if (speaker.name?.trim() && (always || members.size > 1 || agents)) return `[${speaker.name.trim()}]`;
    if (always || members.size > 1) return `[Member ${speaker.id ?? "unknown"}]`;
    return agents ? "[User]" : null;
  };
}

function labelled(label: string | null, body: string): string {
  return label ? (body ? `${label} ${body}` : label) : body;
}

function readCommand(range: Pick<UnreadRangeRecord, "session_id" | "from_seq" | "to_seq">): string {
  return `\`remi message list ${range.session_id} --from ${range.from_seq} --to ${range.to_seq}\``;
}

/** The one sentence incomplete input gets. The server's input receipt needs the read, so it is not optional. */
function unreadSentence(range: UnreadRangeRecord, missing: number, partial: boolean): string {
  if (missing > 0) {
    return `(${missing} earlier unread message${missing === 1 ? " isn't" : "s aren't"} shown here. `
      + `Read ${missing === 1 ? "it" : "them"} before you answer: ${readCommand(range)})`;
  }
  return partial
    ? `(Part of this input isn't shown here. Read it before you answer: ${readCommand(range)})`
    : `(Some unread messages aren't shown here. Read them before you answer: ${readCommand(range)})`;
}

interface ProjectionTrigger { id: string; seq: number; author_type: string; author_id: string | null; body: string; folded: boolean }

function projectionRecords(task: AgentTask): { range: UnreadRangeRecord | null; triggers: ProjectionTrigger[] } {
  const projection = task.sessionProjection ?? task.session_projection ?? null;
  const [first, ...lines] = projection?.jsonl?.split("\n") ?? [];
  const range = parseUnreadRange(first);
  if (!range) return { range: null, triggers: [] };
  const triggers: ProjectionTrigger[] = [];
  let unreadable = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "triggering_message") continue;
      const folded = Boolean(entry.body_folded || entry.body_omitted_chars);
      triggers.push({ id: String(entry.id), seq: Number(entry.seq), author_type: speakerType(String(entry.author_type ?? "")),
        author_id: entry.author_id ?? null, folded,
        body: `${String(entry.body ?? "")}${folded && entry.expand_hint ? `\n${entry.expand_hint}` : ""}` });
    } catch { unreadable = true; }
  }
  // A line that cannot be read may be a folded trigger: the range is no longer known to be complete.
  return { range: unreadable ? { ...range, complete: undefined } : range, triggers };
}

function text(task: AgentTask, camel: keyof AgentTask, snake: keyof AgentTask): string | null {
  const value = task[camel] ?? task[snake];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * What a turn sends the provider. Complete input (every unread message inline
 * in full, per the server's `complete` range mark) is the messages alone;
 * otherwise one sentence names the unread messages that are not shown and the
 * read the server's input receipt requires.
 */
/** A repository this turn's preparation could not provide as asked. */
export interface TurnRepoWarning { repoUrl: string; kind: string; message: string }

export function buildTurnInput(task: AgentTask, options: { attachments?: readonly unknown[]; repoWarnings?: readonly TurnRepoWarning[] } = {}): string {
  const agentId = task.agent?.id ?? null;
  const owner = text(task, "sessionOwnerName", "session_owner_name")?.trim() ?? null;
  const requesterName = text(task, "requestingUserName", "requesting_user_name")?.trim() ?? null;
  // A Chat turn sent by someone other than the session's owner (a Feishu group member) names its sender.
  const otherSender = Boolean(task.chatSessionId && owner && requesterName && requesterName !== owner);
  const always = !isPrivateChatTask(task) || otherSender;
  const input = task.input_messages ?? [];
  let range: UnreadRangeRecord | null = null;
  let replay = false;
  let messages: UnifiedMessage[] = input;
  if (input.length) {
    const first = splitProjectedInput(input[0]!.body_md);
    range = first.range;
    replay = first.replay;
    if (first.range) messages = [{ ...input[0]!, body_md: first.body }, ...input.slice(1)];
  }
  const projection = projectionRecords(task);
  const foldedIds = new Set(projection.triggers.filter(trigger => trigger.folded).map(trigger => trigger.id));
  // The projection names this turn's triggers; without it, a message that woke this agent is one. A wake
  // addressed to this agent in another delegation's scope arrives blanked and is not this turn's.
  const triggerIds = new Set(projection.triggers.map(trigger => trigger.id));
  const isTrigger = (message: UnifiedMessage) => projection.range ? triggerIds.has(message.id)
    : Boolean(agentId) && message.to_agent_id === agentId && message.wake_applied === "now";
  const isOwn = (message: UnifiedMessage) => message.sender_type === "agent" && message.sender_id === agentId;
  const shown = messages.filter(message => message.body_md.trim() || isTrigger(message));
  // Listed by the range without a body: unread context the agent has not been given.
  const missing = messages.filter(message => !shown.includes(message) && !isOwn(message)).length;
  // Triggers the projection carries outside this input (a doorbell re-prompt drops the doorbell).
  const extra = projection.triggers.filter(trigger => !input.some(message => message.id === trigger.id)
    && !(trigger.author_type === "agent" && trigger.author_id === agentId));
  const triggerCommentId = text(task, "triggerCommentId", "trigger_comment_id");
  const triggerAuthor = text(task, "triggerAuthorName", "trigger_author_name");
  // A Chat's one person is its requester; an Issue names only the triggering comment's author.
  const requester = task.chatSessionId ? text(task, "requestingUserName", "requesting_user_name") : null;
  const members = new Set([...shown.map(message => message.sender_type === "member" ? message.sender_id ?? "" : null),
    ...extra.map(trigger => trigger.author_type === "member" ? trigger.author_id ?? "" : null)].filter(id => id !== null));
  const nameOf = (id: string, type: string) => id === triggerCommentId ? triggerAuthor
    : type === "member" && requester && members.size === 1 ? requester : null;
  const entries = [
    ...shown.map(message => ({ seq: message.seq, speaker: { type: message.sender_type, id: message.sender_id, name: nameOf(message.id, message.sender_type) },
      body: message.body_md, folded: foldedIds.has(message.id) || message.body_md.length > TRIGGER_MESSAGE_INLINE_CHARS })),
    ...extra.map(trigger => ({ seq: trigger.seq, speaker: { type: trigger.author_type, id: trigger.author_id, name: nameOf(trigger.id, trigger.author_type) },
      body: trigger.body, folded: trigger.folded })),
  ].sort((left, right) => left.seq - right.seq);
  const label = speakerLabeler(entries.map(entry => entry.speaker), agentId, always);
  const parts = entries.map(entry => labelled(label(entry.speaker), entry.body.trim() ? entry.body : "")).filter(Boolean);
  const senderProfile = otherSender ? text(task, "requestingUserProfileDescription", "requesting_user_profile_description")?.trim() : null;
  if (senderProfile && senderProfile !== text(task, "sessionOwnerProfileDescription", "session_owner_profile_description")?.trim()
    && entries.some(entry => entry.speaker.type === "member" && entry.speaker.name === requester)) {
    parts.push(`(About ${requesterName}: ${clip(senderProfile, SENDER_PROFILE_MAX_CHARS)})`);
  }
  if (!input.length && !entries.length) {
    const legacy = (text(task, "chatMessage", "chat_message") ?? "").trim() || (task.prompt ?? "").trim();
    parts.push(legacy || (task.chatSessionId ? "" : "Handle the current issue update."));
  }
  const record = range ?? projection.range;
  const complete = (range ? range.complete === true && !replay : true)
    && (projection.range ? projection.range.complete === true && !projection.triggers.some(trigger => trigger.folded) : true);
  if (!complete && record) {
    const partial = entries.some(entry => entry.folded);
    if (missing > 0 || partial || !replay) parts.push(unreadSentence(record, missing, partial));
  }
  const sessionId = text(task, "issueSessionId", "issue_session_id") ?? task.issueSession?.id ?? task.issue_session?.id ?? null;
  if (triggerCommentId && sessionId) {
    parts.push(`(Reply to comment ${triggerCommentId}: \`remi message send ${sessionId} --kind reply --reply-to ${triggerCommentId}\`.)`);
  }
  const boundLine = boundIssueLogLine(task);
  if (boundLine) parts.push(boundLine);
  const payload = task.autopilotTriggerPayload ?? task.autopilot_trigger_payload;
  if (payload !== undefined && payload !== null) parts.push(`Trigger payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);
  const attachments = attachmentLines(options.attachments);
  if (attachments.length) parts.push(attachments.join("\n"));
  const repositories = repositoryWarningLine(options.repoWarnings ?? []);
  if (repositories) parts.push(repositories);
  const knowledge = knowledgeWarningLine(task);
  if (knowledge) parts.push(knowledge);
  return parts.filter(Boolean).join("\n\n") || "(The message is empty.)";
}

const SENDER_PROFILE_MAX_CHARS = 300;
const WARNING_DIAGNOSTIC_MAX_CHARS = 200;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

/** Diagnostic data, not instructions: what the agent must not claim it inspected. */
function repositoryWarningLine(warnings: readonly TurnRepoWarning[]): string | null {
  if (!warnings.length) return null;
  const entries = warnings.map((warning) => {
    const diagnostic = inlineCode(clip(warning.message, WARNING_DIAGNOSTIC_MAX_CHARS) || "repository preparation failed");
    const state = warning.kind === "stale_cache" ? "may be stale, remote refresh failed"
      : warning.kind === "default_branch_fallback" ? "is on a fallback base, the default branch could not be resolved"
        : "is unavailable, preparation failed";
    return `${inlineCode(warning.repoUrl.trim())} ${state}: ${diagnostic}`;
  });
  return `(Repository warnings, diagnostic only: ${entries.join("; ")}. Don't claim to have inspected code that isn't available, or that a stale checkout has the latest remote changes; \`remi repo checkout <repo-id>\` retries a failed checkout, and an existing worktree with uncommitted changes must be preserved.)`;
}

function knowledgeWarningLine(task: AgentTask): string | null {
  const contexts = task.repositoryWikiContexts ?? task.repository_wiki_contexts ?? [];
  const unavailable = new Set(contexts.flatMap((context) => context.docs.filter(repositoryWikiDocUnavailable).map((doc) => doc.id)));
  const warnings = task.knowledgeWarnings ?? [];
  const wikiWarnings = warnings.filter(warning => /wiki.*(?:failed|unavailable|omitted)|页暂不可用/i.test(warning));
  const otherWarnings = warnings.filter(warning => !wikiWarnings.includes(warning));
  const reportedCount = wikiWarnings.reduce((total, warning) => total + Number(warning.match(/^(\d+) 页暂不可用/)?.[1] ?? 0), 0);
  const count = Math.max(unavailable.size, reportedCount);
  const lines = [
    ...(count || wikiWarnings.length ? [`${count ? `${count} 页` : "Wiki"}暂不可用，用 remi wiki 取；已有本地副本仅代表上次成功版本。`] : []),
    ...otherWarnings.map(warning => clip(warning, WARNING_DIAGNOSTIC_MAX_CHARS)),
  ];
  return lines.length ? `(Knowledge warnings: ${lines.join(" ")})` : null;
}

function repositoryWikiDocUnavailable(doc: NonNullable<AgentTask["repositoryWikiContexts"]>[number]["docs"][number]): boolean {
  const status = String(doc.status ?? "").trim().toLowerCase();
  const syncStatus = String(doc.syncStatus ?? doc.sync_status ?? "").trim().toLowerCase();
  return status === "failed" || status === "unavailable" || syncStatus === "failed" || syncStatus === "unavailable";
}

/** A bound topic's Issue: what was logged there since the coordinator last read it. */
function boundIssueLogLine(task: AgentTask): string | null {
  const bound = task.chatSessionId ? task.boundIssue ?? task.bound_issue ?? null : null;
  const log = task.boundIssueLog ?? task.bound_issue_log ?? null;
  if (!bound || !log) return null;
  // The status when this turn started; it moves between turns, so AGENTS.md does not carry it.
  const status = bound.status ? ` (${bound.status})` : "";
  const range = parseUnreadRange(log.content_jsonl?.split("\n", 1)[0]);
  if (range) {
    if (!range.unread_count) return null;
    return `(Issue ${bound.key}${status} has ${range.unread_count} new log entr${range.unread_count === 1 ? "y" : "ies"} since you last read it: ${readCommand(range)})`;
  }
  return log.to_seq > log.from_seq
    ? `(Issue ${bound.key}${status} has new log entries: \`remi message list ${log.session_id} --from ${log.from_seq} --to ${log.to_seq}\`)`
    : null;
}

type PreparedSteer = MultiremiTaskSteerMessage & { localAttachments?: unknown[] };


/** A steer message's own words, as the turn input shows them: its range record removed. */
export function steerInputText(content: string): string {
  const input = splitProjectedInput(content);
  return input.range ? input.body : content;
}

/**
 * A steer batch: the new messages, labelled as the turn input labels them, and
 * the unread sentence when the batch's range is not complete. Wrap-up keeps its
 * control notice; it is Remi speaking, not the user.
 */
export function buildSteerInput(messages: readonly PreparedSteer[], options: { agentId?: string | null; alwaysLabel?: boolean } = {}): string {
  const steers = messages.filter(message => message.kind !== "force_answer");
  const force = messages.filter(message => message.kind === "force_answer");
  const speakerOf = (message: PreparedSteer) => ({ type: speakerType(message.authorType), id: message.authorId });
  const label = speakerLabeler(steers.filter(message => steerInputText(message.content).trim()).map(speakerOf),
    options.agentId ?? null, options.alwaysLabel === true);
  const parts: string[] = [];
  let incomplete: UnreadRangeRecord | null = null;
  for (const message of steers) {
    const input = splitProjectedInput(message.content);
    if (input.range && (input.range.complete !== true || input.replay)) incomplete ??= input.range;
    const body = input.range ? input.body : message.content;
    const lines = attachmentLines(message.localAttachments ?? message.attachments);
    if (!body.trim() && !lines.length) continue;
    parts.push([labelled(label(speakerOf(message)), body.trim() ? body : ""), ...(lines.length ? [lines.join("\n")] : [])]
      .filter(Boolean).join("\n\n"));
  }
  if (incomplete) parts.push(`(Some unread messages aren't shown here. Read them before you continue: ${readCommand(incomplete)})`);
  if (force.length) {
    const notes = force.map(message => message.content.trim()).filter(Boolean);
    parts.push([
      "[Deliver now] The user asked for the result immediately. Stop exploring and stop making new changes. "
        + "Based on the work completed so far, produce your best final conclusion and wrap up the task now.",
      ...notes.map(note => `- ${note}`),
    ].join("\n"), "Close out directly: summarize what was done, state your conclusion, and finish.");
  }
  return parts.join("\n\n");
}
