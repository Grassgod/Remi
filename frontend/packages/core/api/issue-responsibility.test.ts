import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { ApiContractError } from "./schema";
import { IssueDeliverySchema, QuestionViewSchema } from "./schemas/issue-responsibility";
const question = { id: "q1", session_id: "session", workspace_id: "ws", source_issue_id: "issue", source_agent_id: "agent", source_turn_id: null, source_attempt_id: null,
  original_questions: [], original_message: "Choose?", options: [{ label: "Yes", value: "yes" }], summary: null, current_handler: { type: "member", id: "human" }, stage: "human", route_revision: 3, answer_revision: 0,
  kind: "question", status: "pending", wait_status: "detached", wait_reason: "provider exited", answer: null, history: [], actions: { allowed: ["answer"] } };
afterEach(() => vi.unstubAllGlobals());
describe("responsibility API contracts", () => {
  it("retains unavailable review reasons, tolerates older projections and rejects malformed reasons", () => {
    const actor = { type: "member", id: "human", issueId: "parent", name: "Human" };
    const delivery = { id: "delivery", issueId: "issue", sourceSessionId: "session", summary: "Retained evidence", status: "pending", submittedBy: actor, reviewOwner: actor,
      responsibilityRevision: "v1", responseMessageId: null, createdAt: "now", respondedAt: null };
    expect(IssueDeliverySchema.parse(delivery).reviewUnavailableReason).toBeUndefined();
    for (const reason of ["review_issue_closed", "review_issue_archived", "future_unavailable_reason"]) expect(IssueDeliverySchema.parse({ ...delivery, reviewUnavailableReason: reason }).reviewUnavailableReason).toBe(reason);
    expect(() => IssueDeliverySchema.parse({ ...delivery, reviewUnavailableReason: { reason: "closed" } })).toThrow();
  });
  it("reads original migration facts and submits only explicit mappings with their fact revision", async () => {
    const item = { issueId: "root", key: "ROOT-1", title: "Root", responsibleMemberId: null, revision: "v1", assigneeType: "member", assigneeId: "old-member", createdById: "creator", unresolved: [{ issueId: "root", reason: "root_human_missing" }], candidates: [{ memberId: "human", name: "Human", source: "historical_creator", available: true }] };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ workspaceId: "ws", total: 1, rootCount: 1, legacyMemberExecutionCount: 1, nextOffset: null, items: [item] }))).mockResolvedValueOnce(new Response(JSON.stringify({ mappedIssueIds: ["root"] })));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.test");
    expect((await client.listIssueResponsibilityMigration("ws", { limit: 50, offset: 10 })).items[0]).toEqual(item);
    const body = { reason: "Human confirmed", mappings: [{ issueId: "root", memberId: "human", revision: "v1" }] };
    expect(await client.mapIssueResponsibility("ws", body)).toEqual({ mappedIssueIds: ["root"] });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.test/api/workspaces/ws/issue-responsibility-migration?limit=50&offset=10");
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual(body);
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
  it("reads older formal delivery pages and rejects a repeating cursor", async () => {
    const actor = { type: "agent", id: "owner", issueId: "issue", name: "Owner" };
    const delivery = { id: "recent", issueId: "issue", sourceSessionId: "session", summary: "Evidence", status: "returned", submittedBy: actor, reviewOwner: actor, responsibilityRevision: "v1", responseMessageId: null, responseBody: "Fix", createdAt: "now", respondedAt: "now" };
    const page = (id: string, nextCursor: string | null) => new Response(JSON.stringify({ deliveries: [{ ...delivery, id }], nextCursor }));
    const fetch = vi.fn().mockResolvedValueOnce(page("recent", "recent")).mockResolvedValueOnce(page("older", null));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.test");
    expect((await client.listIssueDeliveries("issue")).map(item => item.id)).toEqual(["recent", "older"]);
    expect(fetch.mock.calls[1]?.[0]).toBe("https://api.test/api/issues/issue/deliveries?limit=100&before=recent");
    fetch.mockResolvedValueOnce(page("recent", "recent")).mockResolvedValueOnce(page("older", "recent"));
    await expect(client.listIssueDeliveries("issue")).rejects.toBeInstanceOf(ApiContractError);
  });
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
