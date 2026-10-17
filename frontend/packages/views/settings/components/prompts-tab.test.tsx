import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const updatePrompts = vi.hoisted(() => vi.fn());
const refetchPrompts = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const roleRef = vi.hoisted(() => ({ current: "owner" }));
const copyText = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    if (options.queryKey?.[0] === "workspace-prompt-settings") {
      return {
        data: {
          prompt: "Create a PR.",
          revision: 2,
          updatedAt: null,
          updatedBy: null,
        },
        isPending: false,
        isError: false,
        refetch: refetchPrompts,
      };
    }
    if (options.queryKey?.[0] === "workspace-prompt-template") {
      return {
        data: {
          instructions: "# Remi notes\n\n{{issue_description}}",
          input: "{{current_request}}",
          sha256: { instructions: "a".repeat(64), input: "b".repeat(64) },
        },
        isPending: false,
        isError: false,
        refetch: vi.fn(),
      };
    }
    return { data: [{ user_id: "user-1", role: roleRef.current }] };
  },
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "user-1" } }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/workspace/queries", () => ({ memberListOptions: () => ({ queryKey: ["members"] }) }));
vi.mock("@multiremi/core/api", () => ({
  api: {
    getWorkspacePromptSettings: vi.fn(),
    updateWorkspacePromptSettings: updatePrompts,
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@multiremi/ui/lib/clipboard", () => ({ copyText }));

import { PromptsTab } from "./prompts-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("PromptsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    roleRef.current = "owner";
    updatePrompts.mockResolvedValue({
      prompt: "Workspace rule",
      revision: 3,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("edits the one workspace prompt and saves it under the shown revision", async () => {
    const user = userEvent.setup();
    render(<PromptsTab />, { wrapper: Wrapper });

    expect(screen.queryByRole("tab")).toBeNull();
    const editor = screen.getByLabelText("Workspace prompt");
    expect(editor).toHaveValue("Create a PR.");
    expect(screen.getByText(/every turn of every Agent session, in Chat and in Issues/)).toBeInTheDocument();
    expect(screen.getByText(/into every Agent session's instructions \(AGENTS\.md\)/)).toBeInTheDocument();

    await user.clear(editor);
    await user.type(editor, "Workspace rule  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updatePrompts).toHaveBeenCalledWith("workspace-1", {
      prompt: "Workspace rule",
      expected_revision: 2,
    }));
  });

  it("enforces the 16,000 character limit", () => {
    render(<PromptsTab />, { wrapper: Wrapper });

    fireEvent.change(screen.getByLabelText("Workspace prompt"), { target: { value: "x".repeat(16_001) } });

    expect(screen.getByText("16001 / 16000")).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps the prompt read-only for a regular member", () => {
    roleRef.current = "member";
    render(<PromptsTab />, { wrapper: Wrapper });

    expect(screen.getByLabelText("Workspace prompt")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the AGENTS.md and turn input templates with their hashes and copies each", async () => {
    const user = userEvent.setup();
    render(<PromptsTab />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "View template" }));
    const instructions = screen.getByLabelText("AGENTS.md platform template");
    expect(instructions).toHaveTextContent("{{issue_description}}");
    expect(instructions).not.toHaveAttribute("contenteditable", "true");
    expect(screen.getByLabelText("Turn input platform template")).toHaveTextContent("{{current_request}}");
    expect(screen.getByRole("heading", { name: "AGENTS.md" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Turn input" })).toBeInTheDocument();
    expect(screen.getByText(`SHA-256 ${"a".repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText(`SHA-256 ${"b".repeat(64)}`)).toBeInTheDocument();

    const [copyInstructions, copyInput] = screen.getAllByRole("button", { name: "Copy" });
    await user.click(copyInstructions!);
    expect(copyText).toHaveBeenLastCalledWith("# Remi notes\n\n{{issue_description}}");
    await user.click(copyInput!);
    expect(copyText).toHaveBeenLastCalledWith("{{current_request}}");
  });
});
