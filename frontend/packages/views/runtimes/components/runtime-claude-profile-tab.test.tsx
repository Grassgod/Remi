// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import enRuntimes from "../../locales/en/runtimes.json";
import { RuntimeProviderProfileTab } from "./runtime-provider-profile-tab";

const api = vi.hoisted(() => ({ getRuntimeClaudeProfile: vi.fn(), setRuntimeClaudeProfile: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-profile" }));
const runtime = { id: "rt-profile", provider: "claude", metadata: { claude_profiles: 1 } } as unknown as AgentRuntime;
const saved = { name: "private", base_url: "https://custom.example/v1", model: "custom-model", env_key: "", auth_mode: "api_key", auth_header: "bearer", credential_id: "rck_private" };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.getRuntimeClaudeProfile.mockResolvedValue({ profile: null });
  api.setRuntimeClaudeProfile.mockImplementation(async (_id, input) => {
    const result = { profile: input.profile ? { ...input.profile, credential_id: "rck_private" } : null };
    api.getRuntimeClaudeProfile.mockResolvedValue(result);
    return result;
  });
});
function show(value = runtime, canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<RuntimeProviderProfileTab provider="claude" runtime={value} canManage={canManage} />, { wrapper: ({ children }) => <I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}><QueryClientProvider client={client}>{children}</QueryClientProvider></I18nProvider> });
}

it("saves the URL, model and key, then clears the password input without exposing the saved value", async () => {
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole("switch"));
  await user.type(screen.getByLabelText("API base URL"), saved.base_url);
  await user.type(screen.getByLabelText("Model ID"), saved.model);
  await user.type(screen.getByLabelText("API key"), "new-test-key");
  await user.selectOptions(screen.getByLabelText("Request authentication"), "x-api-key");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.setRuntimeClaudeProfile).toHaveBeenCalledWith(runtime.id, { profile: { name: "custom", base_url: saved.base_url, model: saved.model, env_key: "", auth_mode: "api_key", auth_header: "x-api-key" }, api_key: "new-test-key" }));
  await waitFor(() => expect(screen.getByLabelText("API key")).toHaveValue(""));
  expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  expect(screen.queryByText("new-test-key")).not.toBeInTheDocument();
});

it("keeps an existing key when omitted, supports environment credentials, and restores inheritance", async () => {
  const user = userEvent.setup();
  api.getRuntimeClaudeProfile.mockResolvedValue({ profile: saved });
  show();
  await screen.findByLabelText("API key");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.setRuntimeClaudeProfile).toHaveBeenLastCalledWith(runtime.id, { profile: saved }));
  await waitFor(() => expect(screen.getByLabelText("Authentication")).toBeEnabled());
  await user.selectOptions(screen.getByLabelText("Authentication"), "env");
  expect(screen.getByLabelText("API key environment variable")).toHaveValue("REMI_CLAUDE_API_KEY");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.setRuntimeClaudeProfile).toHaveBeenLastCalledWith(runtime.id, { profile: { ...saved, auth_mode: "env", env_key: "REMI_CLAUDE_API_KEY" } }));
  await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
  await user.click(screen.getByRole("switch"));
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(api.setRuntimeClaudeProfile).toHaveBeenLastCalledWith(runtime.id, { profile: null }));
});

it("retains input on a server error and blocks editing for viewers or old Runtimes", async () => {
  const user = userEvent.setup();
  api.getRuntimeClaudeProfile.mockResolvedValue({ profile: saved });
  api.setRuntimeClaudeProfile.mockRejectedValue(new Error("Server encryption key is unavailable"));
  const view = show();
  await screen.findByLabelText("API key");
  await user.type(screen.getByLabelText("API key"), "retry-key");
  await user.click(screen.getByRole("button", { name: "Save connection" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Server encryption key is unavailable");
  expect(screen.getByLabelText("API key")).toHaveValue("retry-key");
  view.unmount();
  const viewer = show(runtime, false);
  expect(await screen.findByRole("switch")).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("button", { name: "Save connection" })).not.toBeInTheDocument();
  viewer.unmount();
  show({ ...runtime, metadata: {} });
  expect(await screen.findByRole("switch")).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText(/Update and restart this Runtime/)).toBeInTheDocument();
});
