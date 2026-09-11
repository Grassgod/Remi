import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enChat from "../../locales/en/chat.json";
const actions = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
  prioritize: vi.fn(),
}));
vi.mock("@multiremi/core/chat/mutations", () => ({
  useUpdateChatQueuedTask: () => ({
    mutateAsync: actions.update,
    isPending: false,
  }),
  useRemoveChatQueuedTask: () => ({
    mutateAsync: actions.remove,
    isPending: false,
  }),
  useClearChatQueue: () => ({ mutateAsync: actions.clear, isPending: false }),
  usePrioritizeChatQueuedTask: () => ({
    mutateAsync: actions.prioritize,
    isPending: false,
  }),
}));
import { ChatQueue } from "./chat-queue";
const task = {
  task_id: "task-2",
  content: "Follow up",
  attachment_ids: [],
  created_at: new Date(0).toISOString(),
};
function mount() {
  return render(
    <I18nProvider locale="en" resources={{ en: { chat: enChat } }}>
      <ChatQueue sessionId="session-1" tasks={[task]} />
    </I18nProvider>,
  );
}
describe("ChatQueue", () => {
  beforeEach(() => {
    Object.values(actions).forEach((action) =>
      action.mockReset().mockResolvedValue(undefined),
    );
  });
  it("keeps an edited message available after a failed save", async () => {
    actions.update.mockRejectedValueOnce(new Error("offline"));
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Updated instruction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox")).toHaveValue("Updated instruction");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(actions.update).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      taskId: "task-2",
      content: "Updated instruction",
    });
  });
  it("prioritizes, removes and clears using server queue commands", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Run now (stops the current run)" }),
    );
    await waitFor(() =>
      expect(actions.prioritize).toHaveBeenCalledWith({
        sessionId: "session-1",
        taskId: "task-2",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove queued message" }),
    );
    await waitFor(() =>
      expect(actions.remove).toHaveBeenCalledWith({
        sessionId: "session-1",
        taskId: "task-2",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
    await waitFor(() =>
      expect(actions.clear).toHaveBeenCalledWith("session-1"),
    );
  });
});
