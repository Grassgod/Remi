import { createHash } from "node:crypto";

const MAX_ERROR_LENGTH = 300;
const FEISHU_IDENTIFIER = /(?<![A-Za-z0-9_])(?:ou|on|oc|om|cli|ma)_[A-Za-z0-9_-]+/gu;
const LABELED_CREDENTIAL = /\b((?:app[_-]?secret|access[_-]?token|refresh[_-]?token|tenant[_-]?access[_-]?token|authorization|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu;
const BEARER_CREDENTIAL = /\bBearer\s+[^\s,;}\]]+/giu;

export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function redactFeishuError(
  error: unknown,
  knownCredentials: readonly string[] = [],
): string {
  let message: string;
  try {
    message = error instanceof Error
      ? error.stack || `${error.name}: ${error.message}`
      : String(error);
  } catch {
    message = "Unknown error";
  }

  for (const credential of [...knownCredentials]
    .filter((value) => value.length >= 6)
    .sort((left, right) => right.length - left.length)) {
    message = message.split(credential).join("<credential>");
  }

  message = message
    .replace(BEARER_CREDENTIAL, "Bearer <credential>")
    .replace(LABELED_CREDENTIAL, "$1<credential>")
    .replace(FEISHU_IDENTIFIER, (identifier) => `<id:${hashIdentifier(identifier)}>`)
    .replace(/\s+/gu, " ")
    .trim();

  if (message.length <= MAX_ERROR_LENGTH) return message;
  return `${message.slice(0, MAX_ERROR_LENGTH - 3)}...`;
}
