// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSkills from "../../locales/en/skills.json";

const TEST_RESOURCES = {
  en: { common: enCommon, skills: enSkills },
};

const mockResolveRuntimeLocalSkillImport = vi.hoisted(() => vi.fn());
const mockRuntimeListOptions = vi.hoisted(() => vi.fn());
const mockRuntimeLocalSkillsOptions = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multiremi/core/auth", () => {
  const stateUser = { id: "user-1", email: "u@example.com", name: "User" };
  const useAuthStore = (selector?: (s: { user: typeof stateUser }) => unknown) => {
    const state = { user: stateUser };
    return selector ? selector(state) : state;
  };
  return { useAuthStore };
});

vi.mock("@multiremi/core/runtimes", () => ({
  runtimeListOptions: (...args: unknown[]) => mockRuntimeListOptions(...args),
  runtimeLocalSkillsOptions: (...args: unknown[]) => {
    const options = mockRuntimeLocalSkillsOptions(...args);
    return { ...options, queryKey: [...options.queryKey, args[2]] };
  },
  runtimeLocalSkillsKeys: {
    forRuntime: (runtimeId: string) => ["runtimes", "local-skills", runtimeId],
  },
  resolveRuntimeLocalSkillImport: (...args: unknown[]) =>
    mockResolveRuntimeLocalSkillImport(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { RuntimeLocalSkillImportPanel } from "./runtime-local-skill-import-panel";

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

const MOCK_RUNTIME = {
  id: "runtime-1",
  workspace_id: "ws-1",
  daemon_id: "daemon-1",
  name: "Claude (MacBook)",
  runtime_mode: "local",
  provider: "claude",
  launch_header: "",
  status: "online",
  device_info: "",
  metadata: {},
  owner_id: "user-1",
  last_seen_at: null,
  created_at: "2026-04-16T00:00:00Z",
  updated_at: "2026-04-16T00:00:00Z",
};

const MOCK_SKILL_A = {
  key: "review-helper",
  name: "Review Helper",
  description: "Review pull requests",
  provider: "claude",
  source_path: "~/.claude/skills/review-helper",
  file_count: 2,
};

const MOCK_SKILL_B = {
  key: "code-gen",
  name: "Code Gen",
  description: "Generate code from specs",
  provider: "claude",
  source_path: "~/.claude/skills/code-gen",
  file_count: 3,
};

const MOCK_IMPORTED_SKILL_A = {
  id: "skill-1",
  workspace_id: "ws-1",
  name: "Review Helper",
  description: "Review pull requests",
  content: "# Review Helper",
  config: {},
  files: [],
  created_by: "user-1",
  created_at: "2026-04-16T00:00:00Z",
  updated_at: "2026-04-16T00:00:00Z",
};

const MOCK_IMPORTED_SKILL_B = {
  id: "skill-2",
  workspace_id: "ws-1",
  name: "Code Gen",
  description: "Generate code from specs",
  content: "# Code Gen",
  config: {},
  files: [],
  created_by: "user-1",
  created_at: "2026-04-16T00:00:00Z",
  updated_at: "2026-04-16T00:00:00Z",
};

function renderPanel(props: { onImported?: (skill: unknown) => void; onBulkDone?: () => void } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <I18nWrapper>
      <QueryClientProvider client={queryClient}>
        <RuntimeLocalSkillImportPanel {...props} />
      </QueryClientProvider>
    </I18nWrapper>,
  );
  return { ...view, queryClient };
}

async function startScan() {
  const button = screen.getByRole("button", { name: "Scan skills" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe("RuntimeLocalSkillImportPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRuntimeListOptions.mockReturnValue({
      queryKey: ["runtimes", "ws-1", "list"],
      queryFn: () => Promise.resolve([MOCK_RUNTIME]),
    });
    mockRuntimeLocalSkillsOptions.mockReturnValue({
      queryKey: ["runtimes", "local-skills", "runtime-1"],
      queryFn: () =>
        Promise.resolve({
          scan_request_id: "scan-1",
          supported: true,
          skills: [MOCK_SKILL_A],
        }),
    });
    mockResolveRuntimeLocalSkillImport.mockResolvedValue({
      skill: MOCK_IMPORTED_SKILL_A,
    });
  });

  it("imports a single skill when selected via checkbox", async () => {
    renderPanel();
    await startScan();

    // Wait for skill list to render
    expect(
      await screen.findByText("Review Helper", {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Click the skill row to toggle its checkbox
    const skillButton = screen.getByRole("button", { name: /Review Helper/i });
    fireEvent.click(skillButton);

    const importButton = screen.getByRole("button", {
      name: /Import to Workspace/i,
    });
    await waitFor(
      () => {
        expect(importButton).not.toBeDisabled();
      },
      { timeout: 5000 },
    );
    fireEvent.click(importButton);

    await waitFor(
      () => {
        expect(mockResolveRuntimeLocalSkillImport).toHaveBeenCalledWith(
          "runtime-1",
          {
            scan_request_id: "scan-1",
            skill_key: "review-helper",
            name: "Review Helper",
            description: "Review pull requests",
          },
        );
      },
      { timeout: 5000 },
    );
  });

  it("imports multiple skills in sequence and shows summary", async () => {
    mockRuntimeLocalSkillsOptions.mockReturnValue({
      queryKey: ["runtimes", "local-skills", "runtime-1"],
      queryFn: () =>
        Promise.resolve({
          scan_request_id: "scan-1",
          supported: true,
          skills: [MOCK_SKILL_A, MOCK_SKILL_B],
        }),
    });
    mockResolveRuntimeLocalSkillImport
      .mockResolvedValueOnce({ skill: MOCK_IMPORTED_SKILL_A })
      .mockResolvedValueOnce({ skill: MOCK_IMPORTED_SKILL_B });

    renderPanel();
    await startScan();

    // Wait for skills to render
    expect(
      await screen.findByText("Review Helper", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Code Gen")).toBeInTheDocument();

    // Click select all checkbox (the native one in the label)
    const selectAllLabel = screen.getByText(/Select all/i);
    const selectAllCheckbox = selectAllLabel.closest("label")!.querySelector("input[type='checkbox']")!;
    fireEvent.click(selectAllCheckbox);

    // Button should now say "Import 2 Skills"
    const importButton = screen.getByRole("button", {
      name: /Import 2 Skills/i,
    });
    await waitFor(
      () => {
        expect(importButton).not.toBeDisabled();
      },
      { timeout: 5000 },
    );
    fireEvent.click(importButton);

    // Wait for completion — summary should appear with "Done" button
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: /Done/i }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    expect(mockResolveRuntimeLocalSkillImport).toHaveBeenCalledTimes(2);

    // Verify summary shows both as imported
    expect(screen.getByText("Imported")).toBeInTheDocument();
  });

  it("handles partial failures gracefully", async () => {
    mockRuntimeLocalSkillsOptions.mockReturnValue({
      queryKey: ["runtimes", "local-skills", "runtime-1"],
      queryFn: () =>
        Promise.resolve({
          scan_request_id: "scan-1",
          supported: true,
          skills: [MOCK_SKILL_A, MOCK_SKILL_B],
        }),
    });
    mockResolveRuntimeLocalSkillImport
      .mockResolvedValueOnce({ skill: MOCK_IMPORTED_SKILL_A })
      .mockRejectedValueOnce(new Error("409 conflict: already exists"));

    renderPanel();
    await startScan();

    // Wait for skills
    expect(
      await screen.findByText("Review Helper", {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Select all
    const selectAllLabel2 = screen.getByText(/Select all/i);
    const selectAllCheckbox2 = selectAllLabel2.closest("label")!.querySelector("input[type='checkbox']")!;
    fireEvent.click(selectAllCheckbox2);

    // Import
    const importButton = screen.getByRole("button", {
      name: /Import 2 Skills/i,
    });
    await waitFor(
      () => {
        expect(importButton).not.toBeDisabled();
      },
      { timeout: 5000 },
    );
    fireEvent.click(importButton);

    // Wait for Done
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: /Done/i }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // Summary should show imported and skipped
    expect(screen.getByText("Imported")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });

  it("calls onImported when exactly one skill succeeds", async () => {
    const onImported = vi.fn();
    renderPanel({ onImported });
    await startScan();

    expect(
      await screen.findByText("Review Helper", {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Select the single skill
    const skillButton = screen.getByRole("button", { name: /Review Helper/i });
    fireEvent.click(skillButton);

    const importButton = screen.getByRole("button", {
      name: /Import to Workspace/i,
    });
    await waitFor(
      () => {
        expect(importButton).not.toBeDisabled();
      },
      { timeout: 5000 },
    );
    fireEvent.click(importButton);

    // Wait for Done button
    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: /Done/i }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // Click Done — should call onImported with the single skill
    fireEvent.click(screen.getByRole("button", { name: /Done/i }));
    expect(onImported).toHaveBeenCalledWith(MOCK_IMPORTED_SKILL_A);
  });

  it("calls onBulkDone when multiple skills succeed", async () => {
    mockRuntimeLocalSkillsOptions.mockReturnValue({
      queryKey: ["runtimes", "local-skills", "runtime-1"],
      queryFn: () =>
        Promise.resolve({
          scan_request_id: "scan-1",
          supported: true,
          skills: [MOCK_SKILL_A, MOCK_SKILL_B],
        }),
    });
    mockResolveRuntimeLocalSkillImport
      .mockResolvedValueOnce({ skill: MOCK_IMPORTED_SKILL_A })
      .mockResolvedValueOnce({ skill: MOCK_IMPORTED_SKILL_B });

    const onImported = vi.fn();
    const onBulkDone = vi.fn();
    renderPanel({ onImported, onBulkDone });
    await startScan();

    expect(
      await screen.findByText("Review Helper", {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Select all
    const selectAllLabel3 = screen.getByText(/Select all/i);
    const selectAllCheckbox3 = selectAllLabel3.closest("label")!.querySelector("input[type='checkbox']")!;
    fireEvent.click(selectAllCheckbox3);

    const importButton = screen.getByRole("button", {
      name: /Import 2 Skills/i,
    });
    await waitFor(
      () => {
        expect(importButton).not.toBeDisabled();
      },
      { timeout: 5000 },
    );
    fireEvent.click(importButton);

    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: /Done/i }),
        ).toBeInTheDocument();
      },
      { timeout: 10000 },
    );

    // Click Done — should call onBulkDone, NOT onImported
    fireEvent.click(screen.getByRole("button", { name: /Done/i }));
    expect(onBulkDone).toHaveBeenCalledTimes(1);
    expect(onImported).not.toHaveBeenCalled();
  });
  it("scans only on request and prevents importing stale selections after a directory edit", async () => {
    const discover = vi.fn().mockResolvedValue({ scan_request_id: "scan-custom", root: "/home/me/.agents/skills", supported: true, skills: [MOCK_SKILL_A] });
    mockRuntimeLocalSkillsOptions.mockImplementation((runtimeId, root) => ({
      queryKey: ["runtimes", "local-skills", runtimeId, root],
      queryFn: () => discover(runtimeId, root),
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan skills" })).toBeEnabled());
    expect(discover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Custom directory" }));
    fireEvent.change(screen.getByLabelText("Skill directory on runtime"), { target: { value: "~/.agents/skills" } });
    expect(discover).not.toHaveBeenCalled();
    await startScan();
    fireEvent.click(await screen.findByRole("button", { name: /Review Helper/ }));
    expect(discover).toHaveBeenCalledWith("runtime-1", "~/.agents/skills");
    expect(screen.getByRole("button", { name: "Import to Workspace" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Skill directory on runtime"), { target: { value: "/another" } });
    expect(screen.queryByRole("button", { name: /Review Helper/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import to Workspace" })).toBeDisabled();
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("ignores a late result from another directory and imports using the current scan id", async () => {
    let finishOld!: (value: unknown) => void;
    const oldResult = new Promise(resolve => { finishOld = resolve; });
    mockRuntimeLocalSkillsOptions.mockImplementation((runtimeId, root) => ({
      queryKey: ["runtimes", "local-skills", runtimeId, root],
      queryFn: () => root === "/old" ? oldResult : Promise.resolve({ scan_request_id: "scan-new", root: "/new", supported: true, skills: [MOCK_SKILL_B] }),
    }));
    renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "Custom directory" }));
    fireEvent.change(screen.getByLabelText("Skill directory on runtime"), { target: { value: "/old" } });
    await startScan();
    fireEvent.change(screen.getByLabelText("Skill directory on runtime"), { target: { value: "/new" } });
    await startScan();
    expect(await screen.findByText("Code Gen")).toBeInTheDocument();
    await act(async () => { finishOld({ scan_request_id: "scan-old", root: "/old", supported: true, skills: [MOCK_SKILL_A] }); });
    expect(screen.queryByText("Review Helper")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Code Gen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import to Workspace" }));
    await waitFor(() => expect(mockResolveRuntimeLocalSkillImport).toHaveBeenCalledWith("runtime-1", expect.objectContaining({ scan_request_id: "scan-new", skill_key: "code-gen" })));
  });

  it("shows scan warnings and excludes unavailable skills from select all", async () => {
    mockRuntimeLocalSkillsOptions.mockReturnValue({
      queryKey: ["runtimes", "local-skills", "runtime-1"],
      queryFn: () => Promise.resolve({ scan_request_id: "scan-1", supported: true,
        skills: [MOCK_SKILL_A, { ...MOCK_SKILL_B, error: "Binary file cannot be imported" }], warnings: ["Scan limit reached"] }),
    });
    renderPanel();
    await startScan();
    expect(await screen.findByText("Binary file cannot be imported")).toBeInTheDocument();
    expect(screen.getByText("Scan limit reached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Code Gen/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: /Code Gen/ }));
    expect(screen.getByRole("button", { name: "Import to Workspace" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Import to Workspace" }));
    await waitFor(() => expect(mockResolveRuntimeLocalSkillImport).toHaveBeenCalledTimes(1));
    expect(mockResolveRuntimeLocalSkillImport).toHaveBeenCalledWith("runtime-1", expect.objectContaining({ skill_key: "review-helper" }));
  });

  it("preserves the scan and selection when the same Runtime inventory refreshes", async () => {
    const { queryClient } = renderPanel();
    await startScan();
    fireEvent.click(await screen.findByRole("button", { name: /Review Helper/ }));
    await act(async () => { queryClient.setQueryData(["runtimes", "ws-1", "list"], [{ ...MOCK_RUNTIME, name: "Updated name" }]); });
    expect(screen.getByRole("button", { name: "Import to Workspace" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import to Workspace" }));
    await waitFor(() => expect(mockResolveRuntimeLocalSkillImport).toHaveBeenCalledWith("runtime-1", expect.objectContaining({ scan_request_id: "scan-1" })));
  });

  it("shows discovery failure and keeps import disabled", async () => {
    mockRuntimeLocalSkillsOptions.mockReturnValue({ queryKey: ["runtimes", "local-skills", "runtime-1"], retry: false,
      queryFn: () => Promise.reject(new Error("Update the runtime daemon")) });
    renderPanel();
    await startScan();
    expect(await screen.findByText("Update the runtime daemon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import to Workspace" })).toBeDisabled();
  });

  it("clears the selected inventory when the Runtime changes", async () => {
    const user = userEvent.setup();
    mockRuntimeListOptions.mockReturnValue({ queryKey: ["runtimes", "ws-1", "list"], queryFn: async () => [MOCK_RUNTIME, { ...MOCK_RUNTIME, id: "runtime-2", name: "Second runtime" }] });
    mockRuntimeLocalSkillsOptions.mockImplementation((runtimeId, root) => ({
      queryKey: ["runtimes", "local-skills", runtimeId, root],
      queryFn: async () => ({ scan_request_id: `scan-${runtimeId}`, supported: true, skills: runtimeId === "runtime-1" ? [MOCK_SKILL_A] : [MOCK_SKILL_B] }),
    }));
    renderPanel();
    await startScan();
    fireEvent.click(await screen.findByRole("button", { name: /Review Helper/ }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Second runtime/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Review Helper/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Import to Workspace" })).toBeDisabled();
    await startScan();
    fireEvent.click(await screen.findByRole("button", { name: /Code Gen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import to Workspace" }));
    await waitFor(() => expect(mockResolveRuntimeLocalSkillImport).toHaveBeenCalledWith("runtime-2", expect.objectContaining({ scan_request_id: "scan-runtime-2", skill_key: "code-gen" })));
  });

  it("locks the Runtime during import and does not silently rescan when it completes", async () => {
    const discover = vi.fn().mockResolvedValue({ scan_request_id: "scan-1", supported: true, skills: [MOCK_SKILL_A] });
    mockRuntimeLocalSkillsOptions.mockReturnValue({ queryKey: ["runtimes", "local-skills", "runtime-1"], queryFn: discover });
    let finishImport!: (value: unknown) => void;
    mockResolveRuntimeLocalSkillImport.mockReturnValue(new Promise(resolve => { finishImport = resolve; }));
    renderPanel();
    await startScan();
    fireEvent.click(await screen.findByRole("button", { name: /Review Helper/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import to Workspace" }));
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Custom directory" })).toBeDisabled();
    await act(async () => { finishImport({ skill: MOCK_IMPORTED_SKILL_A }); });
    expect(await screen.findByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(discover).toHaveBeenCalledTimes(1);
  });

});
