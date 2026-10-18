import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
const state = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
  replaceUrl: undefined as undefined | ((path: string) => void),
  select: vi.fn(),
  agent: vi.fn(),
  window: {} as { initialLog?: unknown; initialSessionId?: string },
}));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    searchParams: state.searchParams,
    replace: state.replace,
    replaceUrl: state.replaceUrl,
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
    initialLog,
    initialSessionId,
  }: {
    presentation: string;
    onSessionChange: (id: string | null, agent?: string) => void;
    initialLog?: unknown;
    initialSessionId?: string;
  }) => {
    state.window = { initialLog, initialSessionId };
    return (
      <div data-testid="chat" data-presentation={presentation}>
        <button onClick={() => onSessionChange("session-2")}>Select</button>
        <button onClick={() => onSessionChange(null, "agent-2")}>New</button>
        <button onClick={() => onSessionChange(null)}>Blank</button>
      </div>
    );
  },
}));
import { ChatPage } from "./chat-page";

const bootstrap = (sessionId: string) =>
  ({ sessionId, window: { entries: [] }, head: null }) as unknown as IssueLogBootstrap;
// The adapter changes the address without a route render: the page keeps the
// props the server rendered while searchParams follow the new URL.
const urlOnly = vi.fn((path: string) => {
  state.searchParams = new URLSearchParams(path.split("?")[1] ?? "");
});

describe("ChatPage URL selection", () => {
  beforeEach(() => {
    state.searchParams = new URLSearchParams();
    state.replace.mockReset();
    state.replaceUrl = undefined;
    urlOnly.mockClear();
    state.select.mockReset();
    state.agent.mockReset();
    state.window = {};
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
    expect(state.replace).toHaveBeenCalledWith("/demo/chat?session=session-2", { scroll: false });
  });
  it("opens agent links as a new conversation and preserves the agent in navigation", () => {
    state.searchParams.set("agent", "agent-1");
    render(<ChatPage />);
    expect(state.select).toHaveBeenCalledWith(null);
    expect(state.agent).toHaveBeenCalledWith("agent-1");
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(state.replace).toHaveBeenCalledWith("/demo/chat?agent=agent-2", { scroll: false });
  });
  it("keeps the current floating-chat selection when opened without a link", () => {
    render(<ChatPage />);
    expect(state.select).not.toHaveBeenCalled();
  });
  it("replaces only the URL when switching chats on a platform that supports it", () => {
    state.replaceUrl = urlOnly;
    state.searchParams.set("session", "session-1");
    render(<ChatPage initialSessionId="session-1" initialLog={bootstrap("session-1")} />);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(urlOnly.mock.calls).toEqual([
      ["/demo/chat?session=session-2"],
      ["/demo/chat?agent=agent-2"],
    ]);
    expect(state.replace).not.toHaveBeenCalled();
  });
  it("seeds the log from the route until the page replaces its own URL", () => {
    state.replaceUrl = urlOnly;
    state.searchParams.set("session", "session-1");
    const log = bootstrap("session-1");
    const { rerender } = render(<ChatPage initialSessionId="session-1" initialLog={log} />);
    expect(state.window).toEqual({ initialLog: log, initialSessionId: "session-1" });

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    rerender(<ChatPage initialSessionId="session-1" initialLog={log} />);
    // The route still holds session-1's read; returning to it must not reseed
    // its log from that older window.
    expect(state.window).toEqual({ initialLog: undefined, initialSessionId: "session-2" });
    expect(state.select).toHaveBeenLastCalledWith("session-2");
  });
  it("opens a new chat after a URL-only replacement instead of the route's session", () => {
    state.replaceUrl = urlOnly;
    state.searchParams.set("session", "session-1");
    const log = bootstrap("session-1");
    const { rerender } = render(<ChatPage initialSessionId="session-1" initialLog={log} />);

    fireEvent.click(screen.getByRole("button", { name: "Blank" }));
    expect(urlOnly).toHaveBeenCalledWith("/demo/chat");
    rerender(<ChatPage initialSessionId="session-1" initialLog={log} />);
    expect(state.window).toEqual({ initialLog: undefined, initialSessionId: undefined });
    expect(state.select).toHaveBeenLastCalledWith(null);
  });
  it("follows the URL when a back navigation restores an older route render", () => {
    // Loaded with ?session=session-1, then a new chat replaced the URL only;
    // going back to it remounts the page with the render it was loaded with.
    state.searchParams = new URLSearchParams("agent=agent-2");
    render(<ChatPage initialSessionId="session-1" initialLog={bootstrap("session-1")} />);
    expect(state.select).toHaveBeenCalledTimes(1);
    expect(state.select).toHaveBeenCalledWith(null);
    expect(state.agent).toHaveBeenCalledWith("agent-2");
    expect(state.window.initialSessionId).toBeUndefined();
  });
  it("uses the route's props again once the server renders another session", () => {
    state.replaceUrl = urlOnly;
    state.searchParams.set("session", "session-1");
    const { rerender } = render(<ChatPage initialSessionId="session-1" initialLog={bootstrap("session-1")} />);
    fireEvent.click(screen.getByRole("button", { name: "Blank" }));
    rerender(<ChatPage initialSessionId="session-1" initialLog={bootstrap("session-1")} />);

    // A real navigation (e.g. a link to another chat) renders the route again.
    state.searchParams = new URLSearchParams("session=session-3");
    const next = bootstrap("session-3");
    rerender(<ChatPage initialSessionId="session-3" initialLog={next} />);
    expect(state.window).toEqual({ initialLog: next, initialSessionId: "session-3" });
  });
});
