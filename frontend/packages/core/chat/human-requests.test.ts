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

async function queryRequests() {
  const queryFn = humanRequestsOptions("tsk_1", "session_1", "turn_1").queryFn;
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
});
