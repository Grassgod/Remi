import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { getAttachmentTextContentMock } = vi.hoisted(() => ({
  getAttachmentTextContentMock: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({
  api: {
    getAttachmentTextContent: getAttachmentTextContentMock,
    getAttachment: vi.fn(),
  },
  PreviewTooLargeError: class extends Error {},
  PreviewUnsupportedError: class extends Error {},
}));

// HtmlAttachmentPreview (kind="html" dispatch from AttachmentBlock) reads
// useNavigation() + useWorkspaceSlug() for the Open-in-new-tab button.
// Mock both so the standalone-attachment-routes-to-iframe test does not
// need the surrounding NavigationProvider / WorkspaceSlugProvider tree.
vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/issues",
    searchParams: new URLSearchParams(),
    openInNewTab: vi.fn(),
    getShareableUrl: (p: string) => `https://app.example${p}`,
  }),
}));

vi.mock("@multiremi/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/paths")>();
  return {
    ...actual,
    useWorkspaceSlug: () => "acme",
  };
});

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "User" }),
}));
vi.mock("@multiremi/core/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ uploadWithToast: vi.fn() }),
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));

import { AttachmentList, CommentCard } from "./comment-card";
import { renderWithI18n } from "../../test/i18n";
import type { TimelineEntry } from "@multiremi/core/types";

function renderWithQuery(ui: ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function renderCard(entry: Partial<TimelineEntry>, onResolveToggle = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const comment: TimelineEntry = {
    type: "comment",
    id: "c-1",
    actor_type: "member",
    actor_id: "u-1",
    content: "hello",
    parent_id: null,
    resolved_at: null,
    created_at: "2026-10-01T00:00:00Z",
    ...entry,
  };
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <CommentCard
        issueId="i-1"
        entry={comment}
        currentUserId="u-1"
        onStartReply={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleReaction={vi.fn()}
        onResolveToggle={onResolveToggle}
      />
    </QueryClientProvider>,
  );
  return { onResolveToggle };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("AttachmentList — standalone HTML attachment routes through AttachmentBlock", () => {
  // Regression pin for comment-card.tsx:152. This is the entry point
  // MUL-2330 originally regressed on: standalone HTML attachments (not
  // referenced inline in the markdown body) MUST render through
  // <AttachmentBlock> so the html+attachmentId dispatch fires. Reverting to
  // <AttachmentCard> here re-introduces the "report.html shows as a bare
  // file card row instead of the rendered chart" bug.
  it("renders an iframe (no file-card chrome) for a standalone HTML attachment", async () => {
    getAttachmentTextContentMock.mockResolvedValueOnce({
      text: "<p>chart</p>",
      originalContentType: "text/html",
    });
    const attachment = {
      id: "att-1",
      url: "/uploads/report.html",
      filename: "report.html",
      content_type: "text/html",
      size_bytes: 0,
    } as any;

    renderWithQuery(<AttachmentList attachments={[attachment]} content="" />);

    const frame = await waitFor(() => {
      const f = document.querySelector("iframe") as HTMLIFrameElement | null;
      expect(f).toBeTruthy();
      return f!;
    });
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("<p>chart</p>");
    // AttachmentCard chrome would render the filename as visible <p> text;
    // HtmlAttachmentPreview replaces the row entirely.
    expect(screen.queryByText("report.html")).toBeNull();
  });
});

describe("CommentCard — resolve menu item", () => {
  // MUL-503: the server rejects resolve/unresolve on a reply with
  // "only root comments can be resolved", so the menu must not offer it there.
  it("offers Resolve thread on a root comment", async () => {
    const user = userEvent.setup();
    const { onResolveToggle } = renderCard({ parent_id: null });

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Resolve thread" }));

    expect(onResolveToggle).toHaveBeenCalledWith("c-1", true);
  });

  it("does not offer Resolve thread on a reply", async () => {
    const user = userEvent.setup();
    renderCard({ id: "c-2", parent_id: "c-1" });

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(await screen.findByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Resolve thread" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unresolve thread" })).toBeNull();
  });
});
