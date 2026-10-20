import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setApiInstance } from "@multiremi/core/api";
import type { ApiClient } from "@multiremi/core/api/client";
import { chatKeys } from "@multiremi/core/chat/queries";
import type { Agent } from "@multiremi/core/types";
import type { ChatSlashCommandsResponse } from "@multiremi/contracts/slash-commands";
import { useSlashCommandMenu } from "./use-slash-command-menu";

const getChatSlashCommands = vi.fn<(params: { agentId: string; sessionId?: string | null }) => Promise<ChatSlashCommandsResponse>>();
const CATALOGUE: ChatSlashCommandsResponse = {
  state: "session", provider: "claude", reported_at: null,
  commands: [{ name: "compact", description: "", hint: null, kind: "command" }],
};

const agent = (fields: Partial<Agent> = {}) =>
  ({ id: "agent-1", provider: "claude", skills: [{ id: "s1", name: "Deploy Prod", description: "" }], ...fields }) as Agent;

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
type Props = Parameters<typeof useSlashCommandMenu>[0];
function render(props: Partial<Props>) {
  const base: Props = { wsId: "ws-1", agent: agent(), sessionId: "chat-1", enabled: true };
  return renderHook((current: Props) => useSlashCommandMenu(current), { wrapper, initialProps: { ...base, ...props } });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  getChatSlashCommands.mockReset().mockResolvedValue(CATALOGUE);
  setApiInstance({ getChatSlashCommands } as unknown as ApiClient);
});

describe("useSlashCommandMenu", () => {
  it("has no menu without an agent, and a loading one while a chat's agent is not known yet", () => {
    expect(render({ agent: null }).result.current.menu).toBeNull();
    expect(render({ agent: null, agentPending: true }).result.current.menu).toMatchObject({ status: "loading", items: [] });
  });

  it("reads nothing until the menu first opens, then the chat's own catalogue", async () => {
    const { result } = render({});
    // Platform skills are there at once; the agent's commands are still to come.
    expect(result.current.menu).toMatchObject({ status: "loading", provider: "claude" });
    expect(result.current.menu?.items.map((item) => item.invocation)).toEqual(["/deploy-prod"]);
    expect(getChatSlashCommands).not.toHaveBeenCalled();

    act(() => result.current.onOpen());
    await waitFor(() => expect(result.current.menu?.status).toBe("ready"));
    expect(getChatSlashCommands).toHaveBeenCalledWith({ agentId: "agent-1", sessionId: "chat-1" });
    expect(result.current.menu?.items.map((item) => item.invocation)).toEqual(["/compact", "/deploy-prod"]);
  });

  it("uses a cached catalogue without opening the menu again", () => {
    client.setQueryData(chatKeys.slashCommands("ws-1", "agent-1", "chat-1"), CATALOGUE);
    const { result } = render({});
    expect(result.current.menu?.status).toBe("ready");
    expect(getChatSlashCommands).not.toHaveBeenCalled();
  });

  it("asks for the agent's preview in a new chat", async () => {
    getChatSlashCommands.mockResolvedValue({ ...CATALOGUE, state: "preview" });
    const { result } = render({ sessionId: null });
    act(() => result.current.onOpen());
    await waitFor(() => expect(result.current.menu?.catalogue).toBe("preview"));
    expect(getChatSlashCommands).toHaveBeenCalledWith({ agentId: "agent-1", sessionId: null });
  });

  it("reports a failed read as an error, not an empty catalogue", async () => {
    getChatSlashCommands.mockRejectedValue(new Error("boom"));
    const { result } = render({});
    act(() => result.current.onOpen());
    await waitFor(() => expect(result.current.menu?.status).toBe("error"));
    expect(result.current.menu?.catalogue).toBeNull();
  });

  it("does not carry an opened menu over to another chat", async () => {
    const view = render({});
    act(() => view.result.current.onOpen());
    await waitFor(() => expect(getChatSlashCommands).toHaveBeenCalledTimes(1));
    view.rerender({ wsId: "ws-1", agent: agent(), sessionId: "chat-2", enabled: true });
    expect(view.result.current.menu?.status).toBe("loading");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getChatSlashCommands).toHaveBeenCalledTimes(1);
  });

  it("refreshes an open chat's catalogue when a turn ends", async () => {
    const { result } = render({});
    act(() => result.current.onOpen());
    await waitFor(() => expect(result.current.menu?.status).toBe("ready"));
    getChatSlashCommands.mockResolvedValue({ ...CATALOGUE, commands: [...CATALOGUE.commands, { name: "review", description: "", hint: null, kind: "command" }] });
    // What the realtime `chat:done` handler does.
    await act(() => client.invalidateQueries({ queryKey: chatKeys.slashCommandsAll("ws-1") }));
    await waitFor(() => expect(result.current.menu?.items.map((item) => item.invocation)).toContain("/review"));
  });
});
