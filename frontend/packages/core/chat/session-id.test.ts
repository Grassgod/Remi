import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_SESSION_ID_PATTERN, createChatSessionId } from "./session-id";

afterEach(() => vi.unstubAllGlobals());

describe("createChatSessionId", () => {
  it("makes ids in the server's chat format, different every time", () => {
    const ids = Array.from({ length: 200 }, createChatSessionId);
    for (const id of ids) expect(id).toMatch(CHAT_SESSION_ID_PATTERN);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("works without crypto.randomUUID (a plain-http origin) and draws again for bytes past the last full alphabet", () => {
    // 252..255 would favour the first four letters; they are skipped.
    const bytes = [255, 252, ...Array.from({ length: 12 }, (_, index) => index + 36)];
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => {
        array.set(bytes.slice(0, array.length));
        return array;
      },
    });
    expect(createChatSessionId()).toBe("chat_0123456789ab");
  });
});
