import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multiremi/core/api";
import type { ApiClient } from "@multiremi/core/api/client";
import { agentTaskSnapshotKeys } from "@multiremi/core/agents/queries";
import type { Agent, AgentTask, FleetModelsResponse } from "@multiremi/core/types";
import { useChatModel } from "./use-chat-model";

const gate = vi.hoisted(() => ({ open: true }));
vi.mock("@multiremi/core/platform/use-after-first-screen", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/platform/use-after-first-screen")>(),
  useAfterFirstScreen: () => gate.open,
}));

const listFleetModels = vi.fn<() => Promise<FleetModelsResponse>>();
const getAgentTaskSnapshot = vi.fn<() => Promise<AgentTask[]>>();
const CATALOG: FleetModelsResponse = { providers: [{
  provider: "claude", online_runtime_count: 1,
  models: [
    { id: "claude-opus-4-1", label: "Opus 4.1", thinking: { status: "supported", supported_levels: [{ value: "high", label: "High" }] } },
    { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  ],
}] };

const agent = (fields: Partial<Agent> = {}) =>
  ({ id: "agent-1", provider: "claude", model: "claude-opus-4-1", thinking_level: "high", ...fields }) as Agent;

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
type Props = Parameters<typeof useChatModel>[0];
function render(props: Partial<Props>) {
  const base: Props = { wsId: "ws-1", agent: agent(), sessionId: "chat-1", pendingTask: null, enabled: true };
  const seen: Array<ReturnType<typeof useChatModel>> = [];
  const view = renderHook((current: Props) => {
    const value = useChatModel(current);
    seen.push(value);
    return value;
  }, { wrapper, initialProps: { ...base, ...props } });
  return { ...view, seen, base };
}

beforeEach(() => {
  gate.open = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  listFleetModels.mockReset().mockResolvedValue(CATALOG);
  getAgentTaskSnapshot.mockReset().mockResolvedValue([]);
  setApiInstance({ listFleetModels, getAgentTaskSnapshot } as unknown as ApiClient);
});

describe("useChatModel", () => {
  it("shows nothing and reads nothing without an agent", () => {
    const { result } = render({ agent: null });
    expect(result.current).toBeNull();
    expect(listFleetModels).not.toHaveBeenCalled();
  });

  it("stays out until the catalog answers, then appears once with its label and effort", async () => {
    let answer!: (value: FleetModelsResponse) => void;
    listFleetModels.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const { result, seen } = render({});
    expect(result.current).toBeNull();
    await act(async () => answer(CATALOG));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual({ modelId: "claude-opus-4-1", label: "Opus 4.1", effort: "High", fallback: false });
    // No raw-id frame before the label: the chip never changes its text on arrival.
    expect(seen.filter(Boolean).every((value) => value?.label === "Opus 4.1")).toBe(true);
    expect(listFleetModels).toHaveBeenCalledTimes(1);
  });

  it("waits for the first screen before reading the catalog", async () => {
    gate.open = false;
    const { result, rerender, base } = render({});
    expect(result.current).toBeNull();
    expect(listFleetModels).not.toHaveBeenCalled();
    gate.open = true;
    rerender(base);
    await waitFor(() => expect(result.current?.label).toBe("Opus 4.1"));
  });

  it("names the default model without a catalog read", () => {
    const { result } = render({ agent: agent({ model: "", thinking_level: "" }) });
    expect(result.current).toEqual({ modelId: null, label: null, effort: null, fallback: false });
    expect(listFleetModels).not.toHaveBeenCalled();
  });

  it("falls back to the raw id when the catalog cannot be read", async () => {
    listFleetModels.mockRejectedValue(new Error("down"));
    const { result } = render({ agent: agent({ thinking_level: "" }) });
    await waitFor(() => expect(result.current).toEqual({ modelId: "claude-opus-4-1", label: null, effort: null, fallback: false }));
  });

  it("shows the fallback model of the running turn from the cached task snapshot, without fetching it", async () => {
    client.setQueryData(agentTaskSnapshotKeys.list("ws-1"), [{
      id: "att-2", turn_id: "turn-1", chat_session_id: "chat-1", agent_id: "agent-1", status: "running",
      fallback_switched: true, execution_model: "claude-sonnet-4-5",
    } as AgentTask]);
    const { result } = render({ pendingTask: { task_id: "att-2", turn_id: "turn-1" } });
    await waitFor(() => expect(result.current).toEqual({ modelId: "claude-sonnet-4-5", label: "Sonnet 4.5", effort: null, fallback: true }));
    expect(getAgentTaskSnapshot).not.toHaveBeenCalled();
  });
});
