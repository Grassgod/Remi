import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
  select: vi.fn(),
  agent: vi.fn(),
}));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    searchParams: state.searchParams,
    replace: state.replace,
  }),
}));
vi.mock("@multiremi/core/paths", () => ({
  useWorkspacePaths: () => ({
    chat: (session?: string, agent?: string) =>
      `/demo/chat${session ? `?session=${session}` : agent ? `?agent=${agent}` : ""}`,
  }),
}));
vi.mock("@multiremi/core/chat", () => ({
  useChatStore: Object.assign(vi.fn(), {
    getState: () => ({
      setActiveSession: state.select,
      setSelectedAgentId: state.agent,
    }),
  }),
}));
vi.mock("./chat-window", () => ({
  ChatWindow: ({
    presentation,
    onSessionChange,
  }: {
    presentation: string;
    onSessionChange: (id: string | null, agent?: string) => void;
  }) => (
    <div data-testid="chat" data-presentation={presentation}>
      <button onClick={() => onSessionChange("session-2")}>Select</button>
      <button onClick={() => onSessionChange(null, "agent-2")}>New</button>
    </div>
  ),
}));
import { ChatPage } from "./chat-page";
describe("ChatPage URL selection", () => {
  beforeEach(() => {
    state.searchParams = new URLSearchParams();
    state.replace.mockReset();
    state.select.mockReset();
    state.agent.mockReset();
  });
  it("opens a linked session in the shared conversation surface", () => {
    state.searchParams.set("session", "session-1");
    render(<ChatPage />);
    expect(state.select).toHaveBeenCalledWith("session-1");
    expect(screen.getByTestId("chat")).toHaveAttribute(
      "data-presentation",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(state.replace).toHaveBeenCalledWith("/demo/chat?session=session-2");
  });
  it("opens agent links as a new conversation and preserves the agent in navigation", () => {
    state.searchParams.set("agent", "agent-1");
    render(<ChatPage />);
    expect(state.select).toHaveBeenCalledWith(null);
    expect(state.agent).toHaveBeenCalledWith("agent-1");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(state.replace).toHaveBeenCalledWith("/demo/chat?agent=agent-2");
  });
  it("keeps the current floating-chat selection when opened without a link", () => {
    render(<ChatPage />);
    expect(state.select).not.toHaveBeenCalled();
  });
});
