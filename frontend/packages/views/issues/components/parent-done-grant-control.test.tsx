import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Issue, MultiremiIssueParentDoneGrant } from "@multiremi/core/types";
import enIssues from "../../locales/en/issues.json";

const mutation = { mutate: vi.fn(), isPending: false };

vi.mock("@multiremi/core/issues/mutations", () => ({
  useGrantParentDone: () => mutation,
  useRevokeParentDone: () => mutation,
}));

import { ParentDoneGrantControl, ParentDoneGrantControlView } from "./parent-done-grant-control";

const effectiveGrant: MultiremiIssueParentDoneGrant = {
  granted_at: "2026-09-28T00:00:00.000Z",
  granted_by: "member-1",
  agent_id: "agent-1",
  effective: true,
  ineffective_reason: null,
};

const baseIssue = {
  id: "issue-1",
  parent_issue_id: null,
  assignee_type: "agent",
  parent_done_grant: null,
} as Issue;

function renderWithI18n(node: React.ReactNode) {
  return render(
    <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      {node}
    </I18nProvider>,
  );
}

describe("ParentDoneGrantControl", () => {
  it("is visible to members and hidden from agent identity", () => {
    const { rerender } = renderWithI18n(
      <ParentDoneGrantControl issue={baseIssue} isMember hasChildren />,
    );
    expect(screen.getByText("Allow owner agent to set this issue to done")).toBeInTheDocument();

    rerender(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <ParentDoneGrantControl issue={baseIssue} isMember={false} hasChildren />
      </I18nProvider>,
    );
    expect(screen.queryByTestId("parent-done-grant")).not.toBeInTheDocument();
    expect(document.querySelector("[data-parent-done-grant]")).toBeNull();
  });

  it("shows for a nested parent and hides an ungranted leaf", () => {
    const nestedParent = { ...baseIssue, parent_issue_id: "grandparent-1" };
    const { rerender } = renderWithI18n(
      <ParentDoneGrantControl issue={nestedParent} isMember hasChildren />,
    );
    expect(document.querySelector("[data-parent-done-grant]")).toBeInTheDocument();

    rerender(
      <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
        <ParentDoneGrantControl issue={baseIssue} isMember hasChildren={false} />
      </I18nProvider>,
    );
    expect(document.querySelector("[data-parent-done-grant]")).toBeNull();
  });

  it.each([
    ["ungranted", null, "Allow owner agent to set this issue to done", false],
    ["effective", effectiveGrant, "Owner agent may set this issue to done", true],
    [
      "ineffective",
      { ...effectiveGrant, effective: false, ineffective_reason: "assignee_changed" as const },
      "Reauthorize",
      false,
    ],
  ])("renders the %s authorization state", (state, grant, label, checked) => {
    renderWithI18n(
      <ParentDoneGrantControlView
        grant={grant}
        canAuthorize
        pending={false}
        onCheckedChange={vi.fn()}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
    if (state === "ineffective") {
      expect(screen.getByText("Authorization expired (owner changed)")).toBeInTheDocument();
    }
    expect(document.querySelector("[data-parent-done-grant]")).toHaveAttribute("data-grant-state", state);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", String(checked));
  });

  it("disables authorization and explains when the owner is not an agent", () => {
    renderWithI18n(
      <ParentDoneGrantControlView
        grant={null}
        canAuthorize={false}
        pending={false}
        onCheckedChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Assign an agent before authorizing")).toBeInTheDocument();
  });

  it("keeps an effective authorization revocable when the owner no longer resolves to an agent", () => {
    const onCheckedChange = vi.fn();
    renderWithI18n(
      <ParentDoneGrantControlView
        grant={effectiveGrant}
        canAuthorize={false}
        pending={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const toggle = screen.getByRole("switch");
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(toggle);
    expect(onCheckedChange.mock.calls[0]?.[0]).toBe(false);
  });

  it("uses the server-derived owner-not-agent reason to disable reauthorization", () => {
    renderWithI18n(
      <ParentDoneGrantControl
        issue={{
          ...baseIssue,
          parent_done_grant: {
            ...effectiveGrant,
            effective: false,
            ineffective_reason: "owner_not_agent",
          },
        }}
        isMember
        hasChildren
      />,
    );
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Assign an agent before authorizing")).toBeInTheDocument();
  });
});
