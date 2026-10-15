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

  it("shares local upload details across chat surfaces without persisting or crossing workspaces", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    const attachment = { id: "attachment-a", filename: "report.pdf" } as import("../types").Attachment;
    store.getState().setInputDraftAttachment("chat-1", "url-a", attachment.id);
    store.getState().setLocalAttachmentDetail(attachment);
    expect(store.getState().localAttachmentDetails[attachment.id]).toBe(attachment);
    expect(createChatStore({ storage }).getState().localAttachmentDetails).toEqual({});
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().localAttachmentDetails).toEqual({});
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

describe("new chat project selection", () => {
  it("preserves the draft selection across surfaces and isolates workspaces", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    expect(store.getState().draftProjectId).toBeNull();
    store.getState().setDraftProjectId("project-a");
    expect(createChatStore({ storage }).getState().draftProjectId).toBe("project-a");
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().draftProjectId).toBeNull();
    store.getState().setDraftProjectId("project-b");
    workspace.slug = "workspace-a";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().draftProjectId).toBe("project-a");
    store.getState().setDraftProjectId(null);
    expect(createChatStore({ storage }).getState().draftProjectId).toBeNull();
  });
});

describe("follow-up preference", () => {
  it("defaults to steer and persists the choice globally across workspaces", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    expect(store.getState().followUpMode).toBe("steer");
    store.getState().setFollowUpMode("queue");
    expect(storage.getItem("multimira:chat:followUpMode")).toBe("queue");
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().followUpMode).toBe("queue");
    expect(createChatStore({ storage }).getState().followUpMode).toBe("queue");
  });

  it("ignores an unknown stored value", () => {
    const storage = memoryStorage();
    storage.setItem("multimira:chat:followUpMode", "interrupt");
    expect(createChatStore({ storage }).getState().followUpMode).toBe("steer");
  });
});

describe("queued message edit", () => {
  const edit = { itemId: "qmsg_1", revision: 3, body_md: "Queued [a](/api/attachments/att_q/content)", attachments: { "/api/attachments/att_q/content": "att_q" } };

  it("loads the row into the draft, stashes the draft and restores it", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    store.getState().setInputDraft("chat-1", "my draft");
    store.getState().setInputDraftAttachment("chat-1", "url-d", "att_d");
    store.getState().startQueueEdit("chat-1", edit);
    expect(store.getState().inputDrafts["chat-1"]).toBe(edit.body_md);
    expect(store.getState().inputDraftAttachments["chat-1"]).toEqual(edit.attachments);
    expect(store.getState().queueEdit["chat-1"]).toEqual({ itemId: "qmsg_1", revision: 3, stash: { draft: "my draft", attachments: { "url-d": "att_d" } } });
    // A reload keeps the edit and its stash.
    expect(createChatStore({ storage }).getState().queueEdit["chat-1"]?.stash.draft).toBe("my draft");
    store.getState().finishQueueEdit("chat-1", "restore");
    expect(store.getState().queueEdit).toEqual({});
    expect(store.getState().inputDrafts["chat-1"]).toBe("my draft");
    expect(store.getState().inputDraftAttachments["chat-1"]).toEqual({ "url-d": "att_d" });
    expect(storage.getItem("multimira:chat:queueEdit:workspace-a")).toBeNull();
  });

  it("keeps the first stash when switching to another queued message", () => {
    const store = createChatStore({ storage: memoryStorage() });
    store.getState().setInputDraft("chat-1", "my draft");
    store.getState().startQueueEdit("chat-1", edit);
    store.getState().startQueueEdit("chat-1", { itemId: "qmsg_2", revision: 1, body_md: "Second", attachments: {} });
    expect(store.getState().queueEdit["chat-1"]).toMatchObject({ itemId: "qmsg_2", stash: { draft: "my draft" } });
    expect(store.getState().inputDraftAttachments["chat-1"]).toBeUndefined();
  });

  it("keeps the edited text, followed by the stashed draft, when the row can no longer be saved", () => {
    const store = createChatStore({ storage: memoryStorage() });
    store.getState().setInputDraft("chat-1", "my draft");
    store.getState().startQueueEdit("chat-1", edit);
    store.getState().setInputDraft("chat-1", "edited text");
    store.getState().finishQueueEdit("chat-1", "keep");
    expect(store.getState().queueEdit).toEqual({});
    expect(store.getState().inputDrafts["chat-1"]).toBe("edited text\n\nmy draft");
    expect(store.getState().inputDraftAttachments["chat-1"]).toEqual(edit.attachments);
  });

  it("keeps the submitted text rather than the debounced stored draft", () => {
    const store = createChatStore({ storage: memoryStorage() });
    store.getState().setInputDraft("chat-1", "my draft");
    store.getState().startQueueEdit("chat-1", edit);
    store.getState().setInputDraft("chat-1", "edited te");
    store.getState().finishQueueEdit("chat-1", "keep", "edited text, last keystrokes");
    expect(store.getState().inputDrafts["chat-1"]).toBe("edited text, last keystrokes\n\nmy draft");
  });

  it("isolates edits per workspace and drops malformed stored entries", () => {
    const storage = memoryStorage();
    storage.setItem("multimira:chat:queueEdit:workspace-b", JSON.stringify({ "chat-9": { itemId: "q", revision: "1" } }));
    const store = createChatStore({ storage });
    store.getState().startQueueEdit("chat-1", edit);
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().queueEdit).toEqual({});
    workspace.slug = "workspace-a";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().queueEdit["chat-1"]?.itemId).toBe("qmsg_1");
  });
});

