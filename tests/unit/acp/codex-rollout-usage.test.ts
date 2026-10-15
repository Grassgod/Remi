import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginCodexRolloutUsage, collectCodexRolloutUsage } from "@acp/codex-rollout-usage.js";
import { AcpProvider, accumulateUsage, createPromptUsageState, resolvePromptUsage, settleCodexRolloutUsage } from "@acp/provider.js";

// Record shapes copied from codex 0.162.1 rollouts (resumed, forked and
// subagent threads), where app-server sends no rawResponse/completed.
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "remi-codex-rollout-"));
  homes.push(dir);
  return dir;
}
const DAY = 86_400_000;
function uuid7(ms: number, tail: string): string {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, "0")}`;
}
function rolloutPath(codexHome: string, threadId: string, createdMs: number): string {
  const date = new Date(createdMs);
  const dir = join(codexHome, "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-${date.toISOString().slice(0, 19).replace(/:/g, "-")}-${threadId}.jsonl`);
}
const line = (at: number, type: string, payload: unknown) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + "\n";
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const record = (at: number, thread: string, session: string, response: string, value: unknown) => line(at, "token_usage_record", {
  thread_id: thread, turn_id: `turn-${response}`, session_id: session, root_turn_id: `turn-${response}`, response_id: response,
  usage: value, turn_token_usage: value, thread_token_usage: value });
const turnEnd = (at: number, type = "task_complete") => line(at, "event_msg", { type, turn_id: "turn" });
const tokens = (request: any) => [request.threadId, request.usage.providerRequestId, request.usage.inputTokens,
  request.usage.cachedInputTokens, request.usage.outputTokens, request.usage.totalTokens, request.usage.accuracy];

