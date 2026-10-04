import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import type { Attachment } from "@multiremi/core/types";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { NavigationProvider } from "../../navigation";
import enIssues from "../../locales/en/issues.json";
import enEditor from "../../locales/en/editor.json";
import enUI from "../../locales/en/ui.json";

const mocks = vi.hoisted(() => ({ attachments: vi.fn(), getAttachment: vi.fn(), external: vi.fn(), error: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: {
  listAttachments: mocks.attachments, getAttachment: mocks.getAttachment, getBaseUrl: () => "",
}, PreviewTooLargeError: class extends Error {}, PreviewUnsupportedError: class extends Error {} }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "w" }));
vi.mock("@multiremi/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: () => "User" }) }));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({ useFileUpload: () => ({ uploadWithToast: vi.fn() }) }));
vi.mock("../hooks/use-issue-reactions", () => ({ useIssueReactions: () => ({ reactions: [], toggleReaction: vi.fn() }) }));
vi.mock("../../platform", () => ({ openExternal: mocks.external }));
vi.mock("../../editor", async () => ({
  ReadonlyContent: (await import("../../editor/readonly-content")).ReadonlyContent,
  ContentEditor: () => null, FileDropOverlay: () => null,
  useFileDropZone: () => ({ isDragOver: false, dropZoneProps: {} }),
}));
vi.mock("../../editor/link-hover-card", () => ({ useLinkHover: () => ({}), LinkHoverCard: () => null }));
import { IssueLogHead } from "./issue-log-head";

const OLD_URL = "https://bucket.s3.amazonaws.com/report.txt?X-Amz-Signature=expired";
const NEW_URL = "https://bucket.s3.amazonaws.com/report.txt?X-Amz-Signature=fresh";
const attachment: Attachment = {
  id: "att", workspace_id: "w", issue_id: "i", comment_id: null, chat_session_id: null, chat_message_id: null,
  uploader_type: "member", uploader_id: "u", filename: "report.txt", url: OLD_URL,
  download_url: NEW_URL, content_type: "text/plain", size_bytes: 5, created_at: "2026-10-04T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attachments.mockResolvedValue([attachment]);
  mocks.getAttachment.mockResolvedValue(attachment);
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktopAPI");
});

function renderHead() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entry = SessionLogEntrySchema.parse({ session_id: "s", id: "head", seq: 0, kind: "head", revision: 1,
    body_md: `Title\n\n!file[report.txt](${OLD_URL})`, body_html: null, render_version: null, metadata: { title: "Title" } });
  render(<QueryClientProvider client={qc}><WorkspaceSlugProvider slug="test">
    <NavigationProvider value={{ pathname: "/test/issues/i", searchParams: new URLSearchParams(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), getShareableUrl: path => path }}>
      <I18nProvider locale="en" resources={{ en: { issues: enIssues, editor: enEditor, ui: enUI } }}>
        <IssueLogHead issueId="i" title="Title" entry={entry} onSaved={async () => {}} />
      </I18nProvider>
    </NavigationProvider>
  </WorkspaceSlugProvider></QueryClientProvider>);
}

describe("readonly description attachment downloads (MUL-499)", () => {
  it("loads cold metadata only on click and downloads a fresh cloud signature on desktop", async () => {
    const downloadURL = vi.fn();
    Object.defineProperty(window, "desktopAPI", { configurable: true, value: { downloadURL } });
    renderHead();
    expect(mocks.attachments).not.toHaveBeenCalled();
    expect(mocks.getAttachment).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloadURL).toHaveBeenCalledExactlyOnceWith(NEW_URL));
    expect(mocks.attachments).toHaveBeenCalledExactlyOnceWith("i");
    expect(mocks.getAttachment).toHaveBeenCalledExactlyOnceWith("att");
    expect(mocks.attachments.mock.invocationCallOrder[0]).toBeLessThan(mocks.getAttachment.mock.invocationCallOrder[0]!);
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it("uses the existing unified web download after resolving the cold attachment id", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderHead();
    expect(mocks.attachments).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(mocks.getAttachment).toHaveBeenCalledExactlyOnceWith("att");
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("/api/attachments/att/download?workspace_slug=test");
    expect(mocks.external).not.toHaveBeenCalled();
  });

  it.each(["missing", "failed"] as const)("falls back to the original URL when metadata is %s", async mode => {
    if (mode === "missing") mocks.attachments.mockResolvedValue([]);
    else mocks.attachments.mockRejectedValue(new Error("metadata unavailable"));
    renderHead();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(mocks.external).toHaveBeenCalledExactlyOnceWith(OLD_URL));
    expect(mocks.getAttachment).not.toHaveBeenCalled();
  });
});
