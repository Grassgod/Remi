// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enCommon from "../../locales/en/common.json";
import enProjects from "../../locales/en/projects.json";

const state = vi.hoisted(() => ({
  devices: [] as Array<{
    project_id: string;
    workspace_id: string;
    daemon_id: string;
    display_name: string;
    online: boolean;
    providers: string[];
    created_at: string;
    created_by: string | null;
  }>,
  warning: null as string | null,
  replaceDevices: vi.fn<(daemonIds: string[]) => Promise<unknown>>(),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) =>
    options.queryKey.includes("devices")
      ? {
          data: {
            devices: state.devices,
            total: state.devices.length,
            warning: state.warning,
          },
          isLoading: false,
        }
      : { data: [], isLoading: false },
}));

vi.mock("@multiremi/core/projects", () => ({
  projectDevicesOptions: () => ({ queryKey: ["project", "devices"] }),
  useReplaceProjectDevices: () => ({ mutateAsync: state.replaceDevices, isPending: false }),
}));

vi.mock("@multiremi/core/runtimes/queries", () => ({
  runtimeListOptions: () => ({ queryKey: ["runtimes"] }),
}));

vi.mock("../../runtimes/components/runtime-machines", () => ({
  buildRuntimeMachines: () => [],
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectRunLocationSection } from "./project-run-location-section";

function renderSection(editable = true) {
  return render(
    <I18nProvider locale="en" resources={{ en: { common: enCommon, projects: enProjects } }}>
      <ProjectRunLocationSection projectId="project-1" editable={editable} />
    </I18nProvider>,
  );
}

describe("ProjectRunLocationSection", () => {
  beforeEach(() => {
    state.devices = [];
    state.warning = null;
    state.replaceDevices.mockReset();
    state.replaceDevices.mockResolvedValue({ devices: [], total: 0, warning: null });
  });

  it("keeps unrestricted projects collapsed until the user opts in", () => {
    renderSection();

    expect(screen.getByText("Any available device")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /restrict run location/i }));
    expect(screen.getByRole("combobox", { name: /search devices/i })).toBeInTheDocument();
  });

  it("shows an offline warning for an existing device restriction", () => {
    state.devices = [{
      project_id: "project-1",
      workspace_id: "ws-1",
      daemon_id: "daemon-1",
      display_name: "Personal Mac",
      online: false,
      providers: ["claude", "codex"],
      created_at: "2026-08-31T00:00:00Z",
      created_by: "user-1",
    }];
    state.warning = "All devices allowed for this project are currently offline.";

    renderSection(false);

    expect(screen.getByText("Personal Mac")).toBeInTheDocument();
    expect(screen.getByText("claude + codex")).toBeInTheDocument();
    expect(screen.getByText(/all allowed devices are offline/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("saves the complete selection through one atomic mutation", async () => {
    state.devices = [{
      project_id: "project-1",
      workspace_id: "ws-1",
      daemon_id: "daemon-1",
      display_name: "Personal Mac",
      online: true,
      providers: ["codex"],
      created_at: "2026-08-31T00:00:00Z",
      created_by: "user-1",
    }];

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(state.replaceDevices).toHaveBeenCalledTimes(1));
    expect(state.replaceDevices).toHaveBeenCalledWith(["daemon-1"]);
  });
});