describe("queue outbox", () => {
  const item = { client_id: "client-1", body_md: "Next", attachments: [], created_at: "2026-10-15T00:00:00Z", state: "sending" as const };

  it("replaces by client id, removes, and reads an in-flight item back as unconfirmed after a reload", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    store.getState().putQueueOutboxItem("chat-1", item);
    store.getState().putQueueOutboxItem("chat-1", { ...item, body_md: "Next (again)" });
    expect(store.getState().queueOutbox["chat-1"]).toEqual([{ ...item, body_md: "Next (again)" }]);
    expect(createChatStore({ storage }).getState().queueOutbox["chat-1"]).toEqual([{ ...item, body_md: "Next (again)", state: "unconfirmed" }]);
    store.getState().removeQueueOutboxItem("chat-1", "client-1");
    expect(store.getState().queueOutbox).toEqual({});
    expect(storage.getItem("multimira:chat:queueOutbox:workspace-a")).toBeNull();
  });

  it("removes an item from the workspace an enqueue started in after a switch", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    store.getState().putQueueOutboxItem("chat-1", item);
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    store.getState().putQueueOutboxItem("chat-9", { ...item, client_id: "client-b" });
    store.getState().removeQueueOutboxItem("chat-1", "client-1", "workspace-a");
    expect(store.getState().queueOutbox["chat-9"]).toHaveLength(1);
    expect(storage.getItem("multimira:chat:queueOutbox:workspace-a")).toBeNull();
    workspace.slug = "workspace-a";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().queueOutbox).toEqual({});
  });

  it("restores text to the draft, or to the stash while an edit is open", () => {
    const store = createChatStore({ storage: memoryStorage() });
    store.getState().setInputDraft("chat-1", "draft");
    store.getState().restoreToDraft("chat-1", "Refused message", { "/api/attachments/a/content": "a" });
    expect(store.getState().inputDrafts["chat-1"]).toBe("draft\n\nRefused message");
    expect(store.getState().inputDraftAttachments["chat-1"]).toEqual({ "/api/attachments/a/content": "a" });
    store.getState().startQueueEdit("chat-1", { itemId: "qmsg_1", revision: 1, body_md: "Queued", attachments: {} });
    store.getState().restoreToDraft("chat-1", "Another", {});
    expect(store.getState().inputDrafts["chat-1"]).toBe("Queued");
    expect(store.getState().queueEdit["chat-1"]?.stash.draft).toBe("draft\n\nRefused message\n\nAnother");
  });

  it("drops the queue state of a deleted session", () => {
    const storage = memoryStorage();
    const store = createChatStore({ storage });
    store.getState().putQueueOutboxItem("chat-1", item);
    store.getState().putQueueOutboxItem("chat-2", { ...item, client_id: "client-2" });
    store.getState().startQueueEdit("chat-1", { itemId: "qmsg_1", revision: 1, body_md: "x", attachments: {} });
    store.getState().clearQueueState("chat-1");
    expect(store.getState().queueEdit).toEqual({});
    expect(Object.keys(store.getState().queueOutbox)).toEqual(["chat-2"]);
    expect(createChatStore({ storage }).getState().queueEdit).toEqual({});
  });

  it("isolates the outbox per workspace", () => {
    const store = createChatStore({ storage: memoryStorage() });
    store.getState().putQueueOutboxItem("chat-1", item);
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().queueOutbox).toEqual({});
  });
});

