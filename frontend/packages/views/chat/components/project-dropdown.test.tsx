import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Project } from "@multiremi/core/types";
import enChat from "../../locales/en/chat.json";
import enIssues from "../../locales/en/issues.json";
import { ProjectDropdown } from "./project-dropdown";

const projects = [
  { id: "project-a", title: "Remi", icon: null, archived_at: null },
  { id: "project-b", title: "Docs", icon: null, archived_at: null },
  { id: "archived", title: "Archived", icon: null, archived_at: "2026-09-17" },
] as Project[];

function mount(props: Partial<React.ComponentProps<typeof ProjectDropdown>> = {}) {
  const onSelect = vi.fn();
  render(
    <I18nProvider locale="en" resources={{ en: { chat: enChat, issues: enIssues } }}>
      <ProjectDropdown projects={projects} projectId={null} onSelect={onSelect} {...props} />
    </I18nProvider>,
  );
  return onSelect;
}

describe("Chat project dropdown", () => {
  it("offers pure chat by default and allows searching active projects", async () => {
    const select = mount();
    fireEvent.click(screen.getByRole("button", { name: "Project: No project · Just chat" }));
    await screen.findByRole("button", { name: "Remi" });
    expect(screen.queryByRole("button", { name: "Archived" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search projects…"), { target: { value: "rem" } });
    expect(screen.queryByRole("button", { name: "Docs" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remi" }));
    expect(select).toHaveBeenCalledWith("project-a");
    await waitFor(() => expect(screen.queryByPlaceholderText("Search projects…")).not.toBeInTheDocument());
  });

  it("shows the current binding and explicitly clears it", async () => {
    const select = mount({ projectId: "project-a" });
    fireEvent.click(screen.getByRole("button", { name: "Project: Remi" }));
    fireEvent.click(await screen.findByRole("button", { name: "No project · Just chat" }));
    expect(select).toHaveBeenCalledWith(null);
  });

  it("changes to another project without updating when the current one is selected", async () => {
    const select = mount({ projectId: "project-a" });
    fireEvent.click(screen.getByRole("button", { name: "Project: Remi" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remi" }));
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Project: Remi" }));
    fireEvent.click(await screen.findByRole("button", { name: "Docs" }));
    expect(select).toHaveBeenCalledWith("project-b");
  });

  it("keeps the binding visible while a task prevents changes", () => {
    const select = mount({ projectId: "project-a", disabled: true, busy: true });
    const trigger = screen.getByRole("button", { name: "Project: Remi" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("title", "Stop the current task before changing project.");
    fireEvent.click(trigger);
    expect(select).not.toHaveBeenCalled();
  });

  it("does not mislabel an unavailable binding as pure chat and still allows unlinking", async () => {
    const select = mount({ projectId: "missing", loadError: true });
    fireEvent.click(screen.getByRole("button", { name: "Project: Linked project unavailable" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load projects");
    fireEvent.click(screen.getByRole("button", { name: "No project · Just chat" }));
    expect(select).toHaveBeenCalledWith(null);
  });
});
