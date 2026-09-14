// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
const state = vi.hoisted(() => ({ runtimes: [] as AgentRuntime[], error: false }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "me" } }) }));
vi.mock("@multiremi/core/api", () => ({ api: { listRuntimes: async () => {
  if (state.error) throw new Error("unavailable");
  return state.runtimes;
} } }));
vi.mock("../../runtimes/components/provider-logo", () => ({ ProviderLogo: () => null }));
import { ExecutionTargetSelect } from "./execution-target-select";
function runtime(id: string, provider = "codex", online = true): AgentRuntime {
  return { id, provider, owner_id: "me", visibility: "private", name: id, daemon_display_name: `Machine ${id}`, status: online ? "online" : "offline", last_seen_at: new Date().toISOString() } as AgentRuntime;
}
function show(node: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider locale="en" resources={{ en: { common: enCommon, agents: enAgents } }}>{node}</I18nProvider>
  </QueryClientProvider>);
}
afterEach(() => { cleanup(); state.runtimes = []; state.error = false; });
describe("ExecutionTargetSelect", () => {
  it("distinguishes two machines running the same Runtime type", async () => {
    state.runtimes = [runtime("a"), runtime("b")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ runtimeId: "a", provider: "codex" }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Machine b / Codex" }));
    expect(onChange).toHaveBeenCalledWith({ runtimeId: "b", provider: "codex" });
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Machine a / Codex" }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows the saved target without an editor for read-only users", async () => {
    state.runtimes = [runtime("a")];
    show(<ExecutionTargetSelect wsId="ws" compact canEdit={false} value={{ runtimeId: "a", provider: "codex" }} onChange={vi.fn()} />);
    expect(await screen.findByText("Machine a / Codex")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps an offline target selectable and explains the wait", async () => {
    state.runtimes = [runtime("a", "codex", false)];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ runtimeId: "a", provider: "codex" }} onChange={onChange} />);
    expect(await screen.findByText(enAgents.execution_target.offline)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Machine a/ })).not.toBeDisabled();
  });
  it("does not pretend an unbound agent selected the first runtime", async () => {
    state.runtimes = [runtime("a")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ runtimeId: "", provider: "codex" }} onChange={onChange} />);
    expect(await screen.findByText(enAgents.execution_target.placeholder)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows a missing saved target explicitly", async () => {
    state.runtimes = [runtime("b")];
    show(<ExecutionTargetSelect wsId="ws" value={{ runtimeId: "gone", provider: "codex" }} onChange={vi.fn()} />);
    expect(await screen.findByText(enAgents.execution_target.unavailable)).toBeInTheDocument();
  });
  it("distinguishes empty and failed listings", async () => {
    show(<ExecutionTargetSelect wsId="ws" value={{ runtimeId: "", provider: "" }} onChange={vi.fn()} />);
    expect(await screen.findByText(enAgents.execution_target.empty)).toBeInTheDocument();
    cleanup(); state.error = true;
    show(<ExecutionTargetSelect wsId="ws" value={{ runtimeId: "", provider: "" }} onChange={vi.fn()} />);
    expect(await screen.findByText(enAgents.execution_target.error)).toBeInTheDocument();
  });
  it("filters private runtimes against the agent owner, not the current viewer", async () => {
    state.runtimes = [runtime("mine"), { ...runtime("owner"), owner_id: "owner" }, { ...runtime("public"), visibility: "public" }];
    show(<ExecutionTargetSelect wsId="ws" ownerId="owner" value={{ runtimeId: "", provider: "" }} onChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Machine owner / Codex" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Machine public / Codex" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Machine mine / Codex" })).toBeNull();
  });
  it("expands legacy any-provider runtimes into explicit types", async () => {
    state.runtimes = [runtime("a", "any")];
    show(<ExecutionTargetSelect wsId="ws" value={{ runtimeId: "a", provider: "claude" }} onChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Machine a / Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Machine a / Codex" })).toBeInTheDocument();
  });
});
