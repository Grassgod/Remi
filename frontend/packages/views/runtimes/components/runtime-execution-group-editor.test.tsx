// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentRuntime } from "@multiremi/core/types";
import enRuntimes from "../../locales/en/runtimes.json";
const update = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multiremi/core/runtimes/mutations", () => ({ useUpdateRuntime: () => ({ mutateAsync: update, isPending: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";
import { RuntimeExecutionGroupEditor } from "./runtime-execution-group-editor";
function show(groupId: string | null, canEdit = true, effectiveIds: string[] = []) {
  return render(<I18nProvider locale="en" resources={{ en: { runtimes: enRuntimes } }}>
    <RuntimeExecutionGroupEditor runtime={{ id: "runtime-a", execution_group_id: groupId, execution_group_ids: effectiveIds } as AgentRuntime} canEdit={canEdit} />
  </I18nProvider>);
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("RuntimeExecutionGroupEditor", () => {
  it.each([true, false])("shows actual default group IDs with editing allowed=%s", (canEdit) => {
    show(null, canEdit, ["eg_machine_codex", "eg_machine_claude"]);
    expect(screen.getByText("eg_machine_codex")).toBeInTheDocument();
    expect(screen.getByText("eg_machine_claude")).toBeInTheDocument();
  });
  it("saves the explicit group id", async () => {
    update.mockResolvedValue({});
    show(null);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " shared-codex " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ runtimeId: "runtime-a", patch: { execution_group_id: "shared-codex" } }));
    expect(toast.success).toHaveBeenCalled();
  });
  it("clears the override to restore the default machine group", async () => {
    update.mockResolvedValue({});
    show("shared-codex");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ runtimeId: "runtime-a", patch: { execution_group_id: null } }));
  });
  it("preserves the draft after the server rejects an incompatible group", async () => {
    update.mockRejectedValue(new Error("Group provider mismatch"));
    show(null);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "claude-group" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Group provider mismatch"));
    expect(screen.getByRole("textbox")).toHaveValue("claude-group");
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("does not offer editing to a read-only viewer", () => {
    show("shared-codex", false);
    expect(screen.getByText("shared-codex")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
