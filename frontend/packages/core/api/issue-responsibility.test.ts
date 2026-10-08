import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { ApiContractError } from "./schema";
import { QuestionViewSchema } from "./schemas/issue-responsibility";
const question = { id: "q1", session_id: "session", workspace_id: "ws", source_issue_id: "issue", source_agent_id: "agent", source_turn_id: null, source_attempt_id: null,
  original_questions: [], original_message: "Choose?", options: [{ label: "Yes", value: "yes" }], summary: null, current_handler: { type: "member", id: "human" }, stage: "human", route_revision: 3, answer_revision: 0,
  kind: "question", status: "pending", wait_status: "detached", wait_reason: "provider exited", answer: null, history: [], actions: { allowed: ["answer"] } };
afterEach(() => vi.unstubAllGlobals());
describe("responsibility API contracts", () => {
  it("preserves original payload and detached wait state, including future display enums", () => {
    const value = QuestionViewSchema.parse({ ...question, stage: "future_stage", original_questions: [{ question: { question: "Exact?", options: [] } }] });
    expect(value.original_questions).toEqual([{ question: { question: "Exact?", options: [] } }]);
    expect(value.wait_status).toBe("detached");
    expect(value.stage).toBe("future_stage");
    expect(() => QuestionViewSchema.parse({ ...question, route_revision: "3" })).toThrow();
    expect(() => QuestionViewSchema.parse({ ...question, actions: undefined })).toThrow();
  });
  it("posts route and answer revisions against the original Q and rejects malformed success", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ question }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.test");
    const body = { expected_route_revision: 3, expected_answer_revision: 0, revise: true, reason: "New evidence", response: { answers: { "Choose?": "Yes" } } };
    await client.actOnQuestion("q1", "answer", body);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.test/api/messages/q1/question/answer");
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual(body);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ question: { ...question, id: "other" } }), { status: 200 }));
    await expect(client.getQuestion("q1")).rejects.toBeInstanceOf(ApiContractError);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(client.respondIssueDelivery("issue", "delivery", { action: "accept", revision: "v1" })).rejects.toBeInstanceOf(ApiContractError);
  });
});
