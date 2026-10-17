// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import enRuntimes from "../../locales/en/runtimes.json";
import { RuntimeWorkspacesTab } from "./runtime-workspaces-tab";
import { RuntimeWorkspacePicker, WorkLocationPicker } from "./runtime-workspace-picker";
import { RuntimeDirectoryDialog } from "./runtime-directory-dialog";

const api = vi.hoisted(() => ({ listRuntimeWorkspaces: vi.fn(), listRuntimes: vi.fn(), listProjects: vi.fn(), createRuntimeWorkspace: vi.fn(), archiveRuntimeWorkspace: vi.fn(), initiateDirectoryScan: vi.fn(), getDirectoryScanResult: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("../../projects/components/project-picker", () => ({ ProjectPicker: () => <span>Optional project</span> }));
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.listRuntimeWorkspaces.mockResolvedValue([]);
  api.listRuntimes.mockResolvedValue([runtime]);
  api.listProjects.mockResolvedValue({ projects: [{ id: "project-1", title: "Remi", icon: null, color: null }] });
  api.initiateDirectoryScan.mockImplementation((_id, params) => {
    const path = params.root === "~" ? "/Users/mac" : params.root;
    const child = path === "/Users/mac" ? "workbench" : path === "/Users/mac/workbench" ? "app" : null;
    return Promise.resolve(directoryResult(path, child ? [child] : []));
  });
});
function directoryResult(root: string, children: string[] = []) {
  return { id: "scan-1", status: "completed", supported: true, params: { resolved_root: root },
    candidates: children.map(name => ({ name, path: `${root}/${name}`, remote_url: null, current_branch: null, is_dirty: null })) };
}
const runtime = { id: "runtime-1", daemon_id: "laptop", status: "online", name: "Codex", device_info: "Mac" } as AgentRuntime;
function show(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(children, { wrapper: ({ children }) => <I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  </I18nProvider> });
}

it("registers local paths, retains failed input, and surfaces the server error", async () => {
  const user = userEvent.setup();
  api.createRuntimeWorkspace.mockRejectedValue(new Error("Directory already registered"));
  show(<RuntimeWorkspacesTab runtime={runtime} canManage />);
  await user.click(screen.getByRole("button", { name: "Choose root directory" }));
  await user.click(await screen.findByRole("button", { name: "workbench" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this directory" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  expect(screen.getByLabelText("Name")).toHaveValue("workbench");
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Private workbench");
  await user.click(screen.getByRole("button", { name: "Choose subdirectory" }));
  expect(screen.getByRole("button", { name: "Parent directory" })).toBeDisabled();
  await user.click(await screen.findByRole("button", { name: "app" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this directory" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  await user.click(screen.getByRole("button", { name: "Register workspace" }));
  await waitFor(() => expect(api.createRuntimeWorkspace).toHaveBeenCalledWith("runtime-1", {
    name: "Private workbench", root_path: "/Users/mac/workbench", cwd: "app", context_paths: [], env_file: null,
  }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Directory already registered");
  expect(screen.getByRole("button", { name: "Choose root directory" })).toHaveTextContent("/Users/mac/workbench");
  expect(screen.getByRole("status")).toHaveTextContent("/Users/mac/workbench/app");
});

it("selects an empty home directory using the path resolved by the remote machine", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  api.initiateDirectoryScan.mockResolvedValue(directoryResult("C:\\Users\\Alice"));
  show(<RuntimeDirectoryDialog runtimeId="runtime-1" machineName="Windows" initialPath="~" online onSelect={select} onClose={vi.fn()} />);
  expect(await screen.findByText("No subdirectories. You can select this directory.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  expect(select).toHaveBeenCalledWith("C:\\Users\\Alice");
  expect(api.initiateDirectoryScan).toHaveBeenCalledWith("runtime-1", { root: "~", mode: "browse" });
});

it("does not select stale results after editing a path or a failed directory read", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  show(<RuntimeDirectoryDialog runtimeId="runtime-1" machineName="Mac" initialPath="~" online onSelect={select} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: "workbench" });
  await user.clear(screen.getByLabelText("Directory path"));
  await user.type(screen.getByLabelText("Directory path"), "/no-access");
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeDisabled();
  api.initiateDirectoryScan.mockRejectedValueOnce(new Error("Permission denied"));
  await user.click(screen.getByRole("button", { name: "Go to directory" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeDisabled();
  expect(select).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Home directory" }));
  await screen.findByRole("button", { name: "workbench" });
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeEnabled();
});

it("prevents a working-directory jump outside its shared root", async () => {
  const user = userEvent.setup();
  show(<RuntimeDirectoryDialog runtimeId="runtime-1" machineName="Mac" initialPath="/Users/mac/workbench" boundary="/Users/mac/workbench" online onSelect={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: "app" });
  await user.clear(screen.getByLabelText("Directory path"));
  await user.type(screen.getByLabelText("Directory path"), "/Users/mac/workbench-other");
  await user.click(screen.getByRole("button", { name: "Go to directory" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Choose a directory inside the shared root.");
  expect(api.initiateDirectoryScan).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Use this directory" })).toBeDisabled();
});

it("does not browse an offline machine and clears selections when the Runtime changes", async () => {
  const user = userEvent.setup();
  const view = show(<RuntimeWorkspacesTab runtime={runtime} canManage />);
  await user.click(screen.getByRole("button", { name: "Choose root directory" }));
  await screen.findByRole("button", { name: "workbench" });
  await user.click(screen.getByRole("button", { name: "Use this directory" }));
  expect(screen.getByLabelText("Name")).toHaveValue("mac");
  // Rerender inside the same provider tree so the component must clear the form.
  view.rerender(<RuntimeWorkspacesTab runtime={{ ...runtime, id: "runtime-2", status: "offline" }} canManage />);
  expect(screen.getByLabelText("Name")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Choose root directory" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Register workspace" })).toBeDisabled();
});

it("keeps an unavailable workspace selectable and retains a saved missing selection", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  api.listRuntimeWorkspaces.mockResolvedValue([{ id: "rws-1", name: "Laptop", daemon_id: "laptop", root_path: "/local", cwd: ".", status: "unavailable" }]);
  const view = show(<RuntimeWorkspacePicker wsId="ws-1" value="rws-missing" onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Work location: Directory unavailable" });
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: /Laptop/ }));
  expect(onChange).toHaveBeenCalledWith("rws-1");
  view.unmount();
  show(<RuntimeWorkspacePicker wsId="ws-1" value="rws-1" onChange={onChange} disabled />);
  expect(screen.getByRole("button", { name: /Work location:/ })).toBeDisabled();
});


it("replaces a project with a local directory and back with one atomic selection", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  api.listRuntimeWorkspaces.mockResolvedValue([{ id: "rws-1", name: "Private workbench", daemon_id: "laptop", root_path: "/Users/mac/workbench", cwd: "app", status: "unavailable" }]);
  const view = show(<WorkLocationPicker wsId="ws-1" projectId="project-1" value={null} onChange={onChange} />);
  await user.click(await screen.findByRole("button", { name: "Work location: Remi" }));
  const directory = await screen.findByRole("menuitem", { name: /Private workbench/ });
  expect(directory).toHaveTextContent("/Users/mac/workbench/app");
  expect(directory).toHaveTextContent("Mac");
  expect(directory).toHaveTextContent("Offline");
  await user.click(directory);
  expect(onChange).toHaveBeenLastCalledWith({ project_id: null, runtime_workspace_id: "rws-1" });
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  view.rerender(<WorkLocationPicker wsId="ws-1" projectId={null} value="rws-1" onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "Work location: Private workbench" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remi" }));
  expect(onChange).toHaveBeenLastCalledWith({ project_id: "project-1", runtime_workspace_id: null });
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /Work location:/ }));
  await user.click(await screen.findByRole("menuitem", { name: "Automatic" }));
  expect(onChange).toHaveBeenLastCalledWith({ project_id: null, runtime_workspace_id: null });
});

it("keeps project choices usable when directory loading fails", async () => {
  api.listRuntimeWorkspaces.mockRejectedValue(new Error("unavailable"));
  const user = userEvent.setup();
  const onChange = vi.fn();
  show(<WorkLocationPicker wsId="ws-1" value={null} onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "Work location: Automatic" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  await user.click(await screen.findByRole("menuitem", { name: "Remi" }));
  expect(onChange).toHaveBeenCalledWith({ project_id: "project-1", runtime_workspace_id: null });
});

it("names Chat's unbound choice by what it does and opens from the keyboard", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  show(<WorkLocationPicker wsId="ws-1" value={null} onChange={onChange} surface="chat" />);
  const trigger = screen.getByRole("button", { name: "Work location: Don't pull code" });
  // The whole short label shows; the tooltip also says what it means.
  expect(trigger).toHaveTextContent("Don't pull code");
  expect(trigger).toHaveAttribute("title", "Don't pull code\nUses this chat's own folder");
  expect(trigger.parentElement?.className).toContain("shrink-0");
  expect(trigger.className).not.toContain("-mx-1");
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByText(/^No code is pulled by default\./)).toBeInTheDocument();
  expect(screen.queryByText("Choose a project or a local directory for this task.")).not.toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /Don't pull code/ })).toHaveTextContent("Uses this chat's own folder");
  expect(screen.queryByRole("menuitem", { name: "Automatic" })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("menuitem", { name: "Remi" }));
  expect(onChange).toHaveBeenCalledWith({ project_id: "project-1", runtime_workspace_id: null });
});

it("caps a long Chat location name and keeps the full name in its tooltip", async () => {
  const title = "A project with a very long name that cannot fit beside the agent";
  api.listProjects.mockResolvedValue({ projects: [{ id: "project-1", title, icon: null, color: null }] });
  show(<WorkLocationPicker wsId="ws-1" projectId="project-1" value={null} onChange={vi.fn()} surface="chat" />);
  const trigger = await screen.findByRole("button", { name: `Work location: ${title}` });
  expect(trigger).toHaveAttribute("title", title);
  expect(trigger.parentElement?.className).toMatch(/min-w-0 max-w-48/);
  expect(screen.getByText(title).className).toContain("truncate");
});

it("shows a started Chat's location as a read-only chip with the locked hint", async () => {
  show(<WorkLocationPicker wsId="ws-1" projectId="project-1" value={null} onChange={vi.fn()} surface="chat" readOnly />);
  const chip = await screen.findByRole("group", { name: "Work location: Remi" });
  expect(chip).toHaveAttribute("title", "Remi\nThe work location is fixed after the session starts. Start a new task or chat to change it.");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("keeps the Issue surface's Automatic choice unchanged", async () => {
  const user = userEvent.setup();
  show(<WorkLocationPicker wsId="ws-1" value={null} onChange={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Work location: Automatic" }));
  expect(await screen.findByText("Choose a project or a local directory for this task.")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Automatic" })).toBeInTheDocument();
  expect(screen.queryByText("Uses this chat's own folder")).not.toBeInTheDocument();
});
