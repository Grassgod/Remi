import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { WorkspaceSlugProvider } from "@multiremi/core/paths";
import type { Attachment } from "@multiremi/core/types";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { issueKeys } from "@multiremi/core/issues/queries";
import { NavigationProvider } from "../../navigation";
import enIssues from "../../locales/en/issues.json";
import enEditor from "../../locales/en/editor.json";
import enUI from "../../locales/en/ui.json";

const mocks = vi.hoisted(() => ({ attachments: vi.fn(), download: vi.fn(), error: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: { listAttachments: mocks.attachments },
  PreviewTooLargeError: class extends Error {}, PreviewUnsupportedError: class extends Error {} }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "w" }));
vi.mock("@multiremi/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: () => "User" }) }));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({ useFileUpload: () => ({ uploadWithToast: vi.fn() }) }));
vi.mock("../hooks/use-issue-reactions", () => ({ useIssueReactions: () => ({ reactions: [], toggleReaction: vi.fn() }) }));
vi.mock("../../editor", async () => ({
  ReadonlyContent: (await import("../../editor/readonly-content")).ReadonlyContent,
  ContentEditor: () => null, FileDropOverlay: () => null,
  useFileDropZone: () => ({ isDragOver: false, dropZoneProps: {} }),
}));
vi.mock("../../editor/use-download-attachment", () => ({ useDownloadAttachment: () => mocks.download }));
vi.mock("../../editor/link-hover-card", () => ({ useLinkHover: () => ({}), LinkHoverCard: () => null }));
vi.mock("../../editor/mermaid-diagram", () => ({ MermaidDiagram: ({ chart }: { chart: string }) => <div data-testid="diagram">{chart}</div> }));
vi.mock("./issue-mention-card", () => ({ IssueMentionCard: ({ issueId }: { issueId: string }) => <span data-testid="mention">{issueId}</span> }));
import { IssueLogHead } from "./issue-log-head";

const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
beforeEach(() => { vi.clearAllMocks(); mocks.attachments.mockResolvedValue([]); });
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

function renderHead(description: string, cachedAttachment = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedAttachment) qc.setQueryData(issueKeys.attachments("i"), [{
    id: "att", workspace_id: "w", issue_id: "i", comment_id: null, chat_session_id: null, chat_message_id: null,
    uploader_type: "member", uploader_id: "u", filename: "report.txt", url: "/uploads/report.txt",
    download_url: "/uploads/report.txt", content_type: "text/plain", size_bytes: 5, created_at: "2026-10-03T00:00:00Z",
  } satisfies Attachment]);
  const entry = SessionLogEntrySchema.parse({ session_id: "s", id: "head", seq: 0, kind: "head", revision: 1,
    body_md: `Title\n\n${description}`, body_html: "<p>Title</p><p>Stale rendered description</p>",
    render_version: "test", metadata: { title: "Title" } });
  return render(<QueryClientProvider client={qc}><WorkspaceSlugProvider slug="test">
    <NavigationProvider value={{ pathname: "/test/issues/i", searchParams: new URLSearchParams(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), getShareableUrl: path => path }}>
      <I18nProvider locale="en" resources={{ en: { issues: enIssues, editor: enEditor, ui: enUI } }}>
        <IssueLogHead issueId="i" title="Title" entry={entry} onSaved={async () => {}} />
      </I18nProvider>
    </NavigationProvider>
  </WorkspaceSlugProvider></QueryClientProvider>);
}

describe("head uses the shared Markdown renderer", () => {
  it("renders images and mentions without a blocking attachment query or the title HTML", () => {
    renderHead("![Screenshot](/files/image.png)\n\n[@MUL-1](mention://issue/other)");
    expect(screen.getByRole("img", { name: "Screenshot" })).toHaveAttribute("src", "/files/image.png");
    expect(screen.getByTestId("mention")).toHaveTextContent("other");
    expect(screen.getAllByText("Title")).toHaveLength(1);
    expect(screen.queryByText("Stale rendered description")).toBeNull();
    expect(mocks.attachments).not.toHaveBeenCalled();
  });

  it("uses cached issue attachments for the shared file-card download", () => {
    renderHead("!file[report.txt](/uploads/report.txt)", true);
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(mocks.download).toHaveBeenCalledWith("att");
    expect(mocks.attachments).not.toHaveBeenCalled();
  });

  it.each([
    [true, "absent"], [false, "absent"], [true, "denied"],
  ] as const)("copies literal code with the http fallback, success=%s clipboard=%s", async (success, mode) => {
    vi.stubGlobal("navigator", { clipboard: mode === "absent" ? undefined : { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const exec = vi.fn(() => {
      expect(document.querySelector("textarea")?.value).toBe("const value = '<literal>';");
      return success;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    const { container } = renderHead("```js\nconst value = '<literal>';\n```");
    const button = screen.getByRole("button", { name: "Copy code" });
    expect(container.querySelector("pre code")?.textContent).toBe("const value = '<literal>';");
    fireEvent.click(button);
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    await waitFor(() => expect(button).toHaveAttribute("data-code-copied", String(success)));
    expect(document.querySelector("textarea")).toBeNull();
    expect(mocks.error).toHaveBeenCalledTimes(success ? 0 : 1);
  });

  it("keeps Mermaid source copy without restoring its pre wrapper", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: write } });
    const { container } = renderHead("```mermaid\ngraph LR\n  A --> B\n```");
    expect(screen.getByTestId("diagram")).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(write).toHaveBeenCalledWith("graph LR\n  A --> B"));
  });
});
