import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";
import { messageFixture } from "../../test/messages";
const mock = vi.hoisted(() => ({ ws: "ws-1", mobile: false, searchParams: new URLSearchParams(), getMessage: vi.fn(), listInboxPage: vi.fn(), markInboxRead: vi.fn(), markAllInboxRead: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api: mock }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => mock.ws }));
vi.mock("@multiremi/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (_type: string, id: string) => id }) }));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => mock.mobile }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/inbox", searchParams: mock.searchParams, replace: vi.fn() }) }));
vi.mock("../../common/use-list-perf-marker", () => ({ useListPerfMarker: () => null }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@multiremi/ui/components/ui/resizable", () => ({ ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, ResizableHandle: () => null }));
import { InboxPage } from "./inbox-page";
const page = { items: [messageFixture()], unread_count: 200, attention_count: 3, next_cursor: null };
const mount = () => renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><InboxPage /></QueryClientProvider>);
beforeEach(() => { vi.clearAllMocks(); mock.ws = "ws-1"; mock.mobile = false; mock.searchParams = new URLSearchParams(); mock.getMessage.mockResolvedValue(messageFixture()); mock.listInboxPage.mockResolvedValue(page); mock.markInboxRead.mockResolvedValue({ session_id: "sess_1", cursor_seq: 8 }); mock.markAllInboxRead.mockResolvedValue({ conversations_read: 12 }); });
describe("cursor inbox", () => {
  it("keeps global counts and makes reads explicit, without per-message archive", async () => {
    mount(); const item = await screen.findByRole("button", { name: /Follow up/ });
    expect(screen.getByText("200")).toBeInTheDocument();
    fireEvent.click(item);
    expect(mock.markInboxRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Read through #5" }));
    await waitFor(() => expect(mock.markInboxRead).toHaveBeenCalledWith({ session_id: "sess_1", to_seq: 5 }));
    expect(await screen.findByText("Read through #8")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(mock.markAllInboxRead).toHaveBeenCalledTimes(1));
  });
  it("continues with the opaque cursor and deduplicates overlapping pages", async () => {
    mock.listInboxPage.mockImplementation(async ({ cursor }: { cursor: string | null }) => cursor ? { ...page, items: [messageFixture(), messageFixture({ id: "msg_2", seq: 6, body_md: "Second" })] } : { ...page, next_cursor: "opaque+next" });
    mount(); await screen.findByRole("button", { name: /Follow up/ });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Second/ });
    expect(screen.getAllByRole("button", { name: /Follow up/ })).toHaveLength(1);
    expect(mock.listInboxPage).toHaveBeenCalledWith({ workspace_id: "ws-1", limit: 50, cursor: "opaque+next" });
    expect(screen.getByText("200")).toBeInTheDocument();
  });
  it("retains visible unread data when the cursor write fails", async () => {
    mock.markInboxRead.mockRejectedValue(new Error("offline")); mount(); fireEvent.click(await screen.findByRole("button", { name: /Follow up/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read through #5" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.getByRole("button", { name: /Follow up/ })).toBeInTheDocument();
    expect(screen.queryByText("Read through #8")).toBeNull();
  });
  it("returns from a deep-linked mobile detail to the list", async () => {
    mock.mobile = true; mock.searchParams.set("item", "msg_1"); mount();
    await screen.findByRole("button", { name: "Read through #5" });
    fireEvent.click(screen.getByRole("button", { name: "Inbox" }));
    expect(await screen.findByRole("button", { name: /Follow up/ })).toBeInTheDocument();
  });
  it("follows a new message deep link after a local row selection", async () => {
    mock.listInboxPage.mockResolvedValue({ ...page, items: [messageFixture(), messageFixture({ id: "msg_2", seq: 9, body_md: "Second message" })] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const element = () => <QueryClientProvider client={qc}><InboxPage /></QueryClientProvider>;
    const view = renderWithI18n(element());
    fireEvent.click(await screen.findByRole("button", { name: /Follow up/ }));
    expect(screen.getByRole("button", { name: "Read through #5" })).toBeInTheDocument();
    mock.searchParams = new URLSearchParams("item=msg_2");
    mock.getMessage.mockResolvedValue(messageFixture({ id: "msg_2", seq: 9, body_md: "Second message" }));
    view.rerender(element());
    expect(await screen.findByRole("button", { name: "Read through #9" })).toBeInTheDocument();
    expect(mock.markInboxRead).not.toHaveBeenCalled();
  });
  it("shows a recoverable query failure", async () => {
    mock.listInboxPage.mockRejectedValueOnce(new Error("offline")); mount(); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /Follow up/ });
  });
  it("keeps read failures visible on a mobile detail", async () => {
    mock.mobile = true; mock.markInboxRead.mockRejectedValue(new Error("offline")); mount();
    fireEvent.click(await screen.findByRole("button", { name: /Follow up/ }));
    fireEvent.click(screen.getByRole("button", { name: "Read through #5" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  });
  it("allows a missing deep-linked message to be retried without a read", async () => {
    mock.mobile = true; mock.searchParams.set("item", "not-loaded");
    mock.getMessage.mockRejectedValueOnce(new Error("offline")); mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load messages");
    expect(mock.markInboxRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await screen.findByRole("button", { name: "Read through #5" });
  });
});
