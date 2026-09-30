import { forwardRef, useImperativeHandle, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import type { Issue } from "@multiremi/core/types";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import enIssues from "../../locales/en/issues.json";
import enChat from "../../locales/en/chat.json";
import enUI from "../../locales/en/ui.json";
import { NavigationProvider } from "../../navigation";

const mocks = vi.hoisted(() => ({ patch: vi.fn(), retitle: vi.fn(), upload: vi.fn(), reaction: vi.fn(), toast: vi.fn(), attachments: [] as unknown[] }));
vi.mock("@multiremi/core/api", () => ({ api: { patchIssue: mocks.patch, retitleIssue: mocks.retitle, listAttachments: async () => [] } }));
vi.mock("sonner", () => ({ toast: { success: mocks.toast, error: vi.fn() } }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "w" }));
vi.mock("@multiremi/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: () => "User" }) }));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({ useFileUpload: () => ({ uploadWithToast: mocks.upload }) }));
vi.mock("../hooks/use-issue-reactions", () => ({ useIssueReactions: () => ({ reactions: [{ id: "rx", actor_type: "member", actor_id: "u", emoji: "OK" }], toggleReaction: mocks.reaction }) }));
vi.mock("../../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <span>{content}</span>,
  FileDropOverlay: () => <span>Drop</span>,
  useFileDropZone: ({ onDrop }: { onDrop: (files: File[]) => void }) => ({ isDragOver: false,
    dropZoneProps: { onDrop: (event: React.DragEvent) => onDrop(Array.from(event.dataTransfer.files)) },
  }),
  ContentEditor: forwardRef(({ defaultValue, onUploadFile, attachments }: { defaultValue: string; onUploadFile: (file: File) => Promise<{ url: string } | null>; attachments: unknown[] }, ref) => {
    const [value, setValue] = useState(defaultValue);
    mocks.attachments = attachments;
    useImperativeHandle(ref, () => ({ getMarkdown: () => value, uploadFile: async (file: File) => {
      const result = await onUploadFile(file); if (result) setValue(previous => `${previous}\n${result.url}`);
    } }));
    return <textarea aria-label="Description editor" value={value} onChange={event => setValue(event.currentTarget.value)} />;
  }),
}));
import { IssueTitle } from "./issue-title";
import { IssueLogHead } from "./issue-log-head";

const entry = SessionLogEntrySchema.parse({ session_id: "s", id: "head", seq: 0, kind: "head", revision: 1,
  body_md: "Original description", body_html: "<p>Original description</p>", render_version: "v" });
function wrap(child: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WorkspaceSlugProvider slug="test-workspace">
      <NavigationProvider value={{ push: vi.fn(), replace: vi.fn(), back: vi.fn(), pathname: "/test-workspace/issues/i", searchParams: new URLSearchParams(), getShareableUrl: path => path }}>
        <I18nProvider locale="en" resources={{ en: { issues: enIssues, chat: enChat, ui: enUI } }}>{child}</I18nProvider>
      </NavigationProvider>
    </WorkspaceSlugProvider>
  </QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); mocks.patch.mockResolvedValue({}); mocks.upload.mockResolvedValue({ id: "att", url: "/file", filename: "file.txt" }); });
describe("MUL-444 migrated editing", () => {
  it("edits the fixed header title and preserves its full title attribute", () => {
    const update = vi.fn();
    wrap(<IssueTitle issue={{ id: "i", title: "Original title", identifier: "T-1" } as Issue} onUpdateField={update} />);
    fireEvent.click(screen.getByTitle("Original title"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated title" } });
    fireEvent.blur(screen.getByRole("textbox"));
    expect(update).toHaveBeenCalledWith({ title: "Updated title" });
  });
  it("renames with AI and the toast restores the previous title", async () => {
    mocks.retitle.mockResolvedValue({ reason: "applied", applied: true, title: "AI title", previous_title: "Original title" });
    wrap(<IssueTitle issue={{ id: "i", title: "Original title", identifier: "T-1" } as Issue} onUpdateField={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename with Luna" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    await act(async () => mocks.toast.mock.calls[0]![1].action.onClick());
    expect(mocks.patch).toHaveBeenCalledWith("i", { title: "Original title" });
  });
  it("defaults to EntryHtml and saves the description through the server before replica refill", async () => {
    const onSaved = vi.fn(async () => {});
    wrap(<IssueLogHead issueId="i" entry={entry} currentUserId="u" onSaved={onSaved} />);
    expect(document.querySelector("[data-entry-html]")?.textContent).toBe("Original description");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(mocks.patch).toHaveBeenCalledWith("i", { description: "Updated description", attachment_ids: [] });
    expect(mocks.patch.mock.invocationCallOrder[0]).toBeLessThan(onSaved.mock.invocationCallOrder[0]!);
  });
  it("falls back to the existing sanitized Markdown renderer when body_html is absent", () => {
    wrap(<IssueLogHead issueId="i" entry={{ ...entry, body_html: null }} currentUserId="u" onSaved={async () => {}} />);
    expect(document.querySelector("[data-entry-html]")).toBeNull();
    expect(screen.getByText("Original description")).toBeInTheDocument();
  });
  it.each(["button", "drop"])("uploads using %s and carries pending attachment IDs into save", async path => {
    wrap(<IssueLogHead issueId="i" entry={entry} currentUserId="u" onSaved={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const file = new File(["content"], "file.txt", { type: "text/plain" });
    if (path === "button") fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    else fireEvent.drop(screen.getByRole("textbox"), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith(file));
    await waitFor(() => expect(mocks.attachments).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith("i", { description: "Original description\n/file", attachment_ids: ["att"] }));
  });
  it("keeps reactions in the reserved row and forwards toggles", () => {
    wrap(<IssueLogHead issueId="i" entry={entry} currentUserId="u" onSaved={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "OK1" }));
    expect(mocks.reaction).toHaveBeenCalledWith("OK");
    expect(document.querySelector("[data-issue-reaction-slot]")?.className).toContain("h-8");
  });
});
