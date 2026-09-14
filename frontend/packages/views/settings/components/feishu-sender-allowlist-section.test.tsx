import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockApi = vi.hoisted(() => ({
  getFeishuBot: vi.fn(),
  listFeishuBotSenders: vi.fn(),
  updateFeishuBotSender: vi.fn(),
}));
const workspace = vi.hoisted(() => ({ id: "workspace-1" }));

vi.mock("@multiremi/core/api", () => ({ api: mockApi }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => workspace.id }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { FeishuSenderAllowlistSection } from "./feishu-sender-allowlist-section";

const PENDING = {
  id: "sender-1", app_id: "cli_bot", display_name: "Alice", open_id: "ou_alice",
  union_id: "on_alice", allowed: false,
  first_seen_at: "2026-09-12T02:00:00Z", last_seen_at: "2026-09-13T02:00:00Z",
};
const ALLOWED = { ...PENDING, id: "sender-2", display_name: "Bob", open_id: "ou_bob", union_id: null, allowed: true };
const clients: QueryClient[] = [];

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <I18nProvider locale="en" resources={{ en: { common: enCommon, settings: enSettings } }}>
          {children}
        </I18nProvider>
      </QueryClientProvider>
    );
  }
  return render(<FeishuSenderAllowlistSection />, { wrapper: Wrapper });
}

it("shows resolved bilingual names and expandable identifiers", async () => {
  mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [{ ...PENDING, display_name: "陈测试", name_en: "Test Chen" }] });
  renderSection();
  expect(await screen.findByText("陈测试")).toBeInTheDocument();
  expect(screen.getByText("Test Chen")).toBeInTheDocument();
  expect(screen.getByText("Open ID:")).toBeInTheDocument();
  await userEvent.click(screen.getByText("More account identifiers"));
  expect(screen.getByText("Union ID: on_alice")).toBeVisible();
});

it("replaces generic Feishu User placeholders with distinguishable account labels", async () => {
  mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [{ ...PENDING, display_name: "Feishu User" }] });
  renderSection();
  expect(await screen.findByText("Feishu account · ou_alice")).toBeInTheDocument();
  expect(screen.queryByText("Feishu User")).not.toBeInTheDocument();
});

beforeEach(() => {
  vi.resetAllMocks();
  workspace.id = "workspace-1";
  mockApi.getFeishuBot.mockResolvedValue({ role: "admin", config: { configured: true, app_id: "cli_bot" } });
  mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [PENDING, ALLOWED] });
  mockApi.updateFeishuBotSender.mockResolvedValue({ ...PENDING, allowed: true });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

