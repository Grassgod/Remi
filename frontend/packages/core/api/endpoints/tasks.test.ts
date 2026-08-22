import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../client";
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
