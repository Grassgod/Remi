import { expect, test } from "bun:test";
import { AcpProvider } from "@acp/provider.js";
import type { PromptResult, SessionNotification } from "@shared/contracts/acp-protocol.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Cancellation condition timed out");
    await Bun.sleep(1);
  }
}

function fixture(agentType: "claude" | "codex") {
  const provider = new AcpProvider({ agentType });
  const pending = Promise.withResolvers<PromptResult>();
  let calls = 0, cancels = 0, stops = 0, active = false;
  const client = {
    _options: { onSessionUpdate: (_notification: SessionNotification) => {} },
    async prompt(): Promise<PromptResult> {
      if (active) throw new Error("session_busy");
      active = true;
      const first = ++calls === 1;
      try {
        if (first) return await pending.promise;
        update("fresh answer");
        return { stopReason: "end_turn" };
      } finally { active = false; }
    },
    async cancel() { cancels++; },
    async stop() { stops++; pending.reject(new Error("ACP client stopped")); },
  };
  const entry = { client, acpSessionId: "same-session", lastUsed: Date.now() };
  (provider as any)._ensureSession = async () => entry;
  const update = (text: string) => client._options.onSessionUpdate({ sessionId: "same-session",
    update: { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text }] } });
  const state = () => ({ calls, cancels, stops });
  return { provider, pending, client, update, state };
}

for (const agentType of ["claude", "codex"] as const) test(`${agentType} waits for the cancelled prompt and retains late updates before steering`, async () => {
  const f = fixture(agentType);
  const abort = new AbortController();
  const events: string[] = [];
  let finished = false;
  const first = (async () => {
    try {
      for await (const event of f.provider.sendStream("original", { chatId: "chat", signal: abort.signal })) {
        if (event.sessionUpdate === "agent_message_chunk") {
          for (const block of event.content) if (block.type === "text") events.push(block.text);
        }
      }
    } catch (error) { return error; }
    finally { finished = true; }
  })();
  await until(() => f.state().calls === 1);
  abort.abort();
  await until(() => f.state().cancels === 1);
  expect(finished).toBe(false);
  expect(f.state().stops).toBe(0);
  f.update("late cancelled output");
  f.client._options.onSessionUpdate({ sessionId: "same-session", update: {
    sessionUpdate: "tool_call_update", toolCallId: "completed-before-cancel", status: "completed",
  } });
  f.pending.resolve({ stopReason: "cancelled", usage: { inputTokens: 7, outputTokens: 3 } });
  expect(await first).toMatchObject({ message: "Cancelled" });
  expect(events).toEqual(["late cancelled output"]);
  expect(f.provider.getLastResponse()).toMatchObject({ sessionId: "same-session", inputTokens: 7, outputTokens: 3 });

  const response = await f.provider.send("steering", { chatId: "chat" });
  expect(response.text).toBe("fresh answer");
  expect(response.sessionId).toBe("same-session");
  expect(f.state()).toEqual({ calls: 2, cancels: 1, stops: 0 });
});

test("an unresponsive cancellation stops the bridge and settles the old prompt before returning", async () => {
  const f = fixture("codex");
  const abort = new AbortController();
  const first = f.provider.send("original", { chatId: "chat", signal: abort.signal }).catch(error => error);
  await until(() => f.state().calls === 1);
  abort.abort();
  expect(await first).toMatchObject({ message: "Cancelled" });
  expect(f.state()).toEqual({ calls: 1, cancels: 1, stops: 1 });
  expect(f.provider.getLastResponse()?.sessionId).toBe("same-session");
}, 8_000);
