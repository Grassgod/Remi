// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Squad, SquadMember, SquadMemberStatus } from "@multiremi/core/types";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSquads from "../../locales/en/squads.json";

const TEST_RESOURCES = { en: { common: enCommon, squads: enSquads } };

// The pane only owns tab selection and the unsaved-changes guard; both tab
// bodies reach into queries and editors we don't want to boot here. The
// instructions stub exposes the dirty channel so the guard can be driven.
vi.mock("./tabs/members-tab", () => ({
  SquadMembersTab: () => <div>members-tab</div>,
}));
vi.mock("./tabs/instructions-tab", () => ({
  SquadInstructionsTab: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <div>
      instructions-tab
      <button type="button" onClick={() => onDirtyChange(true)}>make-dirty</button>
    </div>
  ),
}));

import { SquadOverviewPane } from "./squad-overview-pane";

const squad = { id: "squad-1", name: "Alpha" } as Squad;

function renderPane() {
  return render(
    <I18nProvider resources={TEST_RESOURCES} locale="en">
      <SquadOverviewPane
        squad={squad}
        members={[] as SquadMember[]}
        memberStatusById={new Map<string, SquadMemberStatus>()}
        isLeader={() => false}
        isArchived={() => false}
        getEntityName={() => "someone"}
        onAddMemberClick={vi.fn()}
        onSetLeader={vi.fn()}
        onRemoveMember={vi.fn()}
        onUpdateRole={vi.fn()}
        onSaveInstructions={vi.fn()}
        setLeaderPending={false}
      />
    </I18nProvider>,
  );
}

describe("SquadOverviewPane", () => {
  it("opens on the members tab", () => {
    renderPane();
    expect(screen.getByText("members-tab")).toBeTruthy();
    expect(screen.queryByText("instructions-tab")).toBeNull();
  });

  it("switches tabs when nothing is unsaved", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("button", { name: /Instructions/ }));
    expect(screen.getByText("instructions-tab")).toBeTruthy();
    expect(screen.queryByText("members-tab")).toBeNull();
  });

  it("guards the switch away from an edited instructions tab", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("button", { name: /Instructions/ }));
    await user.click(screen.getByRole("button", { name: "make-dirty" }));
    await user.click(screen.getByRole("button", { name: /Members/ }));

    // Still on instructions, with the discard prompt in the way.
    expect(screen.getByText("instructions-tab")).toBeTruthy();
    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
  });

  it("completes the switch once the user discards", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("button", { name: /Instructions/ }));
    await user.click(screen.getByRole("button", { name: "make-dirty" }));
    await user.click(screen.getByRole("button", { name: /Members/ }));
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByText("members-tab")).toBeTruthy();
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });

  it("keeps editing when the guard is dismissed", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("button", { name: /Instructions/ }));
    await user.click(screen.getByRole("button", { name: "make-dirty" }));
    await user.click(screen.getByRole("button", { name: /Members/ }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));

    expect(screen.getByText("instructions-tab")).toBeTruthy();
    expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
  });
});
