import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";
import { messageFixture } from "../../test/messages";
const mock = vi.hoisted(() => ({ listMessages: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: mock }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
import { ChatQueue } from "./chat-queue";
const message = messageFixture({ session_id: "chat_1", sender_type: "member", body_md: "Follow up" });
function mount() { return renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><ChatQueue sessionId="chat_1" agentId="agent_1" /></QueryClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); mock.listMessages.mockResolvedValue({ messages: [message], next_cursor: null }); mock.editMessage.mockResolvedValue(message); mock.deleteMessage.mockResolvedValue(message); });
describe("unread Chat messages", () => {
  it("uses the agent unread cursor and has edit/delete without prioritize", async () => {
    mount(); await screen.findByText("Follow up");
    expect(mock.listMessages).toHaveBeenCalledWith("chat_1", { unread_by: "agent_1", cursor: undefined, limit: 100 });
    expect(screen.queryByRole("button", { name: /Run now|Clear queue/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
    await waitFor(() => expect(mock.deleteMessage).toHaveBeenCalledWith("msg_1"));
  });
  it("keeps the edited draft after a consumption conflict and allows a retry", async () => {
    mock.editMessage.mockRejectedValueOnce(new Error("consumed")); mount(); await screen.findByText("Follow up");
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated instruction" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert"); expect(screen.getByRole("textbox")).toHaveValue("Updated instruction");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(mock.editMessage).toHaveBeenLastCalledWith("msg_1", "Updated instruction");
  });
  it("cancels a local edit without sending a mutation", async () => {
    mount(); await screen.findByText("Follow up"); fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "discard" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Follow up")).toBeInTheDocument(); expect(mock.editMessage).not.toHaveBeenCalled();
  });
  it("retains the draft when a consumption conflict removes the row on refetch", async () => {
    mock.editMessage.mockImplementation(async () => {
      mock.listMessages.mockResolvedValue({ messages: [], next_cursor: null });
      throw new Error("consumed");
    });
    mount(); await screen.findByText("Follow up");
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Your draft is kept here/);
    expect(screen.getByRole("textbox")).toHaveValue("Keep my draft");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
