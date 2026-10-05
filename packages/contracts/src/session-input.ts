export const TRIGGER_MESSAGE_INLINE_CHARS = 8_000;

export function expandHint(omittedChars: number, command: string): string {
  return `只看到了开头，还有 ${omittedChars} 字没看，和你有关时先展开：${command}`;
}

export function unreadRangeHint(sessionId: string, fromSeq: number, toSeq: number, unread: number, coldStart = false): string {
  return (coldStart ? `这是全新会话，没有先前的会话记忆；${fromSeq === 0 ? '从第 0 条开始' : `本次未读范围从第 ${fromSeq} 条之后开始`}，最新是第 ${toSeq} 条，共 ${unread} 条还没读。\n`
    : `你上次读到第 ${fromSeq} 条，现在最新是第 ${toSeq} 条，中间 ${unread} 条还没读。\n`)
    + `动手前先读完未读的部分，了解上下文：remi message list ${sessionId} --from ${fromSeq} --to ${toSeq}`;
}
