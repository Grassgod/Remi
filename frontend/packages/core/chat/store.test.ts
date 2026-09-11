import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "../types";
import { createChatStore } from "./store";

const workspace = vi.hoisted(() => ({ slug: "workspace-a", rehydrate: [] as Array<() => void> }));
vi.mock("../platform/workspace-storage", () => ({
  getCurrentSlug: () => workspace.slug,
  registerForWorkspaceRehydration: (callback: () => void) => workspace.rehydrate.push(callback),
}));

function memoryStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

beforeEach(() => {
  workspace.slug = "workspace-a";
  workspace.rehydrate = [];
});

describe("chat attachment drafts", () => {
  it("restores uploaded attachment IDs with text after the chat surface remounts", () => {
    const storage = memoryStorage();
    const first = createChatStore({ storage });
    first.getState().setInputDraft("chat-1", "[report](https://files.test/report)");
    first.getState().setInputDraftAttachment("chat-1", "https://files.test/report", "attachment-1");
    const restored = createChatStore({ storage });
    expect(restored.getState().inputDrafts["chat-1"]).toContain("report");
    expect(restored.getState().inputDraftAttachments["chat-1"]).toEqual({ "https://files.test/report": "attachment-1" });
  });

  it("isolates and rehydrates attachment bindings per workspace and per conversation", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    store.getState().setInputDraftAttachment("chat-1", "url-a", "attachment-a");
    store.getState().setInputDraftAttachment("chat-2", "url-b", "attachment-b");
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().inputDraftAttachments).toEqual({});
    store.getState().setInputDraftAttachment("chat-1", "url-c", "attachment-c");
    workspace.slug = "workspace-a";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().inputDraftAttachments).toEqual({ "chat-1": { "url-a": "attachment-a" }, "chat-2": { "url-b": "attachment-b" } });
  });

  it("clears attachment-only drafts after send/delete while preserving other conversations", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    store.getState().setInputDraftAttachment("chat-1", "url-a", "attachment-a");
    store.getState().setInputDraftAttachment("chat-2", "url-b", "attachment-b");
    store.getState().clearInputDraft("chat-1");
    expect(store.getState().inputDraftAttachments).toEqual({ "chat-2": { "url-b": "attachment-b" } });
    expect(createChatStore({ storage }).getState().inputDraftAttachments).toEqual({ "chat-2": { "url-b": "attachment-b" } });
    store.getState().clearInputDraft("chat-2");
    expect(storage.getItem("multimira:chat:draftAttachments:workspace-a")).toBeNull();
  });

  it("removes uploaded references without deleting text when explicitly requested", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    store.getState().setInputDraft("chat-1", "keep this text");
    store.getState().setInputDraftAttachment("chat-1", "url-a", "attachment-a");
    store.getState().clearInputDraftAttachments("chat-1");
    expect(store.getState().inputDrafts["chat-1"]).toBe("keep this text");
    expect(store.getState().inputDraftAttachments).toEqual({});
  });

  it("discards malformed persisted attachment IDs before they can enter a send command", () => {
    const storage = memoryStorage();
    storage.setItem("multimira:chat:draftAttachments:workspace-a", JSON.stringify({
      "chat-1": { good: "attachment-1", bad: 123 }, "chat-2": ["attachment-2"],
    }));
    expect(createChatStore({ storage }).getState().inputDraftAttachments).toEqual({ "chat-1": { good: "attachment-1" } });
  });
});
