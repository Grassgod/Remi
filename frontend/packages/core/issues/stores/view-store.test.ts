import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  mergeViewStatePersisted,
  type IssueViewState,
  viewStorePersistOptions,
  viewStoreSlice,
} from "./view-store";

describe("issue view store persistence", () => {
  it("keeps the archived pseudo-column hidden across persisted snapshots", () => {
    const store = createStore<IssueViewState>()(viewStoreSlice);
    store.getState().showArchivedColumn();
    expect(store.getState().archivedColumnVisible).toBe(true);

    const persisted = viewStorePersistOptions("test").partialize(store.getState());
    expect(persisted).not.toHaveProperty("archivedColumnVisible");

    const current = createStore<IssueViewState>()(viewStoreSlice).getState();
    const merged = mergeViewStatePersisted(
      { archivedColumnVisible: true },
      current,
    );
    expect(merged.archivedColumnVisible).toBe(false);
  });
});
