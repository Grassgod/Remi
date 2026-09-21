/**
 * Feishu bot slash-command routing (MUL-358).
 *
 * The Feishu client renders a "stop" control on native CoT messages. Pressing
 * it does not call the app: the client sends an ordinary IM text message as the
 * user — `/stop` in a single chat, `@bot /stop` in a group — so the platform
 * must recognise it in the inbound path exactly like `/help`. Text that is not
 * recognised as a command continues to the normal Task path.
 *
 * Commands are matched against the *raw* message content. The connector's
 * `text` carries presentation prefixes (`贺华杰: ` in groups, `[Replying to: …]`
 * for quoted replies), which is why matching on it previously made every
 * command in a group miss and fall through to Task creation.
 */

export interface FeishuCommand {
  /** Canonical command name without the leading slash, lower-cased. */
  name: string;
  /** Everything after the first whitespace run, trimmed; "" when absent. */
  args: string;
  /** The command exactly as typed, for echoing back to the user. */
  raw: string;
}

/** Command names the bot answers. Anything else is not a command. */
export const FEISHU_COMMANDS = [
  "stop",
  "esc",
  "new",
  "status",
  "sessions",
  "context",
  "cwd",
  "compact",
] as const;

const COMMAND_NAMES = new Set<string>(FEISHU_COMMANDS);

/** `/name` with optional arguments, anchored to the whole message. */
const COMMAND_PATTERN = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/;

/**
 * A bare slash token with no arguments or second slash.
 *
 * Only this shape is answered with a hint when unrecognised, so a path such as
 * `/data00/home/x 看下` or a request like `/help 怎么用` still reaches the Agent.
 */
const BARE_COMMAND_PATTERN = /^\/([A-Za-z][\w-]*)$/;

/**
 * Parse one message body into a command, or null when it is not a command.
 *
 * Mentions are already stripped by the connector, so `@Remi /stop` arrives here
 * as `/stop`. Leading/trailing whitespace and the command's case are ignored.
 * A message that merely starts with a slash is left alone: `/data00/x 看下`
 * and `/help 怎么用` are ordinary requests, not commands.
 */
export function resolveFeishuCommand(rawContent: string | null | undefined): FeishuCommand | null {
  if (typeof rawContent !== "string") return null;
  const trimmed = rawContent.trim();
  const match = COMMAND_PATTERN.exec(trimmed);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (!COMMAND_NAMES.has(name)) return null;
  return { name, args: (match[2] ?? "").trim(), raw: trimmed };
}

/**
 * A bare single-token slash message that is not a known command.
 *
 * Only this shape is answered with a hint. Keeping the test this narrow means a
 * path, a URL, or any message with arguments still reaches the Agent.
 */
export function isUnknownFeishuCommand(rawContent: string | null | undefined): boolean {
  if (typeof rawContent !== "string") return false;
  const match = BARE_COMMAND_PATTERN.exec(rawContent.trim());
  if (!match) return false;
  return !COMMAND_NAMES.has(match[1]!.toLowerCase());
}

/** Hint shown for an unrecognised bare slash command. */
export function unknownCommandMessage(rawContent: string): string {
  const trimmed = rawContent.trim();
  const match = BARE_COMMAND_PATTERN.exec(trimmed);
  const name = match ? match[1]! : trimmed;
  return [
    `Unsupported command /${name}. Nothing was started.`,
    "",
    `Available commands: ${FEISHU_COMMANDS.map((command) => `/${command}`).join(" ")}`,
  ].join("\n");
}
