// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../../locales/en/common.json";
import enProjects from "../../../locales/en/projects.json";
import { NavigationProvider, type NavigationAdapter } from "../../../navigation";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    projectDetail: (id: string) => `/ws/projects/${id}`,
    projectWiki: (id: string) => `/ws/projects/${id}/wiki`,
  }),
}));

// The wiki pane has its own suite; here we only care which branch shows and
// which ref it was handed.
vi.mock("./project-wiki-section", () => ({
  ProjectWikiSection: ({ selectedRef }: { selectedRef?: string }) => (
    <div>wiki pane {selectedRef ?? "(no ref)"}</div>
  ),
}));

import { ProjectContentTabs } from "./project-content-tabs";

function renderTabs(
  props: { contentTab?: "issues" | "wiki"; wikiSlug?: string } = {},
) {
  const push = vi.fn();
  const adapter: NavigationAdapter = {
    push,
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/",
    searchParams: new URLSearchParams(),
    getShareableUrl: (p) => p,
  };
  render(
    <NavigationProvider value={adapter}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ProjectContentTabs
          projectId="proj-1"
          contentTab={props.contentTab ?? "issues"}
          wikiSlug={props.wikiSlug}
          issues={<div>issues board</div>}
        />
      </I18nProvider>
    </NavigationProvider>,
  );
  return push;
}

describe("ProjectContentTabs", () => {
  it("shows the branch the route asked for, not one it tracks itself", () => {
    renderTabs();

    expect(screen.getByText("issues board")).toBeInTheDocument();
    expect(screen.queryByText(/wiki pane/)).not.toBeInTheDocument();
  });

  it("renders the wiki pane with the route's slug when the wiki tab is active", () => {
    renderTabs({ contentTab: "wiki", wikiSlug: "runbook" });

    expect(screen.getByText("wiki pane runbook")).toBeInTheDocument();
    expect(screen.queryByText("issues board")).not.toBeInTheDocument();
  });

  it("navigates instead of flipping local state when a tab is picked", () => {
    const push = renderTabs();

    fireEvent.click(screen.getByRole("tab", { name: "Wiki" }));

    expect(push).toHaveBeenCalledWith("/ws/projects/proj-1/wiki");
    // The URL owns the switch: nothing moved until the route did.
    expect(screen.getByText("issues board")).toBeInTheDocument();
  });

  it("sends the Issues tab back to the project detail route", () => {
    const push = renderTabs({ contentTab: "wiki" });

    fireEvent.click(screen.getByRole("tab", { name: "Issues" }));

    expect(push).toHaveBeenCalledWith("/ws/projects/proj-1");
  });

  it("wires each tab to a real tabpanel so the switch is announced", () => {
    renderTabs();

    const issuesTab = screen.getByRole("tab", { name: "Issues" });
    const panel = screen.getByRole("tabpanel");

    expect(issuesTab).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toContainElement(screen.getByText("issues board"));
  });

  it("wires the wiki tab to the wiki panel", () => {
    renderTabs({ contentTab: "wiki" });

    const wikiPanel = screen.getByRole("tabpanel");
    expect(screen.getByRole("tab", { name: "Wiki" })).toHaveAttribute(
      "aria-controls",
      wikiPanel.id,
    );
    expect(wikiPanel).toContainElement(screen.getByText(/wiki pane/));
  });
});
