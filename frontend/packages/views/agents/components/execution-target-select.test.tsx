// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enAgents from "../../locales/en/agents.json";
const state = vi.hoisted(() => ({ runtimes: [] as AgentRuntime[], error: false, emptyGroup: false, shared: false }));
vi.mock("@multiremi/core/auth", () => ({ useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: "me" } }) }));
vi.mock("@multiremi/core/api", () => ({ api: { listExecutionGroups: async () => {
  if (state.error) throw new Error("unavailable");
  if (state.emptyGroup) return { groups: [{ id: "a", name: "Saved group", provider: "codex", runtime_ids: [], online_runtime_count: 0 }] };
  if (state.shared) return { groups: [{ id: "shared", name: "Shared Codex", provider: "codex", runtime_ids: state.runtimes.map((runtime) => runtime.id), online_runtime_count: 2 }] };
  return { groups: state.runtimes.flatMap((runtime) => (runtime.provider === "any" ? ["claude", "codex"] : [runtime.provider]).map((provider) => ({ id: runtime.id, name: `Machine ${runtime.id} / ${provider === "codex" ? "Codex" : provider === "claude" ? "Claude Code" : "Antigravity"}`, provider, runtime_ids: [runtime.id], online_runtime_count: runtime.status === "online" ? 1 : 0 }))) };
}, listRuntimes: async () => {
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
afterEach(() => { cleanup(); state.runtimes = []; state.error = false; state.emptyGroup = false; state.shared = false; });
describe("ExecutionTargetSelect", () => {
  it("retains Antigravity automatic and execution-group targets", async () => {
    state.runtimes = [runtime("agy", "antigravity")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "", provider: "claude" }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Machine agy \/ Antigravity/ }));
    expect(onChange).toHaveBeenLastCalledWith({ executionGroupId: "agy", provider: "antigravity" });
    fireEvent.click(screen.getByRole("button", { name: /Automatic · Antigravity/ }));
    expect(onChange).toHaveBeenLastCalledWith({ executionGroupId: "", provider: "antigravity" });
  });
  it("distinguishes two machines running the same Runtime type", async () => {
    state.runtimes = [runtime("a"), runtime("b")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "a", provider: "codex" }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Machine b \/ Codex/ }));
    expect(onChange).toHaveBeenCalledWith({ executionGroupId: "b", provider: "codex" });
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Machine a \/ Codex/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows the stable identifier below a default group name", async () => {
    state.runtimes = [runtime("eg_machine_codex")];
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "eg_machine_codex", provider: "codex" }} onChange={vi.fn()} />);
    expect(await screen.findByText("eg_machine_codex")).toHaveAttribute("title", "eg_machine_codex");
  });
  it("shows the saved target without an editor for read-only users", async () => {
    state.runtimes = [runtime("a")];
    show(<ExecutionTargetSelect wsId="ws" compact canEdit={false} value={{ executionGroupId: "a", provider: "codex" }} onChange={vi.fn()} />);
    expect(await screen.findByText("Fixed execution group · Machine a / Codex")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("keeps an offline target selectable and explains the wait", async () => {
    state.runtimes = [runtime("a", "codex", false)];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "a", provider: "codex" }} onChange={onChange} />);
    expect(await screen.findByText(enAgents.execution_target.offline)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Machine a/ })).not.toBeDisabled();
  });
  it("does not pretend an unbound agent selected the first runtime", async () => {
    state.runtimes = [runtime("a")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "", provider: "codex" }} onChange={onChange} />);
    expect(await screen.findByText(enAgents.execution_target.model_routing_hint)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("can switch from a group to model routing across machines", async () => {
    state.runtimes = [runtime("a"), runtime("b")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "a", provider: "codex" }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Model routing · Codex/ }));
    expect(onChange).toHaveBeenCalledWith({ executionGroupId: "", provider: "codex" });
  });
  it("allows choosing model routing before connecting a runtime", async () => {
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "", provider: "claude" }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Model routing · Codex/ }));
    expect(onChange).toHaveBeenCalledWith({ executionGroupId: "", provider: "codex" });
  });
  it("shows a missing saved target explicitly", async () => {
    state.runtimes = [runtime("b")];
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "gone", provider: "codex" }} onChange={vi.fn()} />);
    expect(await screen.findByText(enAgents.execution_target.unavailable)).toBeInTheDocument();
  });
  it("distinguishes empty and failed listings", async () => {
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "", provider: "" }} onChange={vi.fn()} />);
    expect(await screen.findByText(enAgents.execution_target.empty)).toBeInTheDocument();
    cleanup(); state.error = true;
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "", provider: "" }} onChange={vi.fn()} />);
    expect(await screen.findByText(enAgents.execution_target.error)).toBeInTheDocument();
  });
  it("filters private runtimes against the agent owner, not the current viewer", async () => {
    state.runtimes = [runtime("mine"), { ...runtime("owner"), owner_id: "owner" }, { ...runtime("public"), visibility: "public" }];
    show(<ExecutionTargetSelect wsId="ws" ownerId="owner" value={{ executionGroupId: "", provider: "" }} onChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Machine owner \/ Codex/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Machine public \/ Codex/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Machine mine \/ Codex/ })).toBeNull();
  });
  it("shows one option for a shared group and keeps its id as the selection", async () => {
    state.shared = true;
    state.runtimes = [runtime("a"), runtime("b")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "", provider: "" }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Shared Codex/ }));
    expect(screen.getAllByRole("button", { name: /Shared Codex/ })).toHaveLength(1);
    expect(onChange).toHaveBeenCalledWith({ executionGroupId: "shared", provider: "codex" });
  });
  it("keeps a saved empty group visible and marks it unavailable", async () => {
    state.emptyGroup = true;
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "a", provider: "codex" }} onChange={vi.fn()} />);
    expect(await screen.findByText(enAgents.execution_target.unavailable)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Saved group/ })).toBeInTheDocument();
  });
  it("explicitly selecting the current group releases a migrated legacy pin", async () => {
    state.runtimes = [runtime("a")];
    const onChange = vi.fn();
    show(<ExecutionTargetSelect wsId="ws" legacyRuntimeId="a" value={{ executionGroupId: "a", provider: "codex" }} onChange={onChange} />);
    expect(await screen.findByText(/Currently pinned to Runtime a/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Machine a \/ Codex/ }));
    expect(onChange).toHaveBeenCalledWith({ executionGroupId: "a", provider: "codex" });
  });
  it("can resolve the displayed group of a legacy machine-bound agent", async () => {
    state.runtimes = [runtime("a")];
    show(<ExecutionTargetSelect wsId="ws" legacyRuntimeId="a" value={{ executionGroupId: "", provider: "codex" }} onChange={vi.fn()} />);
    expect(await screen.findByText(/Currently pinned to Runtime a/)).toBeInTheDocument();
  });
  it("expands legacy any-provider runtimes into explicit types", async () => {
    state.runtimes = [runtime("a", "any")];
    show(<ExecutionTargetSelect wsId="ws" value={{ executionGroupId: "a", provider: "claude" }} onChange={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Machine a \/ Claude Code/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Machine a \/ Codex/ })).toBeInTheDocument();
  });
});
