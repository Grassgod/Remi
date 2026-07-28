// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enProjects from "../../../locales/en/projects.json";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

// The wiki pane has its own suite; here we only care which branch shows.
vi.mock("./project-wiki-section", () => ({
  ProjectWikiSection: () => <div>wiki pane</div>,
}));

import { ProjectContentTabs } from "./project-content-tabs";

function renderTabs(): void {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ProjectContentTabs projectId="proj-1" issues={<div>issues board</div>} />
    </I18nProvider>,
  );
}

describe("ProjectContentTabs", () => {
  it("opens on Issues and swaps in the wiki pane when Wiki is picked", () => {
    renderTabs();

    expect(screen.getByText("issues board")).toBeInTheDocument();
    expect(screen.queryByText("wiki pane")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Wiki" }));

    expect(screen.getByText("wiki pane")).toBeInTheDocument();
    expect(screen.queryByText("issues board")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Issues" }));

    expect(screen.getByText("issues board")).toBeInTheDocument();
  });
});
