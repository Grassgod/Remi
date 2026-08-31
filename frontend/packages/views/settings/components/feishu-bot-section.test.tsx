import type { ReactNode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

type MemberRole = "owner" | "admin" | "member" | "guest";

const membersRef = vi.hoisted(() => ({
  current: [{ user_id: "user-1", role: "owner" as MemberRole }],
}));
const botRef = vi.hoisted(() => ({ current: undefined as unknown }));
const statusRef = vi.hoisted(() => ({ current: undefined as unknown }));
const candidatesRef = vi.hoisted(() => ({ current: undefined as unknown }));
const pendingRef = vi.hoisted(() => ({ members: false, bot: false }));

const mockSave = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
const mockDeploy = vi.hoisted(() => vi.fn());
const mockStop = vi.hoisted(() => vi.fn());
const mockTest = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = JSON.stringify(opts.queryKey);
    if (opts.enabled === false) return { data: undefined, isPending: false, isLoading: false };
    if (key.includes("members")) {
      return { data: membersRef.current, isPending: pendingRef.members, isLoading: false };
    }
    if (key.includes("feishu-bot-status")) {
      return { data: statusRef.current, isPending: false, isLoading: false };
    }
    if (key.includes("feishu-bot-candidates")) {
      return { data: candidatesRef.current, isPending: false, isLoading: false };
    }
    if (key.includes("feishu-bot")) {
      return { data: botRef.current, isPending: pendingRef.bot, isLoading: false };
    }
    return { data: undefined, isPending: false, isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  queryOptions: <T,>(opts: T) => opts,
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multiremi/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"], queryFn: vi.fn() }),
}));

vi.mock("@multiremi/core/feishu-bot/queries", () => ({
  feishuBotOptions: () => ({ queryKey: ["feishu-bot"], queryFn: vi.fn() }),
  feishuBotStatusOptions: (_ws: string, enabled?: boolean) => ({
    queryKey: ["feishu-bot-status"],
    queryFn: vi.fn(),
    enabled,
  }),
  feishuBotCandidatesOptions: (_ws: string, enabled?: boolean) => ({
    queryKey: ["feishu-bot-candidates"],
    queryFn: vi.fn(),
    enabled,
  }),
}));

vi.mock("@multiremi/core/feishu-bot/mutations", () => ({
  useSaveFeishuBot: () => ({ mutateAsync: mockSave, isPending: false }),
  useDeleteFeishuBot: () => ({ mutateAsync: mockDelete, isPending: false }),
  useDeployFeishuBot: () => ({ mutateAsync: mockDeploy, isPending: false }),
  useStopFeishuBot: () => ({ mutateAsync: mockStop, isPending: false }),
  useTestFeishuBot: () => ({ mutateAsync: mockTest, isPending: false }),
}));

vi.mock("@multiremi/core/auth", () => {
  const useAuthStore = Object.assign(
    (sel?: (s: { user: { id: string } }) => unknown) =>
      sel ? sel({ user: { id: "user-1" } }) : { user: { id: "user-1" } },
    { getState: () => ({ user: { id: "user-1" } }) },
  );
  return { useAuthStore };
});

