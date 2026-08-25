import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as "owner" | "admin" | "member" }],
  pending: false,
}));
const relayRef = vi.hoisted(() => ({
  current: {
    claude: { fragment: '{"env":{"ANTHROPIC_BASE_URL":"https://ai.openremi.fun"}}', hasToken: true, revision: 3 },
    codex: { fragment: "", hasToken: false, revision: 0 },
    modelDiscovery: true,
  } as Record<string, unknown> | undefined,
  pending: false,
  error: null as Error | null,
}));
const mockRefetchRelay = vi.hoisted(() => vi.fn());
const mockUpdateRelay = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSetDiscovery = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockSetQueryData = vi.hoisted(() => vi.fn());
const workspaceRef = vi.hoisted(() => ({
  current: {
    id: "workspace-1",
    slug: "acme",
    name: "Acme",
    settings: {} as Record<string, unknown>,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = JSON.stringify(opts?.queryKey ?? []);
    if (key.includes("relay-config")) {
      return {
        data: relayRef.error ? undefined : relayRef.current,
        isPending: relayRef.pending,
        isError: relayRef.error !== null,
        error: relayRef.error,
        refetch: mockRefetchRelay,
      };
    }
    return { data: membersRef.current, isPending: membersRef.pending };
  },
  useQueryClient: () => ({ setQueryData: mockSetQueryData, invalidateQueries: vi.fn() }),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/paths", () => ({
  useCurrentWorkspace: () => workspaceRef.current,
}));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
  workspaceKeys: { list: () => ["workspaces", "list"] },
}));
vi.mock("@multiremi/core/auth", () => ({
  useAuthStore: Object.assign(
    (sel?: (s: { user: { id: string } }) => unknown) => (sel ? sel({ user: { id: "user-1" } }) : { user: { id: "user-1" } }),
    { getState: () => ({ user: { id: "user-1" } }) },
  ),
}));
vi.mock("@multiremi/core/api", () => ({
  api: {
    getRelayConfig: vi.fn(() => Promise.resolve(relayRef.current)),
    updateRelayConfig: mockUpdateRelay,
    setRelayDiscovery: mockSetDiscovery,
    revealRelayToken: vi.fn(() => Promise.resolve("sk-revealed")),
    updateWorkspace: mockUpdateWorkspace,
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ModelGatewayTab } from "./model-gateway-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };
function Wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>;
}

describe("ModelGatewayTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    membersRef.current = [{ user_id: "user-1", role: "owner" }];
    membersRef.pending = false;
    relayRef.current = {
      claude: { fragment: '{"env":{"ANTHROPIC_BASE_URL":"https://ai.openremi.fun"}}', hasToken: true, revision: 3 },
      codex: { fragment: "", hasToken: false, revision: 0 },
      modelDiscovery: true,
    };
    relayRef.pending = false;
    relayRef.error = null;
    workspaceRef.current.settings = {};
    mockUpdateWorkspace.mockImplementation(async (_id: string, input: { settings: Record<string, unknown> }) => ({
      ...workspaceRef.current,
      settings: input.settings,
    }));
  });

  it("renders discovery toggle and both engine sections for an admin", () => {
    render(<ModelGatewayTab />, { wrapper: Wrapper });
    expect(screen.getByText("Auto-discover models")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Task progress summaries")).toBeInTheDocument();
    // claude fragment is pre-filled from server config
    expect(screen.getByDisplayValue(/ANTHROPIC_BASE_URL/)).toBeInTheDocument();
  });

  it("blocks non owner/admin members", () => {
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    render(<ModelGatewayTab />, { wrapper: Wrapper });
    expect(screen.getByText(/Only workspace owners and admins/)).toBeInTheDocument();
    expect(screen.queryByText("Auto-discover models")).not.toBeInTheDocument();
  });

  it("saves the claude fragment with token_op keep when the token was untouched", async () => {
    render(<ModelGatewayTab />, { wrapper: Wrapper });
    const [claudeSaveButton] = screen.getAllByRole("button", { name: /^Save$/ });
    if (!claudeSaveButton) throw new Error("Claude save button not found");
    await userEvent.click(claudeSaveButton);
    await waitFor(() => expect(mockUpdateRelay).toHaveBeenCalled());
    expect(mockUpdateRelay).toHaveBeenCalledWith(
      "workspace-1",
      "claude",
      expect.objectContaining({ token_op: "keep", fragment: expect.stringContaining("ANTHROPIC_BASE_URL") }),
    );
  });

  it("persists allowlisted progress summary settings without dropping other workspace settings", async () => {
    workspaceRef.current.settings = {
      retained_setting: "yes",
      progress_summary: {
        transport: "openai",
        model: "claude-workspace",
        openai_model: "gpt-workspace",
        openai_api_key: "must-not-survive",
      },
    };
    const user = userEvent.setup();
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByLabelText("OpenAI-compatible model")).toHaveValue("gpt-workspace");
    await user.clear(screen.getByLabelText("OpenAI-compatible model"));
    await user.type(screen.getByLabelText("OpenAI-compatible model"), "gpt-custom");
    await user.click(screen.getByRole("button", { name: "Save summary settings" }));

    await waitFor(() => expect(mockUpdateWorkspace).toHaveBeenCalledWith("workspace-1", {
      settings: {
        retained_setting: "yes",
        progress_summary: {
          transport: "openai",
          model: "claude-workspace",
          openai_model: "gpt-custom",
        },
      },
    }));
  });

  it("renders a skeleton instead of an empty savable form while the config loads", () => {
    relayRef.pending = true;
    relayRef.current = undefined;
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByTestId("model-gateway-skeleton")).toBeInTheDocument();
    // A blank textarea + live Save would PUT fragment:"" as a full replace
    // and wipe the fleet's relay config, so neither may exist yet.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("says the config failed to load and offers a retry", async () => {
    relayRef.error = new Error("relay unreachable");
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load the gateway configuration",
    );
    expect(screen.getByText("relay unreachable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetchRelay).toHaveBeenCalled();
  });

  it("waits for the member query before deciding the viewer lacks permission", () => {
    // `members` defaults to [] while in flight, which used to read as "no
    // role" and flashed the denial at owners deep-linking the tab.
    membersRef.pending = true;
    membersRef.current = [];
    render(<ModelGatewayTab />, { wrapper: Wrapper });

    expect(screen.queryByText(/Only workspace owners and admins/)).not.toBeInTheDocument();
    expect(screen.getByTestId("model-gateway-skeleton")).toBeInTheDocument();
  });
});
