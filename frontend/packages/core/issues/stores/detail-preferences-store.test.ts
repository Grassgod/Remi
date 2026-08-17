import { beforeEach, describe, expect, it } from "vitest";
import { useIssueDetailPreferencesStore } from "./detail-preferences-store";

beforeEach(() => {
  useIssueDetailPreferencesStore.setState({ sessionSidebarOpen: true });
});

describe("useIssueDetailPreferencesStore", () => {
  it("keeps the session sidebar visible until the user changes it", () => {
    expect(useIssueDetailPreferencesStore.getState().sessionSidebarOpen).toBe(true);
  });

  it("sets and toggles the persisted session sidebar preference", () => {
    const { setSessionSidebarOpen, toggleSessionSidebar } =
      useIssueDetailPreferencesStore.getState();

    setSessionSidebarOpen(false);
    expect(useIssueDetailPreferencesStore.getState().sessionSidebarOpen).toBe(false);

    toggleSessionSidebar();
    expect(useIssueDetailPreferencesStore.getState().sessionSidebarOpen).toBe(true);
  });
});
