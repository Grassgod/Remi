import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@multiremi/core/types";
import { MemorySessionReplica, type SessionLogEntry, type SessionReplicaPort } from "@multiremi/core/replica";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ChatMessageList } from "../components/chat-message-list";
import enChat from "../../locales/en/chat.json";
import enEditor from "../../locales/en/editor.json";
import enUI from "../../locales/en/ui.json";

const download = vi.hoisted(() => vi.fn());
vi.mock("../../editor/use-download-attachment", () => ({ useDownloadAttachment: () => download }));
vi.mock("../../common/task-transcript/use-task-trace", () => ({
  useTaskTraceState: () => ({ events: [], closed: false, error: false }),
}));
vi.mock("@multiremi/core/config", () => ({ useConfigStore: (selector: (s: { cdnDomain: string }) => unknown) => selector({ cdnDomain: "" }) }));
vi.mock("@multiremi/core/paths", async importOriginal => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return { ...actual, useWorkspaceSlug: () => "test", useWorkspacePaths: () => actual.paths.workspace("test") };
});
// Keep message parsing, Markdown and AttachmentList real; virtual layout is unrelated to deduplication.
vi.mock("../../common/session-log/session-log-list", () => ({
  SessionLogList: ({ replica, sessionId, renderEntry }: {
    replica: SessionReplicaPort; sessionId: string; renderEntry: (args: { entry: SessionLogEntry }) => React.ReactNode;
  }) => <div>{replica.getSnapshot(sessionId).entries.map(entry => <div key={entry.id}>{renderEntry({ entry })}</div>)}</div>,
}));

const url = "/api/attachments/att-1/content";
const attachment: Attachment = {
  id: "att-1", workspace_id: "w", issue_id: null, comment_id: null, chat_session_id: "cs", chat_message_id: "msg",
  uploader_type: "member", uploader_id: "u", filename: "notes.txt", url, download_url: url,
  content_type: "text/plain", size_bytes: 5, created_at: "2026-10-04T00:00:00Z",
};

beforeEach(() => vi.clearAllMocks());

function renderMessage(content: string, attachments: Attachment[], role: "user" | "assistant" = "user") {
  const replica = new MemorySessionReplica({ cs: { entries: [{
    session_id: "cs", id: "msg", seq: 1, revision: 1,
    kind: role === "user" ? "message" : "turn", author_type: role === "user" ? "member" : "system",
    body_md: content, body_html: null, render_version: null, metadata: { attachments },
    created_at: "2026-10-04T00:00:00Z",
  } as SessionLogEntry] } });
  return render(<QueryClientProvider client={new QueryClient()}>
    <I18nProvider locale="en" resources={{ en: { chat: enChat, editor: enEditor, ui: enUI } }}>
      <ChatMessageList sessionId="cs" replica={replica} optimisticRows={[]} pendingTask={null} availability={undefined} />
    </I18nProvider>
  </QueryClientProvider>);
}

describe("chat attachment presentation (MUL-499)", () => {
  it("renders an inline authenticated TXT attachment once and downloads by record id", () => {
    const { container } = renderMessage(`Please review\n\n!file[notes.txt](${url})`, [attachment]);
    expect(screen.getByText("Please review")).toBeInTheDocument();
    expect(screen.getAllByText("notes.txt")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(1);
    expect(container.textContent).not.toContain("!file");
    fireEvent.mouseDown(screen.getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledExactlyOnceWith("att-1");
  });

  it("keeps an authenticated inline card without attachment metadata", () => {
    const { container } = renderMessage(`!file[notes.txt](${url})`, []);
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(1);
    expect(container.textContent).not.toContain("!file");
  });

  it("keeps record attachments absent from Markdown", () => {
    renderMessage("Please review", [attachment]);
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(1);
  });

  it("keeps CDN inline cards without adding a duplicate fallback", () => {
    const cdnUrl = "https://cdn.example/notes.txt";
    renderMessage(`!file[notes.txt](${cdnUrl})`, [{ ...attachment, url: cdnUrl }]);
    expect(screen.getAllByText("notes.txt")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Download" })).toHaveLength(1);
  });

  it.each(["user", "assistant"] as const)("keeps different same-name files in a mixed %s message (MUL-518 B1)", role => {
    const files = ["A1", "B2"].map((content, index) => ({
      content,
      attachment: {
        ...attachment, id: `att-${index + 1}`, filename: "same-name.txt", size_bytes: content.length,
        url: `/api/attachments/att-${index + 1}/content`,
        download_url: `/api/attachments/att-${index + 1}/download`,
      },
    }));
    download.mockImplementation((id: string) => files.find(file => file.attachment.id === id)?.content);
    renderMessage(`!file[same-name.txt](${files[0]!.attachment.url})`, files.map(file => file.attachment), role);
    expect(screen.getAllByText("same-name.txt")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Preview" })).toHaveLength(2);
    const buttons = screen.getAllByRole("button", { name: "Download" });
    expect(buttons).toHaveLength(2);
    buttons.forEach(button => fireEvent.mouseDown(button));
    expect(download.mock.calls).toEqual([["att-1"], ["att-2"]]);
    expect(download.mock.results.map(result => result.value)).toEqual(["A1", "B2"]);
  });
});