describe("subagent panel (PR 5 §6.8)", () => {
  const target = { sessionId: "chat-1", attemptId: "att-1", turnId: "turn-1", live: true, path: ["sa:1"] };

  it("opens, moves along the path and closes, persisting nothing", () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, "setItem");
    const store = createChatStore({ storage });
    store.getState().openSubagentPanel(target);
    expect(store.getState().subagentPanel).toEqual(target);
    store.getState().setSubagentPath(["sa:1", "sa:2"]);
    expect(store.getState().subagentPanel?.path).toEqual(["sa:1", "sa:2"]);
    store.getState().setSubagentPath([]);
    expect(store.getState().subagentPanel).toMatchObject({ attemptId: "att-1", path: [] });
    store.getState().closeSubagentPanel();
    expect(store.getState().subagentPanel).toBeNull();
    // Moving a closed panel opens nothing.
    store.getState().setSubagentPath(["sa:1"]);
    expect(store.getState().subagentPanel).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(createChatStore({ storage }).getState().subagentPanel).toBeNull();
  });

  it("drops the panel and the reveal request on close and on a chat switch, keeping nonces increasing", () => {
    const store = createChatStore({ storage: memoryStorage() });
    store.getState().setActiveSession("chat-1");
    store.getState().openSubagentPanel(target);
    store.getState().revealSubagent("att-1", "sa:1");
    store.getState().closeSubagentPanel();
    expect(store.getState().subagentPanel).toBeNull();
    expect(store.getState().subagentReveal).toBeNull();
    // A cleared request never lets the next one reuse an older nonce.
    store.getState().revealSubagent("att-1", "sa:1");
    expect(store.getState().subagentReveal?.nonce).toBe(2);
    store.getState().openSubagentPanel(target);
    store.getState().setActiveSession("chat-1");
    expect(store.getState().subagentPanel).toEqual(target);
    store.getState().setActiveSession("chat-2");
    expect(store.getState().subagentPanel).toBeNull();
    expect(store.getState().subagentReveal).toBeNull();
  });

  it("bumps the reveal nonce per request and forgets the panel on a workspace switch", () => {
    const store = createChatStore({ storage: memoryStorage() });
    store.getState().revealSubagent("att-1", "sa:1");
    store.getState().revealSubagent("att-1", "sa:1");
    expect(store.getState().subagentReveal).toEqual({ attemptId: "att-1", itemId: "sa:1", nonce: 2 });
    store.getState().openSubagentPanel(target);
    workspace.slug = "workspace-b";
    workspace.rehydrate.forEach(callback => callback());
    expect(store.getState().subagentPanel).toBeNull();
    expect(store.getState().subagentReveal).toBeNull();
  });
});
