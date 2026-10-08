import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { turnFixture } from "../unified.fixture";
import { TasksEndpoints } from "./tasks";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
afterEach(() => vi.unstubAllGlobals());
describe("turn trace and issue projection", () => {
  it("keeps the chosen historical attempt when opening a turn trace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ events: [], next_after_seq: 0, head: 0, eof: true, closed: true, source: "archive", state: "ok" })));
    await new ApiClient("https://api.example.test").getTaskTrace("attempt_1", 10, 50, "turn_1");
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/turns/turn_1/trace?after_seq=10&limit=50&attempt_id=attempt_1", expect.anything());
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
