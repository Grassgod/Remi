import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../api/http";
import { ChatEndpoints } from "../api/endpoints/chat";
import { turnFixture } from "../api/unified.fixture";
import type { ChatPendingTask } from "../types";

const endpoints = vi.hoisted(() => ({ current: null as null | { getPendingChatTask: (id: string) => Promise<ChatPendingTask>; getChatTurnPendingTask: (id: string) => Promise<ChatPendingTask> } }));
vi.mock("../api", () => ({ api: {
  getPendingChatTask: (id: string) => endpoints.current!.getPendingChatTask(id),
  getChatTurnPendingTask: (id: string) => endpoints.current!.getChatTurnPendingTask(id),
} }));
import { chatKeys, pendingChatTaskOptions } from "./queries";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A server whose one chat turn is in `state`. The pending task read lists the
 * turns once per active status; `order` decides when each list read answers
 * and lets the turn change status between them, as two concurrent requests
 * can see it.
 */
function server(initial: string, turn: Record<string, unknown> = {}) {
  const fixture = { id: "turn_1", current_attempt_id: "attempt_2", ...turn };
  const state = { status: initial, missing: false };
  const answer = (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/turns/")) {
      return state.missing ? response({ error: "turn not found" }, 404) : response({ turn: turnFixture({ ...fixture, status: state.status }) });
    }
    const status = parsed.searchParams.get("status");
    return response({ turns: status === state.status ? [turnFixture({ ...fixture, status: state.status })] : [], next_cursor: null });
  };
  const gates = new Map<string, Promise<void>>();
  const opened = new Map<string, () => void>();
  for (const status of ["pending", "running", "awaiting_human"]) gates.set(status, new Promise(resolve => opened.set(status, resolve)));
  const fetchMock = vi.fn(async (url: string) => {
    const status = new URL(url).searchParams.get("status");
    if (status) await gates.get(status);
    return answer(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  endpoints.current = new ChatEndpoints(new HttpClient("https://api.example.test"));
  /** Answer the list read for `status` now, after `before` changed the turn. */
  const release = async (status: string, before?: () => void) => {
    before?.();
    opened.get(status)!();
    // Let that read's answer be computed before anything else changes.
    for (let n = 0; n < 5; n++) await Promise.resolve();
  };
  return { state, release, fetchMock };
}

function cached(task: ChatPendingTask): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(chatKeys.pendingTask("chat_1"), task);
  return client;
}

afterEach(() => { vi.unstubAllGlobals(); endpoints.current = null; });

describe("the pending task read across a status change", () => {
  it("keeps a just claimed turn that the three status reads all missed (pending → running between them)", async () => {
    // task:queued gave the cache the attempt id; a first attempt shares its turn's id.
    const client = cached({ task_id: "tsk_1", status: "queued", supports_queue: true });
    const { state, release } = server("pending", { id: "tsk_1", current_attempt_id: "tsk_1" });
    const read = client.fetchQuery({ ...pendingChatTaskOptions("chat_1"), staleTime: 0 });
    await release("running");
    await release("pending", () => { state.status = "running"; });
    await release("awaiting_human");
    await expect(read).resolves.toMatchObject({ task_id: "tsk_1", turn_id: "tsk_1", status: "running" });
  });

  it("keeps a running turn whose reads crossed an agent question (running ↔ awaiting_human)", async () => {
    const client = cached({ task_id: "attempt_2", turn_id: "turn_1", status: "running", supports_queue: true });
    const { state, release, fetchMock } = server("running");
    const read = client.fetchQuery({ ...pendingChatTaskOptions("chat_1"), staleTime: 0 });
    await release("pending");
    await release("running", () => { state.status = "awaiting_human"; });
    await release("awaiting_human", () => { state.status = "running"; });
    await expect(read).resolves.toMatchObject({ task_id: "attempt_2", turn_id: "turn_1", status: "running" });
    expect(fetchMock).toHaveBeenLastCalledWith("https://api.example.test/api/turns/turn_1", expect.anything());
  });

  it("clears a turn that ended, and one whose turn is gone", async () => {
    for (const ending of ["completed", "missing"] as const) {
      const client = cached({ task_id: "attempt_2", turn_id: "turn_1", status: "running", supports_queue: true });
      const { state, release } = server("completed");
      state.missing = ending === "missing";
      const read = client.fetchQuery({ ...pendingChatTaskOptions("chat_1"), staleTime: 0 });
      for (const status of ["pending", "running", "awaiting_human"]) await release(status);
      await expect(read, ending).resolves.toEqual({ supports_queue: true });
    }
  });

  it("does not read a single turn when the cache held none or only a send's optimistic seed", async () => {
    for (const held of [{ supports_queue: true }, { task_id: "optimistic-c1", status: "queued" }] as ChatPendingTask[]) {
      const client = cached(held);
      const { release, fetchMock } = server("completed");
      const read = client.fetchQuery({ ...pendingChatTaskOptions("chat_1"), staleTime: 0 });
      for (const status of ["pending", "running", "awaiting_human"]) await release(status);
      await expect(read).resolves.toEqual({ supports_queue: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  });
});
