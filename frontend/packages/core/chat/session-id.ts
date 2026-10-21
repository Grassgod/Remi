const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const LENGTH = 12;
/** The largest multiple of the alphabet size a byte holds: bytes above it are drawn again, so no letter is likelier. */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/** The server's chat id (`createId("chat")` in packages/server/src/ids.ts): `chat_` and 12 of [0-9a-z]. */
export const CHAT_SESSION_ID_PATTERN = /^chat_[0-9a-z]{12}$/;

/**
 * A new chat's id, made by the client so the chat can be entered before the
 * server has created it. `crypto.getRandomValues` also works on a plain-http
 * origin, where `crypto.randomUUID` does not exist.
 */
export function createChatSessionId(): string {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.getRandomValues) throw new Error("Chat ids need crypto.getRandomValues");
  let value = "";
  while (value.length < LENGTH) {
    for (const byte of cryptoObj.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (byte >= UNBIASED_LIMIT) continue;
      value += ALPHABET[byte % ALPHABET.length];
      if (value.length === LENGTH) break;
    }
  }
  return `chat_${value}`;
}