describe("FeishuSenderAllowlistSection", () => {
  it("shows discovered accounts, their request time and authorization without a member picker", async () => {
    renderSection();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    const pending = screen.getByRole("listitem", { name: "Alice" });
    expect(within(pending).getByText("ou_alice")).toBeInTheDocument();
    expect(within(pending).getByText("Pending authorization")).toBeInTheDocument();
    expect(within(pending).getByText(/Last request:/)).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "Bob" })).getByText("Allowed")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(mockApi.listFeishuBotSenders).toHaveBeenCalledWith("workspace-1");
  });

  it("waits for authorization to succeed before refreshing the account state", async () => {
    let resolveUpdate!: (value: typeof PENDING) => void;
    mockApi.updateFeishuBotSender.mockImplementation(() => new Promise((resolve) => { resolveUpdate = resolve; }));
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("Alice");
    await user.click(within(screen.getByRole("listitem", { name: "Alice" })).getByRole("button", { name: "Add to allowlist" }));
    expect(mockApi.updateFeishuBotSender).toHaveBeenCalledWith("workspace-1", "sender-1", { allowed: true });
    expect(within(screen.getByRole("listitem", { name: "Alice" })).getByText("Pending authorization")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [{ ...PENDING, allowed: true }, ALLOWED] });
    await act(async () => resolveUpdate({ ...PENDING, allowed: true }));
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "Alice" })).getByText("Allowed")).toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith("Account added to the allowlist");
  });

  it("removes an account from the allowlist", async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("Bob");
    mockApi.updateFeishuBotSender.mockResolvedValue({ ...ALLOWED, allowed: false });
    mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [PENDING, { ...ALLOWED, allowed: false }] });
    await user.click(within(screen.getByRole("listitem", { name: "Bob" })).getByRole("button", { name: "Remove from allowlist" }));
    expect(mockApi.updateFeishuBotSender).toHaveBeenCalledWith("workspace-1", "sender-2", { allowed: false });
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "Bob" })).getByText("Pending authorization")).toBeInTheDocument());
  });

  it("keeps the previous state and reports a failed authorization", async () => {
    mockApi.updateFeishuBotSender.mockRejectedValue(new Error("Request rejected"));
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("Alice");
    await user.click(within(screen.getByRole("listitem", { name: "Alice" })).getByRole("button", { name: "Add to allowlist" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Request rejected"));
    expect(within(screen.getByRole("listitem", { name: "Alice" })).getByText("Pending authorization")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows a load failure instead of an empty allowlist and can refresh", async () => {
    mockApi.listFeishuBotSenders.mockRejectedValue(new Error("Could not fetch accounts"));
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load Feishu accounts");
    expect(screen.queryByText(/No accounts discovered yet/)).not.toBeInTheDocument();
    mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [PENDING] });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an empty state only after successfully loading no discovered accounts", async () => {
    mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [] });
    renderSection();
    expect(await screen.findByText(/No accounts discovered yet/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries a failed bot configuration lookup before fetching accounts", async () => {
    mockApi.getFeishuBot.mockRejectedValue(new Error("Unable to load bot"));
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load Feishu accounts");
    expect(mockApi.listFeishuBotSenders).not.toHaveBeenCalled();
    mockApi.getFeishuBot.mockResolvedValue({ role: "admin", config: { configured: true, app_id: "cli_bot" } });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Alice")).toBeInTheDocument();
  });

  it("hides cached accounts from a previous bot app", async () => {
    mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [PENDING, { ...ALLOWED, app_id: "cli_previous" }] });
    renderSection();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
  });

  it("shows a loading state while accounts are being fetched", async () => {
    mockApi.listFeishuBotSenders.mockImplementation(() => new Promise(() => {}));
    renderSection();
    expect(await screen.findByText("Loading accounts…")).toBeInTheDocument();
    expect(screen.queryByText(/No accounts discovered yet/)).not.toBeInTheDocument();
  });

  it("does not fetch accounts when the bot response grants no configuration access", async () => {
    mockApi.getFeishuBot.mockResolvedValue({ role: "member", availability: { configured: true } });
    const { container } = renderSection();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(mockApi.listFeishuBotSenders).not.toHaveBeenCalled();
  });

  it("requires a configured bot before discovering accounts", async () => {
    mockApi.getFeishuBot.mockResolvedValue({ role: "admin", config: { configured: false, app_id: "" } });
    renderSection();
    expect(await screen.findByText("Configure the Feishu bot above to discover incoming accounts.")).toBeInTheDocument();
    expect(mockApi.listFeishuBotSenders).not.toHaveBeenCalled();
  });

  it("does not show one space's accounts after switching spaces", async () => {
    const view = renderSection();
    await screen.findByText("Alice");
    workspace.id = "workspace-2";
    mockApi.listFeishuBotSenders.mockResolvedValue({ senders: [{ ...ALLOWED, display_name: "Carol" }] });
    view.rerender(<FeishuSenderAllowlistSection />);
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
    expect(await screen.findByText("Carol")).toBeInTheDocument();
    expect(mockApi.listFeishuBotSenders).toHaveBeenLastCalledWith("workspace-2");
  });
});
