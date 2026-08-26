import { beforeEach, describe, expect, it, vi } from "vitest";

const { listTaskHumanRequests } = vi.hoisted(() => ({
  listTaskHumanRequests: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { listTaskHumanRequests },
}));

import { humanRequestsOptions } from "./human-requests";

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
  const queryFn = humanRequestsOptions("tsk_1").queryFn;
  if (!queryFn) throw new Error("queryFn is missing");
  return queryFn({} as never);
}

beforeEach(() => {
  listTaskHumanRequests.mockReset();
});

describe("humanRequestsOptions", () => {
  it("parses optional question context", async () => {
    listTaskHumanRequests.mockResolvedValue({
      requests: [{ ...REQUEST, payload: { ...REQUEST.payload, context: { text: "Context", truncated: true } } }],
    });

    const requests = await queryRequests();
    expect(requests[0]?.payload.context).toEqual({ text: "Context", truncated: true });
  });

  it("keeps an old request usable when a future server sends malformed context", async () => {
    listTaskHumanRequests.mockResolvedValue({
      requests: [{ ...REQUEST, payload: { ...REQUEST.payload, context: { text: 42 } } }],
    });

    const requests = await queryRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.payload.context).toBeUndefined();
  });
});
