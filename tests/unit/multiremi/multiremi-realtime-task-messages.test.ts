import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { notifyBrowserTaskMessages } from "@multiremi/api/realtime.js";
import type { BrowserScopeWebSocketRegistry, BrowserWebSocketRegistry, MultiremiWebSocketClient } from "@multiremi/api/helpers.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function browserClient(userId: string): { client: MultiremiWebSocketClient; frames: string[] } {
  const frames: string[] = [];
  return {
    client: {
      data: {
        kind: "browser",
        connectedAt: new Date().toISOString(),
        workspaceId: "local",
        authenticated: true,
        userId,
        accessToken: null,
        scopeSubscriptions: [],
      },
      sendText: (frame) => frames.push(frame),
      close: () => {},
    },
    frames,
  };
}

describe("task-message realtime fan-out", () => {
  it("checks visibility once per user and agent per batch without leaking private messages", () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const agent = store.createAgent({
      name: "Private Bot", provider: "claude", workspaceId: "local", ownerId: "alice", visibility: "private",
    });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "private" });
    const messages = store.appendTaskMessages(task.id, [
      { seq: 1, type: "text", content: "secret one" },
      { seq: 2, type: "text", content: "secret two" },
    ]);
    const ownerOne = browserClient("alice");
    const ownerTwo = browserClient("alice");
    const other = browserClient("bob");
    const workspaceRegistry: BrowserWebSocketRegistry = new Map([
      ["local", new Set([ownerOne.client, ownerTwo.client, other.client])],
    ]);
    const scopeRegistry: BrowserScopeWebSocketRegistry = new Map();
    const agentRead = spyOn(store, "getAgent");
    const roleRead = spyOn(store, "getUserRoleInWorkspace");

    notifyBrowserTaskMessages(store, workspaceRegistry, scopeRegistry, task, messages);

    expect(ownerOne.frames).toHaveLength(2);
    expect(ownerTwo.frames).toHaveLength(2);
    expect(other.frames).toEqual([]);
    expect(ownerOne.frames.map((frame) => JSON.parse(frame).payload.content)).toEqual(["secret one", "secret two"]);
    expect(agentRead).toHaveBeenCalledTimes(1);
    expect(roleRead).toHaveBeenCalledTimes(1);
  });
});
