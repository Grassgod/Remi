export const TRIGGER_MESSAGE_INLINE_CHARS = 8_000;

export function expandHint(omittedChars: number, command: string): string {
  return `只看到了开头，还有 ${omittedChars} 字没看，和你有关时先展开：${command}`;
}

export function unreadRangeHint(sessionId: string, fromSeq: number, toSeq: number, unread: number, coldStart = false): string {
  return (coldStart ? `这是全新会话，没有先前的会话记忆；${fromSeq === 0 ? '从第 0 条开始' : `本次未读范围从第 ${fromSeq} 条之后开始`}，最新是第 ${toSeq} 条，共 ${unread} 条还没读。\n`
    : `你上次读到第 ${fromSeq} 条，现在最新是第 ${toSeq} 条，中间 ${unread} 条还没读。\n`)
    + `动手前先读完未读的部分，了解上下文：remi message list ${sessionId} --from ${fromSeq} --to ${toSeq}`;
}

const REPLAY_INPUT_PREFIX = "原始输入：";

/** A cold replacement re-supplies its turn's original input ahead of the unread range. */
export function replayInputHint(sessionId: string, fromSeq: number, toSeq: number): string {
  return `${REPLAY_INPUT_PREFIX}remi message list ${sessionId} --from ${fromSeq} --to ${toSeq}`;
}

/** The record that leads every turn input projection. */
export interface UnreadRangeRecord {
  type: "unread_range";
  session_id: string;
  from_seq: number;
  to_seq: number;
  unread_count: number;
  instruction: string;
  /**
   * Additive, present only as `true`: every unread message in the range is already
   * inline in full, so reading the range adds nothing. Absent means "read the range".
   */
  complete?: true;
}

export function parseUnreadRange(line: string | undefined): UnreadRangeRecord | null {
  if (!line?.startsWith('{"type":"unread_range"')) return null;
  try {
    const value = JSON.parse(line) as UnreadRangeRecord | null;
    return value?.type === "unread_range" ? value : null;
  } catch { return null; }
}

/**
 * Splits the server's leading lines off the first projected input message: the
 * range record and, on a cold replacement, the original-input pointer.
 */
export function splitProjectedInput(body: string): { range: UnreadRangeRecord | null; replay: boolean; body: string } {
  const firstLine = (text: string) => { const end = text.indexOf("\n"); return end < 0 ? text.length : end; };
  const range = parseUnreadRange(body.slice(0, firstLine(body)));
  if (!range) return { range: null, replay: false, body };
  let rest = body.slice(firstLine(body) + 1);
  const replay = rest.startsWith(REPLAY_INPUT_PREFIX);
  if (replay) rest = rest.slice(firstLine(rest) + 1);
  return { range, replay, body: rest };
}
