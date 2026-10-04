import { describe, expect, it } from "vitest";
import { createActivityPreferencesStore } from "./activity-preferences-store";

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("activity preferences", () => {
  it("defaults off and synchronously restores the user's persisted choice", () => {
    const storage = memoryStorage();
    const initial = createActivityPreferencesStore("user", "workspace", storage);
    expect(initial.getState().showSystemDetails).toBe(false);
    initial.getState().setShowSystemDetails(true);
    const restored = createActivityPreferencesStore("user", "workspace", storage);
    expect(restored.persist.hasHydrated()).toBe(true);
    expect(restored.getState().showSystemDetails).toBe(true);
    restored.getState().setShowSystemDetails(false);
    expect(createActivityPreferencesStore("user", "workspace", storage).getState().showSystemDetails).toBe(false);
  });

  it("isolates users and workspaces including writes from an older mounted view", () => {
    const storage = memoryStorage();
    const first = createActivityPreferencesStore("user", "one", storage);
    first.getState().setShowSystemDetails(true);
    const otherWorkspace = createActivityPreferencesStore("user", "two", storage);
    const otherUser = createActivityPreferencesStore("other", "one", storage);
    expect(otherWorkspace.getState().showSystemDetails).toBe(false);
    expect(otherUser.getState().showSystemDetails).toBe(false);
    otherWorkspace.getState().setShowSystemDetails(true);
    first.getState().setShowSystemDetails(false);
    expect(createActivityPreferencesStore("user", "two", storage).getState().showSystemDetails).toBe(true);
    expect(createActivityPreferencesStore("other", "one", storage).getState().showSystemDetails).toBe(false);
  });

  it("does not persist anonymous choices or hydrate invalid preference data", () => {
    const storage = memoryStorage();
    createActivityPreferencesStore("", "ws", storage).getState().setShowSystemDetails(true);
    expect(storage.values.size).toBe(0);
    storage.values.set("multimira_issue_activity:user:ws", JSON.stringify({ state: { showSystemDetails: "true" } }));
    expect(createActivityPreferencesStore("user", "ws", storage).getState().showSystemDetails).toBe(false);
  });

  it("keeps the default when persisted JSON is corrupted", () => {
    const storage = memoryStorage();
    storage.values.set("multimira_issue_activity:user:ws", "{corrupted");
    expect(createActivityPreferencesStore("user", "ws", storage).getState().showSystemDetails).toBe(false);
  });
});
