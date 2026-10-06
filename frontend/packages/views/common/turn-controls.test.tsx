import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../test/i18n";
import { attemptFixture, turnFixture } from "../test/messages";
import type { AgentTask } from "@multiremi/core/types";
const api = vi.hoisted(() => ({ getTurn: vi.fn(), retryTurn: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("./task-transcript/task-trace-dialog", () => ({ TaskTraceDialog: ({ task }: { task: AgentTask }) => <div data-testid="trace">{task.turn_id}/{task.id}</div> }));
import { TurnControls } from "./turn-controls";
const mount = () => renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><TurnControls turnId="turn_1" /></QueryClientProvider>);
beforeEach(() => { vi.clearAllMocks(); api.getTurn.mockResolvedValue({ turn: turnFixture(), attempts: [attemptFixture(), attemptFixture({ id: "attempt_2", attempt_no: 2 })] }); api.retryTurn.mockResolvedValue({ turn: turnFixture({ status: "running", current_attempt_id: "attempt_3" }) }); });
describe("turn attempts", () => {
  it("defers details until expansion and opens historical logs by attempt ID", async () => {
    mount(); expect(api.getTurn).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Attempts" }));
    fireEvent.click(await screen.findByRole("button", { name: "View attempt logs #1" }));
    expect(screen.getByTestId("trace")).toHaveTextContent("turn_1/attempt_1");
    expect(screen.getByText("Current attempt")).toBeInTheDocument(); expect(api.getTurn).toHaveBeenCalledWith("turn_1", true);
  });
  it("retries the existing turn and refreshes its attempts", async () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Attempts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry turn" }));
    await waitFor(() => expect(api.retryTurn).toHaveBeenCalledWith("turn_1", false));
    await waitFor(() => expect(api.getTurn).toHaveBeenCalledTimes(2));
  });
  it("shows a conflict and leaves the retry available", async () => {
    api.retryTurn.mockRejectedValue(new Error("Turn is already running")); mount(); fireEvent.click(screen.getByRole("button", { name: "Attempts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry with a new session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already running"); expect(api.retryTurn).toHaveBeenCalledWith("turn_1", true);
  });
});
