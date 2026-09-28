import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { InboxItem } from "@multiremi/core/types";
import { describe, expect, it, vi } from "vitest";
import enInbox from "../../locales/en/inbox.json";
import { InboxListItem } from "./inbox-list-item";

vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => <span data-testid="avatar" /> }));
vi.mock("../../issues/components", () => ({
  StatusIcon: () => null,
  PriorityIcon: () => null,
}));
vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: (_type: string, id: string) => id }),
}));

function run(id: string, branch: string, seconds: number, createdAt: string): InboxItem {
  return {
    id,
    workspace_id: "workspace-1",
    recipient_type: "member",
    recipient_id: "member-1",
    actor_type: "system",
    actor_id: null,
    type: "autopilot_run_completed",
    severity: "info",
    issue_id: null,
    title: "Server fallback",
    body: "Server fallback body",
    issue_status: null,
    read: false,
    archived: false,
    created_at: createdAt,
    details: {
      autopilot_id: "autopilot-1",
      autopilot_title: "Atlas",
      duration_seconds: seconds,
      trigger: "scm_event",
      trigger_object: {
        event_type: "default_branch.updated",
        repository_id: "repo-1",
        repository_name: "Remi",
        change_number: null,
        change_title: null,
        target_branch: branch,
        source_revision: null,
        occurred_at: createdAt,
        wiki_build: false,
      },
      outcome: {
        kind: "no_change",
        headline: null,
        text: null,
        links: [],
        counts: null,
        risks: [],
        action: { kind: "none", text: null },
      },
    },
  };
}

function parentNotification(id: string, issueKey: string): InboxItem {
  return {
    ...run(id, "main", 5, "2026-08-27T10:00:00Z"),
    type: "comment_created",
    issue_id: id,
    issue_parent_id: "parent-1",
    issue_parent_key: "MUL-1",
    issue_parent_title: "Parent issue",
    title: `Child ${issueKey}`,
    issue_status: "todo",
    details: null,
  };
}

function expectVisibilityReservedArchive(button: HTMLElement, hoverClass: string) {
  expect(button).toHaveClass("invisible", "inline-flex", hoverClass);
  expect(button).not.toHaveClass("hidden");
  expect(button).not.toHaveClass(hoverClass.replace(":visible", ":inline-flex"));
}

describe("InboxListItem merged autopilot runs", () => {
  it("expands a collapsed row to show every trigger object and duration", () => {
    const latest = run("run-latest", "main", 5, "2026-08-27T10:00:00Z");
    const earlier = run("run-earlier", "release", 8, "2026-08-27T09:00:00Z");
    const onItemClick = vi.fn();
    const onArchive = vi.fn();
    render(
      <I18nProvider locale="en" resources={{ en: { inbox: enInbox } }}>
        <InboxListItem
          item={latest}
          groupedItems={[latest, earlier]}
          isSelected={false}
          onClick={vi.fn()}
          onItemClick={onItemClick}
          onArchive={onArchive}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Atlas · Remi@main · 2 runs")).toBeInTheDocument();
    expect(screen.getByText("No structured outputs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand runs" }));

    expect(screen.getAllByText("Atlas · Remi@main").length).toBeGreaterThan(0);
    expect(screen.getByText("Atlas · Remi@release")).toBeInTheDocument();
    expect(screen.getByText(/Took 8s/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Atlas · Remi@release"));
    expect(onItemClick).toHaveBeenCalledWith(earlier);

    const archive = screen.getByTitle("Archive");
    expectVisibilityReservedArchive(archive, "group-hover/row:visible");
    fireEvent.click(archive);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith([latest, earlier]);
  });
});

describe("InboxListItem parent notification groups", () => {
  it("reserves archive action space and offers only per-item archive actions", async () => {
    const first = parentNotification("child-1", "MUL-2");
    const second = parentNotification("child-2", "MUL-3");
    const onArchive = vi.fn();
    render(
      <I18nProvider locale="en" resources={{ en: { inbox: enInbox } }}>
        <InboxListItem
          item={first}
          groupedItems={[first, second]}
          isSelected={false}
          onClick={vi.fn()}
          onArchive={onArchive}
        />
      </I18nProvider>,
    );

    const expand = screen.getByRole("button", { name: "Expand notifications" });
    expect(expand).toHaveClass("h-5", "w-5");
    expect(screen.queryByTitle("Archive")).not.toBeInTheDocument();

    await userEvent.click(expand);
    const archiveButtons = screen.getAllByTitle("Archive");
    expect(archiveButtons).toHaveLength(2);
    for (const archive of archiveButtons) {
      expectVisibilityReservedArchive(archive, "group-hover/child:visible");
    }
    await userEvent.click(archiveButtons[0]!);
    expect(onArchive).toHaveBeenCalledWith([first]);
  });

  it("uses Enter on the focused expand button without opening the group", async () => {
    const first = parentNotification("child-1", "MUL-2");
    const second = parentNotification("child-2", "MUL-3");
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en" resources={{ en: { inbox: enInbox } }}>
        <InboxListItem
          item={first}
          groupedItems={[first, second]}
          isSelected={false}
          onClick={onClick}
          onArchive={vi.fn()}
        />
      </I18nProvider>,
    );

    const expand = screen.getByRole("button", { name: "Expand notifications" });
    expand.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: "Collapse notifications" })).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });
});
