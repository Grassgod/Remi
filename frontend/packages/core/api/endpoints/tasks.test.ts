import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
import { TasksEndpoints } from "./tasks";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

const message = {
  id: "steer-1",
  taskId: "task-1",
  authorType: "user",
  authorId: "user-1",
  kind: "steer" as const,
  content: "Use Chinese",
  createdAt: "2026-08-22T00:00:00Z",
  consumedAt: null,
};

describe("TasksEndpoints steer", () => {
  it("posts a steer directive using the task endpoint contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("https://api.example.test");
    await expect(client.steerTask("task/1", { content: "Use Chinese" })).resolves.toEqual({
      message,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/tasks/task%2F1/steer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "Use Chinese" }),
      }),
    );
  });

  it("rejects a malformed successful mutation response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: { id: "missing-fields" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const client = new ApiClient("https://api.example.test");
    await expect(client.steerTask("task-1", { force_answer: true })).rejects.toBeInstanceOf(
      ApiContractError,
    );
  });

  it("falls back to an empty audit list when a list response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messages: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const client = new ApiClient("https://api.example.test");
    await expect(client.listTaskSteers("task-1")).resolves.toEqual({ messages: [] });
  });
});

const task = { id: "task", agentId: "agent", runtimeId: "runtime", issueId: null,
  status: "completed", priority: 0, createdAt: "2026-10-05T00:00:00Z", dispatchedAt: null,
  startedAt: null, completedAt: null, result: "Complete final answer", error: null, agent: { name: "Agent" },
  usage: [{ totalTokens: 40 }] };
function endpoint(response: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })));
  return new TasksEndpoints(new HttpClient("https://example.test"));
}
it("maps native task detail to the transcript view model", async () => {
  await expect(endpoint({ task }).getTask("task")).resolves.toMatchObject({
    id: "task", agent_id: "agent", runtime_id: "runtime", issue_id: "", status: "completed", agent_name: "Agent", usage: [{ totalTokens: 40 }],
  });
});
it.each([{ task: { ...task, status: 4 } }, { task: { ...task, agentId: undefined } }, { task: null }])("rejects malformed task detail", async response => {
  await expect(endpoint(response).getTask("task")).rejects.toBeInstanceOf(ApiContractError);
});
