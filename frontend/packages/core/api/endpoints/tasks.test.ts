import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { turnFixture } from "../unified.fixture";
import { TasksEndpoints } from "./tasks";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
afterEach(() => vi.unstubAllGlobals());
describe("turn trace and issue projection", () => {
  it("keeps the chosen historical attempt when opening a turn trace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ view: "turn", format: "v2", turn: null, items: [], next_item_cursor: null, head: 0, closed: true, source: "daemon", state: "ok" })));
    await new ApiClient("https://api.example.test").getTaskTrace("attempt_1", { itemCursor: 10, turnId: "turn_1" });
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/turns/turn_1/trace?view=turn&item_cursor=10&attempt_id=attempt_1", expect.anything());
  });
  it("reads a turn page and drops only the items that fail the contract", async () => {
    const item = { id: "msg:1", parent_id: null, status: "completed", started_at: "2026-10-15T00:00:00.000Z", completed_at: null, type: "agent_message", text: "hi", phase: "final" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ view: "turn", format: "v2", turn: null,
      items: [item, { ...item, id: "x", type: "future_item" }, { ...item, id: "" }], next_item_cursor: 3, head: 9, closed: false, state: "ok" })));
    const page = await new ApiClient("https://api.example.test").getTaskTrace("attempt_1");
    expect(page.items).toEqual([item]);
    expect(page).toMatchObject({ next_item_cursor: 3, head: 9, closed: false, format: "v2" });
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/turns/attempt_1/trace?view=turn&item_cursor=0", expect.anything());
  });
  it("defaults the empty page of an unreachable read and rejects a body without a state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ state: "unreachable", source: "daemon", runtime_name: "mac" }))
      .mockResolvedValueOnce(Response.json({ events: [], eof: true })));
    const client = new ApiClient("https://api.example.test");
    await expect(client.getTaskTrace("attempt_1")).resolves.toMatchObject({ state: "unreachable", turn: null, items: [], head: 0, next_item_cursor: null, runtime_name: "mac" });
    await expect(client.getTaskTrace("attempt_1")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("loads all issue turn pages without fetching details for every row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ turns: [turnFixture({ issue_id: "iss_1" })], next_cursor: "opaque+next" })).mockResolvedValueOnce(Response.json({ turns: [turnFixture({ id: "turn_2", current_attempt_id: "attempt_4" })], next_cursor: null })));
    const tasks = await new ApiClient("https://api.example.test").listTasksByIssue("MUL-509");
    expect(tasks.map(t => [t.id, t.turn_id])).toEqual([["attempt_2", "turn_1"], ["attempt_4", "turn_2"]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://api.example.test/api/turns?issue=MUL-509&cursor=opaque%2Bnext&limit=100", expect.anything());
  });
});

const turn = turnFixture({ status: "completed" });
const attempt = { id: "attempt_1", turn_id: turn.id, attempt_no: 1, status: "failed", runtime_id: "runtime",
  provider: "codex", execution_model: "prior-model", execution_thinking_level: "high", fallback_switched: true,
  switch_reason: "fallback", usage: [{ totalTokens: 40 }], started_at: null, ended_at: null, error: "Prior attempt failed" };
function endpoint(response: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
  return new TasksEndpoints(new HttpClient("https://example.test"));
}
it("maps a chosen historical attempt to the transcript view model", async () => {
  await expect(endpoint({ turn, attempts: [attempt] }).getTask(attempt.id, turn.id)).resolves.toMatchObject({
    id: attempt.id, turn_id: turn.id, agent_id: turn.agent_id, runtime_id: "runtime", issue_id: "", status: "failed", error: attempt.error,
    usage: attempt.usage, executionModel: "prior-model", executionThinkingLevel: "high", fallbackSwitched: true, switchReason: "fallback",
  });
  expect(fetch).toHaveBeenCalledWith("https://example.test/api/turns/turn_1?attempts=true", expect.anything());
});
it.each([{ turn: { ...turn, status: 4 } }, { turn: { ...turn, agent_id: undefined } }, { turn: null },
  { turn, attempts: [{ ...attempt, id: "other" }] }, { turn: { ...turn, id: "other" }, attempts: [attempt] }])("rejects malformed or mismatched turn detail", async response => {
  await expect(endpoint(response).getTask(attempt.id, turn.id)).rejects.toBeInstanceOf(ApiContractError);
});
