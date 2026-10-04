import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@multiremi/core/types";
import type { SessionLogEntry } from "@multiremi/core/replica";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { preprocessFileCards } from "@multiremi/ui/markdown";
import { EntryHtml } from "./entry-html";
import { entryAttachments } from "./entry-attachments";
import { ReadonlyContent } from "../../editor/readonly-content";
import { AttachmentList } from "../../issues/components/comment-card";
import FILE_CARD_CASES from "../../../../../tests/unit/multiremi/file-card-fixtures.json";
import enChat from "../../locales/en/chat.json";
import enEditor from "../../locales/en/editor.json";
import enUI from "../../locales/en/ui.json";

const { download, openByUrl, tryOpen } = vi.hoisted(() => ({
  download: vi.fn(), openByUrl: vi.fn(), tryOpen: vi.fn(),
}));
vi.mock("../../editor/use-download-attachment", () => ({ useDownloadAttachment: () => download }));
vi.mock("../../editor/attachment-preview-modal", () => ({
  useAttachmentPreview: () => ({ tryOpen, modal: null }),
}));
vi.mock("../../platform", () => ({ openExternal: openByUrl }));

const url = "/api/attachments/att_1/content";
const attachment: Attachment = {
  id: "att_1", workspace_id: "w", issue_id: "i", comment_id: "c", chat_session_id: null, chat_message_id: null,
  uploader_type: "member", uploader_id: "u", filename: "notes.txt", url, download_url: url,
  content_type: "text/plain", size_bytes: 5, created_at: "2026-10-04T00:00:00Z",
};
beforeEach(() => vi.clearAllMocks());

function Surface({ html, markdown, attachments }: { html: string; markdown: string; attachments?: Attachment[] }) {
  return <StrictMode><QueryClientProvider client={new QueryClient()}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, editor: enEditor, ui: enUI } }}>
      <EntryHtml html={html} markdown={markdown} attachments={attachments} />
      <AttachmentList attachments={attachments} content={markdown} />
    </I18nProvider>
  </QueryClientProvider></StrictMode>;
}

function props(record = attachment) {
  const markdown = `!file[${record.filename}](${record.url})`;
  return { markdown, html: preprocessFileCards(markdown, ""), attachments: [record] };
}

describe("EntryHtml file cards (MUL-518)", () => {
  it.each(["notes.txt", "report.pdf", "page.html", "image.png", "archive.zip"])("renders %s once and downloads by ID", filename => {
    const record = { ...attachment, filename, content_type: "" };
    const { container } = render(<Surface {...props(record)} />);
    expect(screen.getAllByText(filename)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(1);
    expect(container.querySelectorAll('img,iframe')).toHaveLength(0);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledExactlyOnceWith("att_1");
    if (filename !== "archive.zip") {
      fireEvent.mouseDown(screen.getByRole("button", { name: "Preview" }));
      expect(tryOpen).toHaveBeenCalledExactlyOnceWith({ kind: "full", attachment: record });
    }
  });

  it.each(FILE_CARD_CASES.filter(entry => !entry.allowed))("raw forged card is inert: $href", ({ href }) => {
    // Build attributes via DOM so quote escaping is irrelevant to the href boundary.
    const card = document.createElement("div");
    card.setAttribute("data-type", "fileCard");
    card.setAttribute("data-href", href);
    card.setAttribute("data-filename", "forged.txt");
    render(<Surface html={card.outerHTML} markdown="" />);
    expect(screen.getByText("forged.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(download).not.toHaveBeenCalled();
    expect(openByUrl).not.toHaveBeenCalled();
  });

  it("falls back to URL downloads and media previews without metadata", () => {
    const markdown = "!file[report.pdf](/uploads/report.pdf)";
    render(<Surface html={preprocessFileCards(markdown, "")} markdown={markdown} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(openByUrl).toHaveBeenCalledExactlyOnceWith("/uploads/report.pdf");
    fireEvent.mouseDown(screen.getByRole("button", { name: "Preview" }));
    expect(tryOpen).toHaveBeenCalledExactlyOnceWith({ kind: "url", url: "/uploads/report.pdf", filename: "report.pdf" });
  });

  it("resolves a strict API query URL to the canonical attachment record", () => {
    const markdown = `!file[notes.txt](${url}?download=1)`;
    render(<Surface html={preprocessFileCards(markdown, "")} markdown={markdown} attachments={[attachment]} />);
    expect(screen.getAllByText("notes.txt")).toHaveLength(1);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledExactlyOnceWith("att_1");
    fireEvent.mouseDown(screen.getByRole("button", { name: "Preview" }));
    expect(tryOpen).toHaveBeenCalledExactlyOnceWith({ kind: "full", attachment });
  });

  it("preserves comment deduplication by filename, type and size (MUL-518 B1 scope)", () => {
    const first = { ...attachment, filename: "same-name.txt", size_bytes: 2 };
    const second = { ...first, id: "att_2", url: "/api/attachments/att_2/content" };
    const markdown = `!file[same-name.txt](${first.url})`;
    render(<Surface html={preprocessFileCards(markdown, "")} markdown={markdown} attachments={[first, second]} />);
    expect(screen.getAllByText("same-name.txt")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Preview" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(1);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledExactlyOnceWith("att_1");
  });

  it("keeps fresh metadata and restores correctly when the body changes", () => {
    const { rerender, container } = render(<Surface {...props()} />);
    const newRecord = { ...attachment, id: "att_2", url: "/api/attachments/att_2/content", filename: "new.txt" };
    rerender(<Surface {...props(newRecord)} />);
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(screen.getAllByText("new.txt")).toHaveLength(1);
    expect(container.querySelectorAll('[data-entry-preview="fileCard"]')).toHaveLength(1);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledExactlyOnceWith("att_2");
  });

  it("validates optional replica metadata before passing records to the provider", () => {
    const entry = { metadata: { attachments: [attachment] } } as unknown as SessionLogEntry;
    expect(entryAttachments(entry)).toEqual([attachment]);
    expect(entryAttachments({} as SessionLogEntry)).toBeUndefined();
    expect(entryAttachments({ metadata: { attachments: [{ filename: "missing id" }] } } as unknown as SessionLogEntry)).toEqual([]);
  });
});


describe("description shares the attachment path boundary", () => {
  it.each(["notes.txt", "report.pdf"])("renders %s with a record preview and ID download", filename => {
    const record = { ...attachment, filename, content_type: "" };
    render(<QueryClientProvider client={new QueryClient()}>
      <I18nProvider locale="en" resources={{ en: { chat: enChat, editor: enEditor, ui: enUI } }}>
        <ReadonlyContent content={`!file[${filename}](${record.url})`} attachments={[record]} />
      </I18nProvider>
    </QueryClientProvider>);
    expect(screen.getAllByText(filename)).toHaveLength(1);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Preview" }));
    expect(tryOpen).toHaveBeenCalledExactlyOnceWith({ kind: "full", attachment: record });
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledExactlyOnceWith("att_1");
  });
});