vi.mock("@multiremi/core/api", () => ({
  api: {
    beginFeishuBotRegistration: vi.fn(),
    getFeishuBotRegistration: vi.fn(),
    cancelFeishuBotRegistration: vi.fn(),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

vi.mock("react-qr-code", () => {
  const QrStub = ({ value }: { value: string }) => <span data-testid="qr-code" data-value={value} />;
  return { QRCode: QrStub, default: QrStub };
});

import { FeishuBotSection } from "./feishu-bot-section";
import { toast } from "sonner";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function renderSection() {
  return render(<FeishuBotSection />, { wrapper: Wrapper });
}

const CONFIGURED = {
  role: "admin" as const,
  config: {
    configured: true,
    workspace_id: "workspace-1",
    agent_id: "agt_1",
    agent_name: "Remi",
    agent_archived: false,
    runtime_id: "rt_1",
    runtime_name: "mac-mini",
    runtime_online: true,
    runtime_supports_config: true,
    app_id: "cli_abc123",
    domain: "feishu" as const,
    enabled: true,
    revision: 4,
    app_secret_configured: true,
    app_secret_hint: "cli_••••••",
    verification_token_configured: true,
    encrypt_key_configured: false,
    bot_name: "Remi Bot",
    bot_open_id: "ou_1",
    last_tested_at: "2026-08-30T02:00:00Z",
    last_test_error: null,
    last_test_error_code: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-30T02:00:00Z",
    updated_by: "user-1",
  },
};

const CANDIDATES = {
  workspace_id: "workspace-1",
  agents: [
    { id: "agt_1", name: "Remi", provider: "acp:claude" },
    { id: "agt_2", name: "Scout", provider: "acp:codex" },
  ],
  runtimes: [
    { id: "rt_1", name: "mac-mini", daemon_id: "d1", online: true, supports_config: true, last_heartbeat_at: null },
    { id: "rt_2", name: "old-box", daemon_id: "d2", online: true, supports_config: false, last_heartbeat_at: null },
  ],
  encryption_available: true,
};

function resetFixtures() {
  vi.clearAllMocks();
  membersRef.current = [{ user_id: "user-1", role: "owner" }];
  botRef.current = CONFIGURED;
  statusRef.current = undefined;
  candidatesRef.current = CANDIDATES;
  pendingRef.members = false;
  pendingRef.bot = false;
  mockSave.mockResolvedValue(CONFIGURED.config);
  mockDeploy.mockResolvedValue({});
  mockStop.mockResolvedValue({});
  mockDelete.mockResolvedValue({});
  mockTest.mockResolvedValue({ ok: true, bot_name: "Remi Bot" });
}

describe("FeishuBotSection (member view)", () => {
  beforeEach(() => {
    resetFixtures();
    membersRef.current = [{ user_id: "user-1", role: "member" }];
    botRef.current = {
      role: "member",
      availability: { configured: true, available: true, bot_name: "Remi Bot" },
    };
  });

  it("tells a member the bot is reachable without exposing any configuration", () => {
    renderSection();
    expect(screen.getByText(/Remi Bot is online/)).toBeInTheDocument();
    expect(screen.queryByLabelText("App ID")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByText("cli_abc123")).not.toBeInTheDocument();
  });

  it("says the bot is configured but unreachable when it is down", () => {
    botRef.current = {
      role: "member",
      availability: { configured: true, available: false, bot_name: "Remi Bot" },
    };
    renderSection();
    expect(screen.getByText(/configured but not reachable/)).toBeInTheDocument();
  });

  it("says nothing is configured when the workspace has no bot", () => {
    botRef.current = {
      role: "member",
      availability: { configured: false, available: false, bot_name: null },
    };
    renderSection();
    expect(screen.getByText(/No concierge bot is configured/)).toBeInTheDocument();
  });

  it("falls back to the member view when a stale role says admin but the payload does not", () => {
    // Role comes from the member list; the payload comes from the server. If
    // they disagree the payload wins, so a stale cached role cannot render an
    // admin form over a member response.
    membersRef.current = [{ user_id: "user-1", role: "owner" }];
    botRef.current = {
      role: "member",
      availability: { configured: true, available: true, bot_name: "Remi Bot" },
    };
    renderSection();
    expect(screen.queryByLabelText("App ID")).not.toBeInTheDocument();
  });
});

describe("FeishuBotSection (loading)", () => {
  beforeEach(resetFixtures);

  it("renders a skeleton rather than an empty form while the role is unknown", () => {
    pendingRef.members = true;
    const { container } = renderSection();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByLabelText("App ID")).not.toBeInTheDocument();
  });
});

describe("FeishuBotSection (admin form)", () => {
  beforeEach(resetFixtures);

  it("seeds the form from the stored config and never renders a secret", () => {
    renderSection();
    expect(screen.getByLabelText("App ID")).toHaveValue("cli_abc123");
    const secret = screen.getByLabelText("App Secret");
    expect(secret).toHaveValue("");
    // The hint stands in for the stored value; the value itself never arrives.
    expect(secret).toHaveAttribute("placeholder", "cli_••••••");
  });

  it("keeps the stored secret and the enabled state when only the App ID changes", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.clear(screen.getByLabelText("App ID"));
    await user.type(screen.getByLabelText("App ID"), "cli_next");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const request = mockSave.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.app_id).toBe("cli_next");
    expect(request.app_secret_op).toBe("keep");
    expect("app_secret" in request).toBe(false);
    // Save is not a start button: a running bot stays running, a stopped one
    // stays stopped.
    expect(request.enabled).toBe(true);
  });

  it("sends a typed secret once and then drops it from the form", async () => {
    const user = userEvent.setup();
    renderSection();
    const secret = screen.getByLabelText("App Secret");
    await user.type(secret, "super-secret");
    expect(secret).toHaveValue("super-secret");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const request = mockSave.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.app_secret_op).toBe("set");
    expect(request.app_secret).toBe("super-secret");

    await waitFor(() => expect(screen.getByLabelText("App Secret")).toHaveValue(""));
    expect(toast.success).toHaveBeenCalled();
  });

  it("clears an optional secret only when the admin asks for it", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const request = mockSave.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.verification_token_op).toBe("clear");
    // The Encrypt Key was never configured, so it has no Clear affordance and
    // stays on `keep`.
    expect(request.encrypt_key_op).toBe("keep");
  });

  it("refuses to save when the server cannot encrypt credentials", () => {
    candidatesRef.current = { ...CANDIDATES, encryption_available: false };
    renderSection();
    expect(screen.getByText(/no credential encryption key/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("refuses to save a brand-new config with no secret at all", () => {
    botRef.current = { role: "admin", config: { ...CONFIGURED.config, configured: false, app_secret_configured: false, app_id: "" } };
    renderSection();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("blocks Deploy until unsaved edits are saved", async () => {
    const user = userEvent.setup();
    renderSection();
    const deploy = screen.getByRole("button", { name: "Redeploy" });
    expect(deploy).toBeEnabled();

    await user.type(screen.getByLabelText("App ID"), "x");
    // Deploying a stale revision would start the bot on credentials the admin
    // has already replaced on screen.
    expect(screen.getByRole("button", { name: "Redeploy" })).toBeDisabled();
  });

  it("surfaces an archived Agent instead of silently keeping it selected", () => {
    botRef.current = { role: "admin", config: { ...CONFIGURED.config, agent_archived: true } };
    renderSection();
    expect(screen.getByText(/This Agent is archived/)).toBeInTheDocument();
  });

  it("asks for confirmation before deleting the configuration", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(mockDelete).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
  });

  it("reports a failed connection test with the server's message", async () => {
    const user = userEvent.setup();
    mockTest.mockResolvedValue({
      ok: false,
      error_code: "invalid_credentials",
      error_message: "app secret rejected",
    });
    renderSection();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("app secret rejected"));
  });

  it("falls back to a generic label for an error code it has never seen", async () => {
    const user = userEvent.setup();
    mockTest.mockResolvedValue({ ok: false, error_code: "teapot", error_message: null });
    renderSection();
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("The bot reported an error"));
  });
});

describe("FeishuBotSection (status)", () => {
  beforeEach(resetFixtures);

  it("shows the live status, the host Runtime and the applied revision", () => {
    statusRef.current = {
      status: "online",
      workspace_id: "workspace-1",
      enabled: true,
      revision: 4,
      desired_state: "running",
      runtime_id: "rt_1",
      runtime_name: "mac-mini",
      runtime_online: true,
      applied_revision: 4,
      bot_name: "Remi Bot",
      last_heartbeat_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
      stale_runtime_ids: [],
    };
    renderSection();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("mac-mini")).toBeInTheDocument();
    expect(screen.getByText("4 / 4")).toBeInTheDocument();
  });

  it("names the Runtimes still holding the bot during a handover", () => {
    statusRef.current = {
      status: "degraded",
      workspace_id: "workspace-1",
      enabled: true,
      revision: 5,
      desired_state: "running",
      runtime_id: "rt_1",
      runtime_name: "mac-mini",
      runtime_online: true,
      applied_revision: 4,
      bot_name: null,
      last_heartbeat_at: null,
      error_code: null,
      error_message: null,
      stale_runtime_ids: ["rt_9"],
    };
    renderSection();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText(/rt_9/)).toBeInTheDocument();
  });

  it("renders an unknown server status through the generic label instead of crashing", () => {
    statusRef.current = {
      status: "quarantined",
      workspace_id: "workspace-1",
      enabled: true,
      revision: 4,
      desired_state: "running",
      runtime_id: null,
      runtime_name: null,
      runtime_online: false,
      applied_revision: null,
      bot_name: null,
      last_heartbeat_at: null,
      error_code: null,
      error_message: null,
      stale_runtime_ids: [],
    };
    renderSection();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("shows a redacted failure with its error code", () => {
    statusRef.current = {
      status: "failed",
      workspace_id: "workspace-1",
      enabled: true,
      revision: 4,
      desired_state: "running",
      runtime_id: "rt_1",
      runtime_name: "mac-mini",
      runtime_online: true,
      applied_revision: 4,
      bot_name: null,
      last_heartbeat_at: null,
      error_code: "invalid_credentials",
      error_message: "app_secret rejected by open.feishu.cn",
      stale_runtime_ids: [],
    };
    renderSection();
    expect(screen.getByText(/Feishu rejected the App ID or App Secret/)).toBeInTheDocument();
  });
});