describe("Codex native rollout request usage", () => {
  it("reads only the requests a resumed prompt appended, including compaction", async () => {
    const codexHome = home(), now = Date.now(), created = now - 3 * DAY;
    const root = uuid7(created, "abc123def456");
    const file = rolloutPath(codexHome, root, created);
    writeFileSync(file, line(created, "session_meta", { id: root }) + record(created + 10, root, root, "resp_old", usage(100, 50, 5)) + turnEnd(created + 11));
    const cursor = beginCodexRolloutUsage(codexHome, root, now);
    appendFileSync(file, line(now + 1, "turn_context", { turn_id: "turn", model: "gpt" })
      + record(now + 2, root, root, "resp_new", usage(18678, 18432, 5))
      + line(now + 3, "compacted", { message: "", latest_token_usage_record: { thread_id: root, session_id: root,
        turn_id: "turn", response_id: "resp_compact", usage: usage(244990, 244864, 2645) } })
      + line(now + 4, "event_msg", { type: "token_count", info: { last_token_usage: usage(1, 0, 1) } })
      + turnEnd(now + 5));
    const requests = await collectCodexRolloutUsage(cursor, { requestedModel: "gpt-6.1-sol[low]" });
    expect(requests.map(tokens)).toEqual([
      [root, "resp_new", 246, 18432, 5, 18683, "exact"],
      [root, "resp_compact", 126, 244864, 2645, 247635, "exact"],
    ]);
    expect(requests[0]!.usage).toMatchObject({ providerSessionId: root, source: "codex_response_usage", scope: "request_snapshot",
      model: null, requestedModel: "gpt-6.1-sol[low]", modelSource: "session_acknowledged" });
  });

  it("attributes native children to the root and ignores other sessions sharing CODEX_HOME", async () => {
    const codexHome = home(), now = Date.now();
    const root = uuid7(now - 1000, "aaaaaa111111"), child = uuid7(now + 5, "bbbbbb222222"), other = uuid7(now - 500, "cccccc333333");
    writeFileSync(rolloutPath(codexHome, root, now - 1000), line(now - 1000, "session_meta", { id: root }));
    writeFileSync(rolloutPath(codexHome, other, now - 500), line(now - 500, "session_meta", { id: other }));
    const cursor = beginCodexRolloutUsage(codexHome, root, now);
    // A child rollout repeats the parent's session_meta; its own records
    // carry the root as session_id.
    writeFileSync(rolloutPath(codexHome, child, now + 5), line(now + 5, "session_meta", { id: child, forked_from_id: root })
      + line(now + 5, "session_meta", { id: root }) + record(now + 6, child, root, "resp_child", usage(18514, 12032, 6)));
    appendFileSync(rolloutPath(codexHome, other, now - 500), record(now + 7, other, other, "resp_other", usage(10, 0, 1)));
    appendFileSync(rolloutPath(codexHome, root, now - 1000), record(now + 8, root, root, "resp_root", usage(18726, 12288, 31)) + turnEnd(now + 9));
    const requests = await collectCodexRolloutUsage(cursor, { requestedModel: "gpt" });
    expect(requests.map(request => [request.threadId, request.usage.providerRequestId, request.usage.requestedModel, request.usage.modelSource]).sort())
      .toEqual([[child, "resp_child", null, "unknown"], [root, "resp_root", "gpt", "session_acknowledged"]].sort());
  });

  it("waits for the root's own turn end and never parses a torn line", async () => {
    const codexHome = home(), now = Date.now(), root = uuid7(now, "dddddd444444");
    const file = rolloutPath(codexHome, root, now);
    const cursor = beginCodexRolloutUsage(codexHome, root, now - 1);
    const whole = record(now, root, root, "resp_late", usage(300, 200, 10));
    // An earlier turn already ended; the last turn's record is half written.
    writeFileSync(file, record(now, root, root, "resp_first", usage(20, 0, 2)) + turnEnd(now) + whole.slice(0, 40));
    const started = Date.now();
    setTimeout(() => appendFileSync(file, whole.slice(40) + turnEnd(now + 1, "turn_aborted")), 120);
    const requests = await collectCodexRolloutUsage(cursor, { waitMs: 2_000 });
    expect(requests.map(request => request.usage.providerRequestId)).toEqual(["resp_first", "resp_late"]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("reads records after a transcript line longer than one read chunk", async () => {
    const codexHome = home(), now = Date.now(), root = uuid7(now, "0a0b0c0d0e0f");
    const cursor = beginCodexRolloutUsage(codexHome, root, now);
    // An inline image or large tool output; multi-byte text straddles chunk ends.
    const big = line(now + 1, "response_item", { type: "message", content: [{ type: "output_text", text: "é".repeat(3_000_000) }] });
    writeFileSync(rolloutPath(codexHome, root, now), big + record(now + 2, root, root, "resp_after_big", usage(40, 0, 4)) + turnEnd(now + 3));
    expect((await collectCodexRolloutUsage(cursor)).map(request => request.usage.providerRequestId)).toEqual(["resp_after_big"]);
  });

  it("reads each record once across prompts, including a turn the bridge ran between them", async () => {
    const codexHome = home(), now = Date.now(), root = uuid7(now, "aa00bb11cc22");
    const file = rolloutPath(codexHome, root, now);
    writeFileSync(file, line(now, "session_meta", { id: root }));
    const cursor = beginCodexRolloutUsage(codexHome, root, now);
    appendFileSync(file, record(now + 1, root, root, "resp_first", usage(10, 0, 1)) + turnEnd(now + 2));
    expect((await collectCodexRolloutUsage(cursor)).map(request => request.usage.providerRequestId)).toEqual(["resp_first"]);
    // A bridge-started turn (ADR 0020) the daemon cancelled, then the next prompt.
    appendFileSync(file, record(now + 3, root, root, "resp_bridge_turn", usage(20, 0, 2)) + turnEnd(now + 4, "turn_aborted")
      + record(now + 5, root, root, "resp_second", usage(30, 0, 3)) + turnEnd(now + 6));
    expect((await collectCodexRolloutUsage(cursor)).map(request => request.usage.providerRequestId)).toEqual(["resp_bridge_turn", "resp_second"]);
    expect(await collectCodexRolloutUsage(cursor)).toEqual([]);
  });

  it("returns at once when the prompt left no root rollout to wait for", async () => {
    const codexHome = home(), now = Date.now(), root = uuid7(now, "eeeeee555555");
    const started = Date.now();
    expect(await collectCodexRolloutUsage(beginCodexRolloutUsage(codexHome, root, now), { waitMs: 2_000 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("keeps an invalid request as a coverage gap without replacing exact counters", async () => {
    const codexHome = home(), now = Date.now(), root = uuid7(now, "ffffff666666");
    const cursor = beginCodexRolloutUsage(codexHome, root, now);
    writeFileSync(rolloutPath(codexHome, root, now), record(now + 1, root, root, "resp_exact", usage(30, 10, 3))
      + record(now + 2, root, root, "resp_exact", null) + record(now + 3, root, root, "resp_missing", { input_tokens: 5 })
      + record(now - 60_000, root, root, "resp_before_prompt", usage(1, 0, 1)) + turnEnd(now + 4));
    const requests = await collectCodexRolloutUsage(cursor, { requestedModel: "gpt" });
    expect(requests.map(tokens)).toEqual([
      [root, "resp_exact", 20, 10, 3, 33, "exact"],
      [root, "resp_missing", undefined, undefined, undefined, undefined, "unknown"],
    ]);
    expect(requests[1]!.usage).toMatchObject({ providerSessionId: root, source: "codex_response_usage", model: null });
  });

  it("merges rollout requests with streamed ones by request identity", async () => {
    const codexHome = home(), now = Date.now(), root = uuid7(now, "123456789abc");
    const state = { ...{ usage: createPromptUsageState() }, codexRollout: beginCodexRolloutUsage(codexHome, root, now) };
    // The bridge streamed resp_a (new thread) before the rollout was read.
    accumulateUsage(state.usage, { sessionUpdate: "usage_update", used: 0, size: 0, _meta: {
      remiUsagePatch: "codex-usage-v7", remiUsageMode: "request", remiTokenUsage: {
        id: "resp_a", providerSessionId: root, providerRequestId: root ? "resp_a" : null, scope: "request_snapshot",
        source: "codex_response_usage", accuracy: "exact", model: null, inputTokens: 90, cachedInputTokens: 10,
        cacheWriteTokens: 0, outputTokens: 5, totalTokens: 105, requestedModel: "gpt", modelSource: "session_acknowledged" },
    } } as any, "gpt", "session_acknowledged", "codex");
    writeFileSync(rolloutPath(codexHome, root, now), record(now + 1, root, root, "resp_a", usage(100, 10, 5))
      + record(now + 2, root, root, "resp_b", usage(50, 0, 7)) + turnEnd(now + 3));
    await settleCodexRolloutUsage(state, "gpt", "session_acknowledged", 0);
    const units = state.usage.collector.units("codex", "gpt", { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as any, "last-request");
    const requests = units.filter(unit => unit.source === "provider_request");
    expect(requests.map(unit => [unit.providerRequestId, unit.revision, unit.inputTokens, unit.cacheReadTokens, unit.outputTokens]).sort())
      .toEqual([["resp_a", 1, 90, 10, 5], ["resp_b", 1, 50, 0, 7]]);
    expect(units.some(unit => unit.unitId.startsWith("settle:"))).toBe(false);
    expect(resolvePromptUsage(state.usage, undefined, "last-request").totalTokens).toBe(105 + 57);
    // Settling is one-shot per prompt.
    expect(state.codexRollout).toBeUndefined();
  });

  it("keeps one rollout position per pooled session across prompts", async () => {
    const codexHome = home(), now = Date.now(), root = uuid7(now, "dd33ee44ff55");
    const file = rolloutPath(codexHome, root, now);
    writeFileSync(file, line(now, "session_meta", { id: root }));
    const provider = new AcpProvider({ agentType: "codex" });
    let next = "resp_one";
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      appendFileSync(file, record(Date.now(), root, root, next, usage(40, 0, 4)) + turnEnd(Date.now()));
      return { stopReason: "end_turn" };
    } };
    const entry = { client, acpSessionId: root, codexHome, lastUsed: 0 };
    (provider as any)._ensureSession = async () => entry;
    const requests = () => (provider.getLastResponse()!.metadata!.usageUnits as any[])
      .filter(unit => unit.source === "provider_request").map(unit => unit.providerRequestId);
    for await (const _event of provider.sendStream("first")) {}
    expect(requests()).toEqual(["resp_one"]);
    // Recorded while no prompt was listening, e.g. a bridge-started turn.
    appendFileSync(file, record(Date.now(), root, root, "resp_between", usage(50, 0, 5)) + turnEnd(Date.now(), "turn_aborted"));
    next = "resp_two";
    for await (const _event of provider.sendStream("second")) {}
    expect(requests().sort()).toEqual(["resp_between", "resp_two"]);
  });

  it("reports a resumed Codex prompt's rollout requests in the final usage units", async () => {
    const codexHome = home(), now = Date.now(), created = now - 2 * DAY, root = uuid7(created, "fedcba987654");
    const file = rolloutPath(codexHome, root, created);
    writeFileSync(file, line(created, "session_meta", { id: root }) + record(created + 1, root, root, "resp_history", usage(9, 0, 1)) + turnEnd(created + 2));
    const provider = new AcpProvider({ agentType: "codex" });
    const client = { _options: { onSessionUpdate: (_event: any) => {} }, prompt: async () => {
      // Resumed thread: only the context diagnostic is streamed live.
      client._options.onSessionUpdate({ sessionId: root, update: { sessionUpdate: "usage_update", used: 18683, size: 475000,
        _meta: { remiUsagePatch: "codex-usage-v7", remiUsageMode: "request" } } });
      appendFileSync(file, record(Date.now(), root, root, "resp_resumed", usage(18678, 18432, 5)));
      // Codex persists the turn end a moment after the prompt resolves.
      setTimeout(() => appendFileSync(file, turnEnd(Date.now())), 30);
      return { stopReason: "end_turn", usage: { inputTokens: 18678, outputTokens: 5, totalTokens: 18683 } };
    } };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: root, codexHome, lastUsed: 0 });
    for await (const _event of provider.sendStream("resumed prompt")) {}
    const units = provider.getLastResponse()!.metadata!.usageUnits as any[];
    expect(units.filter(unit => unit.source === "provider_request").map(unit => [unit.providerSessionId, unit.providerRequestId,
      unit.identityKind, unit.inputTokens, unit.cacheReadTokens, unit.outputTokens, unit.accuracy, unit.provider]))
      .toEqual([[root, "resp_resumed", "request", 246, 18432, 5, "exact", "codex"]]);
  });
});
