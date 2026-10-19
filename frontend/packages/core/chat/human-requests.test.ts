import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMessages } = vi.hoisted(() => ({
  listMessages: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { listMessages },
}));

import { humanRequestsOptions, parseTaskHumanRequest } from "./human-requests";

const REQUEST = {
  id: "hrq_1",
  taskId: "tsk_1",
  kind: "question",
  payload: {
    message: "Choose one",
    questions: [],
  },
  status: "pending",
  response: null,
  respondedBy: null,
  createdAt: "2026-08-25T00:00:00Z",
  respondedAt: null,
};

async function queryRequests(scope: Parameters<typeof humanRequestsOptions>[2] = { turnId: "turn_1" }) {
  const queryFn = humanRequestsOptions("ws_1", "session_1", scope).queryFn;
  if (!queryFn) throw new Error("queryFn is missing");
  return queryFn({} as never);
}

beforeEach(() => {
  listMessages.mockReset();
});

describe("humanRequestsOptions", () => {
  it("rejects malformed card payloads before a consumer renders them", () => {
    expect(parseTaskHumanRequest(REQUEST)).toEqual(REQUEST);
    expect(parseTaskHumanRequest({
      ...REQUEST,
      kind: "permission",
      payload: { options: "not-an-array" },
    })).toBeNull();
  });

  it("keeps a native question whose payload carries its decision's choice options", () => {
    // turn.decision stores the decision message's options on human_request.payload.
    const native = { ...REQUEST, payload: { ...REQUEST.payload, questions: [{ question: "Choose one", options: [{ label: "A" }] }],
      options: [{ label: "A", value: JSON.stringify({ question: "Choose one", answer: "A" }), description: "first" }] } };
    expect(parseTaskHumanRequest(native)?.payload.questions?.[0]?.question.question).toBe("Choose one");
    expect(parseTaskHumanRequest({ ...native, kind: "permission" })).toBeNull();
  });

  it("parses optional question context", async () => {
    listMessages.mockResolvedValue({
      messages: [{ id: "msg_1", task_id: "turn_1", created_at: REQUEST.createdAt, resolved_at: null, metadata: { human_request: { ...REQUEST, payload: { ...REQUEST.payload, context: { text: "Context", truncated: true } } } } }], next_cursor: null,
    });

    const requests = await queryRequests();
    expect(requests[0]?.payload.context).toEqual({ text: "Context", truncated: true });
  });

  it("keeps an old request usable when a future server sends malformed context", async () => {
    listMessages.mockResolvedValue({
      messages: [{ id: "msg_1", task_id: "turn_1", created_at: REQUEST.createdAt, resolved_at: null, metadata: { human_request: { ...REQUEST, payload: { ...REQUEST.payload, context: { text: 42 } } } } }], next_cursor: null,
    });

    const requests = await queryRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload.context).toBeUndefined();
  });

  it("lives under the Q key space so a new or resumed Q refreshes it", () => {
    expect(humanRequestsOptions("ws_1", "session_1", { turnId: "turn_1" }).queryKey.slice(0, 2)).toEqual(["question", "ws_1"]);
    expect(humanRequestsOptions("ws_1", "session_1", { open: true }).queryKey)
      .not.toEqual(humanRequestsOptions("ws_1", "session_1", { turnId: "turn_1" }).queryKey);
  });

  it("lists a turn's requests, or with open also every unanswered one of the session", async () => {
    const row = (id: string, turn: string, resolved: boolean) => ({ id, task_id: turn, created_at: REQUEST.createdAt,
      resolved_at: resolved ? REQUEST.createdAt : null, metadata: { human_request: REQUEST } });
    listMessages.mockResolvedValue({ messages: [row("q_open_old", "turn_0", false), row("q_done_old", "turn_0", true),
      row("q_done_now", "turn_1", true), { ...row("choice", "turn_1", false), metadata: {} }], next_cursor: null });
    expect((await queryRequests()).map(request => request.id)).toEqual(["q_done_now"]);
    expect((await queryRequests({ turnId: "turn_1", open: true })).map(request => request.id)).toEqual(["q_open_old", "q_done_now"]);
    expect((await queryRequests({ open: true })).map(request => request.id)).toEqual(["q_open_old"]);
    expect((await queryRequests({ open: true }))[0]?.taskId).toBe("turn_0");
  });
});
