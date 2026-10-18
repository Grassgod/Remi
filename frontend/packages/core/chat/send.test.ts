import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_SEND_TIMEOUT_MS, ChatSendTimeoutError, withChatSendTimeout } from "./send";

afterEach(() => { vi.useRealTimers(); });

describe("withChatSendTimeout", () => {
  it("answers with the send when it settles in time", async () => {
    await expect(withChatSendTimeout(async (signal) => (signal.aborted ? "aborted" : "sent"))).resolves.toBe("sent");
    await expect(withChatSendTimeout(async () => { throw new Error("refused"); })).rejects.toThrow("refused");
  });

  it("aborts the requests and rejects at the timeout, also when a request ignores the abort", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const result = withChatSendTimeout((given) => { signal = given; return new Promise<never>(() => {}); });
    const settled = expect(result).rejects.toBeInstanceOf(ChatSendTimeoutError);
    await vi.advanceTimersByTimeAsync(CHAT_SEND_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(ChatSendTimeoutError);
  });
});
