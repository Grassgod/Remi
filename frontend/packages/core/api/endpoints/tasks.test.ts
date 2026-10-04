import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { turnFixture } from "./unified.fixture";
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
