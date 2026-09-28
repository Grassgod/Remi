import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  mergeViewStatePersisted,
  type IssueViewState,
  viewStorePersistOptions,
  viewStoreSlice,
} from "./view-store";

describe("issue view store persistence", () => {
  it("defaults old snapshots to hidden sub-issues and persists explicit toggles", () => {
    const store = createStore<IssueViewState>()(viewStoreSlice);
    const current = store.getState();
    expect(mergeViewStatePersisted({ viewMode: "list" }, current).showSubIssues).toBe(false);
    store.getState().toggleShowSubIssues();
    expect(viewStorePersistOptions("test").partialize(store.getState())).toHaveProperty("showSubIssues", true);
    expect(mergeViewStatePersisted({ showSubIssues: true }, current).showSubIssues).toBe(true);
  });

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
