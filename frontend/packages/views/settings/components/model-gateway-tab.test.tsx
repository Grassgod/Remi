import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as "owner" | "admin" | "member" }],
}));
const relayRef = vi.hoisted(() => ({
  current: {
    claude: { fragment: '{"env":{"ANTHROPIC_BASE_URL":"https://ai.openremi.fun"}}', hasToken: true, revision: 3 },
    codex: { fragment: "", hasToken: false, revision: 0 },
    modelDiscovery: true,
  },
}));
const mockUpdateRelay = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockSetDiscovery = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey?: unknown[] }) => {
    const key = JSON.stringify(opts?.queryKey ?? []);
    if (key.includes("relay-config")) return { data: relayRef.current };
    return { data: membersRef.current };
  },
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
}));

vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
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
  });

  it("renders discovery toggle and both engine sections for an admin", () => {
    render(<ModelGatewayTab />, { wrapper: Wrapper });
    expect(screen.getByText("Auto-discover models")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
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
    const saveButtons = screen.getAllByRole("button", { name: /Save/ });
    await userEvent.click(saveButtons[0]); // claude section
    await waitFor(() => expect(mockUpdateRelay).toHaveBeenCalled());
    expect(mockUpdateRelay).toHaveBeenCalledWith(
      "workspace-1",
      "claude",
      expect.objectContaining({ token_op: "keep", fragment: expect.stringContaining("ANTHROPIC_BASE_URL") }),
    );
  });
});
