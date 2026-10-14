import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { ApiContractError } from "./schema";
import { QuestionViewSchema } from "./schemas/issue-responsibility";
// The Issue human stage names nobody: any active member of the source workspace acts.
const question = { id: "q1", session_id: "session", workspace_id: "ws", source_issue_id: "issue", source_agent_id: "agent", source_turn_id: null, source_attempt_id: null,
  original_questions: [], original_message: "Choose?", options: [{ label: "Yes", value: "yes" }], summary: null, current_handler: null, stage: "human", route_revision: 3, answer_revision: 0,
  route_reason: "parent:leader_missing", kind: "question", status: "pending", wait_status: "detached", wait_reason: "provider exited", answer: null,
  history: [{ type: "created", at: "now", actor: { type: "agent", id: "agent" }, route_revision: 1, handler: { type: "agent", id: "owner" } },
    { type: "escalate", at: "later", actor: { type: "agent", id: "owner" }, route_revision: 2, handler: null }], actions: { allowed: ["answer", "close"] } };
afterEach(() => vi.unstubAllGlobals());
describe("question API contracts", () => {
  it("parses the Issue human stage without a handler and an Agent stage with one", () => {
    const human = QuestionViewSchema.parse(question);
    expect(human.current_handler).toBeNull();
    expect(human.stage).toBe("human");
    expect(human.route_reason).toBe("parent:leader_missing");
    expect(human.history[1]?.handler).toBeNull();
    const agent = QuestionViewSchema.parse({ ...question, stage: "parent_owner", current_handler: { type: "agent", id: "owner" }, route_reason: null, actions: { allowed: [] } });
    expect(agent.current_handler).toEqual({ type: "agent", id: "owner" });
    expect(QuestionViewSchema.parse({ ...question, route_reason: undefined }).route_reason).toBeUndefined();
  });
  it("preserves complete question history across overlapping pages and rejects repeated cursors", async () => {
    const page = (ids: string[], nextCursor: string | null) => new Response(JSON.stringify({ questions: ids.map(id => ({ ...question, id })), nextCursor }));
    const fetch = vi.fn().mockResolvedValueOnce(page(["recent"], "recent")).mockResolvedValueOnce(page(["recent", "older"], null));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.test");
    expect((await client.listIssueQuestions("issue")).map(item => item.id)).toEqual(["recent", "older"]);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.test/api/issues/issue/questions?limit=100&before=recent");
    fetch.mockResolvedValueOnce(page(["recent"], "recent")).mockResolvedValueOnce(page(["older"], "recent"));
    await expect(client.listIssueQuestions("issue")).rejects.toBeInstanceOf(ApiContractError);
  });
  it("preserves original payload and detached wait state, including future display enums", () => {
    const value = QuestionViewSchema.parse({ ...question, stage: "future_stage", original_questions: [{ question: { question: "Exact?", options: [] } }] });
    expect(value.original_questions).toEqual([{ question: { question: "Exact?", options: [] } }]);
    expect(value.wait_status).toBe("detached");
    expect(value.stage).toBe("future_stage");
    expect(() => QuestionViewSchema.parse({ ...question, route_revision: "3" })).toThrow();
    expect(() => QuestionViewSchema.parse({ ...question, actions: undefined })).toThrow();
    expect(() => QuestionViewSchema.parse({ ...question, current_handler: { type: "member" } })).toThrow();
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
    await expect(client.actOnQuestion("q1", "close", { expected_route_revision: 3, reason: "Obsolete" })).rejects.toBeInstanceOf(ApiContractError);
  });
  it("posts every remaining question action to its own route", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ question }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.test");
    for (const action of ["escalate", "present", "continue", "close"] as const) await client.actOnQuestion("q1", action, { expected_route_revision: 3, reason: "why", summary: action === "present" ? "Summary" : undefined });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["escalate", "present", "continue", "close"].map(action => `https://api.test/api/messages/q1/question/${action}`));
    // Responsibility changes re-route a Q on the server; there is no explicit transfer.
    // @ts-expect-error transfer is not a question action.
    const transfer: Parameters<ApiClient["actOnQuestion"]>[1] = "transfer";
    expect(transfer).toBe("transfer");
  });
  it("no longer exposes formal delivery, responsibility mapping or parent-done grant calls", () => {
    const client = new ApiClient("https://api.test") as unknown as Record<string, unknown>;
    for (const removed of ["getIssueResponsibility", "listIssueResponsibilityMigration", "mapIssueResponsibility", "listIssueDeliveries",
      "submitIssueDelivery", "respondIssueDelivery", "authorizeIssueDelivery", "grantParentDone", "revokeParentDone"]) expect(client[removed]).toBeUndefined();
  });
});
