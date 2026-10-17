import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createChatStore, registerChatStore, useChatStore } from "@multiremi/core/chat";
import { renderWithI18n } from "../../test/i18n";
import { traceTurn, turnPage, turnTraceCache } from "../../test/trace-fixtures";
import { claudeLiveItems } from "../lib/__fixtures__/subagents";
import {
  CHAT_LIST_HIDDEN_COOKIE,
  CHAT_LIST_WIDTH_COOKIE,
  chatListMaxWidth,
  clampChatListWidth,
  DEFAULT_SHELL_PREFERENCES,
  parseShellPreferences,
  type ChatListPreference,
} from "../../layout/shell-preferences";
import { ShellPreferencesProvider } from "../../layout/shell-preferences-provider";
import { ChatPageLayout, ChatSidebarToggle } from "./chat-page-layout";
import { SubagentPanelLayout } from "./subagent-panel";

const { mobile } = vi.hoisted(() => ({ mobile: { value: false } }));
vi.mock("@multiremi/ui/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("@multiremi/core/api", async (original) => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace: vi.fn() } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: () => {} }));
vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <span>{children}</span> }));

const storeValues = new Map<string, string>();
registerChatStore(createChatStore({ storage: {
  getItem: (key) => storeValues.get(key) ?? null,
  setItem: (key, value) => { storeValues.set(key, value); },
  removeItem: (key) => { storeValues.delete(key); },
} }));

/** jsdom has no layout: the page lays out a 1200px Chat page from the panels' flex styles. */
let GROUP_PX = 1200;

function listStyleWidth(): number {
  const style = document.getElementById("chat-page-list")?.style;
  if (!style) return 0;
  return style.flexGrow ? (Number(style.flexGrow) / 100) * GROUP_PX : parseFloat(style.flexBasis) || 0;
}

/** [left, width] of the group's children; everything else spans the group. */
function box(element: Element): [number, number] {
  const list = listStyleWidth();
  if (element.id === "chat-page-list") return [0, list];
  if (element.id === "chat-page-main" || element.closest("#chat-page-main")) return [list, GROUP_PX - list];
  if (element.getAttribute("role") === "separator") return [list, 0];
  return [0, GROUP_PX];
}

function fakeLayout() {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return box(this)[1]; });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return box(this)[0]; });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [left, width] = box(this);
    return { width, height: 800, top: 0, left, right: left + width, bottom: 800, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

function cookie(name: string): string | undefined {
  return document.cookie.split("; ").find((part) => part.startsWith(`${name}=`))?.split("=")[1];
}

function clearCookies() {
  for (const name of [CHAT_LIST_WIDTH_COOKIE, CHAT_LIST_HIDDEN_COOKIE]) document.cookie = `${name}=; path=/; max-age=0`;
}

function renderPage(chatList: Partial<ChatListPreference> = {}, { showList = false, editor = false } = {}) {
  const ui = (list: boolean) => (
    <ShellPreferencesProvider initial={{ ...DEFAULT_SHELL_PREFERENCES, chatList: { ...DEFAULT_SHELL_PREFERENCES.chatList, ...chatList } }}>
      <ChatPageLayout showList={list} list={<button type="button">New chat</button>}>
        <header><ChatSidebarToggle /></header>
        <textarea aria-label="Plain field" />
        {editor && <div contentEditable suppressContentEditableWarning aria-label="Composer"><p>draft</p></div>}
      </ChatPageLayout>
    </ShellPreferencesProvider>
  );
  const view = renderWithI18n(ui(showList));
  return { ...view, setShowList: (list: boolean) => view.rerender(ui(list)) };
}

const separator = () => screen.getByRole("separator", { name: "Resize sidebar" });
const listPx = () => Math.round(listStyleWidth());
const list = () => document.getElementById("chat-page-list-content")!;
const pressModB = (target: Element, init: KeyboardEventInit = { metaKey: true }) =>
  act(() => { fireEvent.keyDown(target, { key: "b", ...init }); });

describe("chat list width rules", () => {
  it("allows 240px up to 520px, leaving the conversation at least 480px of the page", () => {
    expect(chatListMaxWidth(1176)).toBe(520);
    expect(chatListMaxWidth(900)).toBe(420);
    expect(chatListMaxWidth(600)).toBe(240);
    expect(chatListMaxWidth(0)).toBe(520);
    expect(clampChatListWidth(100, 1176)).toBe(240);
    expect(clampChatListWidth(800, 1176)).toBe(520);
    expect(clampChatListWidth(500, 900)).toBe(420);
    expect(clampChatListWidth(Number.NaN, 1176)).toBe(300);
  });

  it("reads the nav and the list from the cookies, falling back to defaults", () => {
    const read = (cookies: Record<string, string>) => parseShellPreferences((name) => cookies[name]);
    expect(read({})).toEqual(DEFAULT_SHELL_PREFERENCES);
    expect(read({ sidebar_state: "false", chat_list_width: "400", chat_list_hidden: "true" }))
      .toEqual({ navOpen: false, chatList: { width: 400, hidden: true } });
    expect(read({ chat_list_width: "9999" }).chatList.width).toBe(520);
    expect(read({ chat_list_width: "12" }).chatList.width).toBe(240);
    expect(read({ chat_list_width: "wide" }).chatList.width).toBe(300);
  });
});

describe("Chat page layout", () => {
  beforeEach(() => {
    mobile.value = false;
    GROUP_PX = 1200;
    clearCookies();
    fakeLayout();
  });
  afterEach(() => { vi.restoreAllMocks(); clearCookies(); });

  it("opens at the saved width and remembers the user's resizes, clamped", () => {
    renderPage({ width: 360 });
    expect(listPx()).toBe(360);
    // Arrow keys move the handle 5% of the group at a time.
    act(() => { fireEvent.keyDown(separator(), { key: "ArrowRight" }); });
    expect(listPx()).toBe(420);
    expect(separator()).toHaveAttribute("aria-valuenow", "35");
    expect(separator()).toHaveAttribute("aria-controls", "chat-page-list");
    expect(cookie(CHAT_LIST_WIDTH_COOKIE)).toBe("420");
    expect(cookie(CHAT_LIST_HIDDEN_COOKIE)).toBe("false");
    act(() => { fireEvent.keyDown(separator(), { key: "End" }); });
    expect(listPx()).toBe(520);
    expect(cookie(CHAT_LIST_WIDTH_COOKIE)).toBe("520");
  });

  it("leaves the conversation at least 480px", () => {
    GROUP_PX = 800;
    renderPage({ width: 500 });
    expect(listPx()).toBe(320);
    act(() => { fireEvent.keyDown(separator(), { key: "End" }); });
    expect(listPx()).toBe(320);
  });

  it("restores 300px when the handle is double-clicked", () => {
    renderPage({ width: 480 });
    act(() => { fireEvent.doubleClick(separator()); });
    expect(listPx()).toBe(300);
    expect(cookie(CHAT_LIST_WIDTH_COOKIE)).toBe("300");
  });

  it("finds the zero-width handle by position, since the conversation receives the double-click", () => {
    renderPage({ width: 480 });
    const field = screen.getByRole("textbox", { name: "Plain field" });
    act(() => { fireEvent.doubleClick(field, { clientX: 700, clientY: 100 }); });
    expect(listPx()).toBe(480);
    act(() => { fireEvent.doubleClick(field, { clientX: 484, clientY: 100 }); });
    expect(listPx()).toBe(300);
  });

  it("hides and shows the list from the header, takes it out of the tab order, and remembers", () => {
    renderPage({ width: 360 });
    expect(list()).not.toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(listPx()).toBe(0);
    expect(list()).toHaveAttribute("inert");
    expect(cookie(CHAT_LIST_HIDDEN_COOKIE)).toBe("true");
    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    // Back at the remembered width, not the 240px minimum.
    expect(listPx()).toBe(360);
    expect(list()).not.toHaveAttribute("inert");
    expect(cookie(CHAT_LIST_HIDDEN_COOKIE)).toBe("false");
    expect(cookie(CHAT_LIST_WIDTH_COOKIE)).toBe("360");
  });

  it("starts hidden when the server read it so, and shows at the saved width", () => {
    renderPage({ width: 400, hidden: true });
    expect(listPx()).toBe(0);
    expect(list()).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    expect(listPx()).toBe(400);
  });

  it("toggles with Mod+B, leaving text fields and handled keys alone", () => {
    renderPage({ width: 360 }, { editor: true });
    pressModB(document.body);
    expect(listPx()).toBe(0);
    pressModB(document.body, { ctrlKey: true });
    expect(listPx()).toBe(360);
    // The composer binds Mod+B to bold; plain fields keep their own meaning.
    pressModB(screen.getByRole("textbox", { name: "Plain field" }));
    pressModB(screen.getByLabelText("Composer").querySelector("p")!);
    expect(listPx()).toBe(360);
    const handled = (event: KeyboardEvent) => event.preventDefault();
    document.body.addEventListener("keydown", handled);
    pressModB(document.body);
    document.body.removeEventListener("keydown", handled);
    expect(listPx()).toBe(360);
    // Other chords do nothing.
    pressModB(document.body, { metaKey: true, shiftKey: true });
    pressModB(document.body, {});
    expect(listPx()).toBe(360);
  });

  it("keeps one column at a time on narrow screens, with no handle or toggle", () => {
    mobile.value = true;
    const view = renderPage();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide sidebar" })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" }).closest("aside")).toHaveClass("hidden");
    view.setShowList(true);
    expect(screen.getByRole("button", { name: "New chat" }).closest("aside")).not.toHaveClass("hidden");
    expect(screen.getByRole("main")).toHaveClass("hidden");
  });
});

describe("Chat page layout with the subagent panel (PR 5/6)", () => {
  beforeEach(() => {
    mobile.value = false;
    GROUP_PX = 1200;
    clearCookies();
    fakeLayout();
    useChatStore.getState().closeSubagentPanel();
  });
  afterEach(() => { vi.restoreAllMocks(); clearCookies(); act(() => { useChatStore.getState().closeSubagentPanel(); }); });

  it.each([false, true])("opens beside the conversation and stays open across toggles (list hidden: %s)", (hidden) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["task-trace", "att_1"], turnTraceCache(turnPage(traceTurn({ status: "running" }), claudeLiveItems())));
    renderWithI18n(
      <QueryClientProvider client={client}>
        <ShellPreferencesProvider initial={{ ...DEFAULT_SHELL_PREFERENCES, chatList: { width: 300, hidden } }}>
          <ChatPageLayout showList={false} list={<nav aria-label="Chats" />}>
            <SubagentPanelLayout sessionId="chat_1" presentation="page">
              <div data-testid="chat-conversation"><ChatSidebarToggle /></div>
            </SubagentPanelLayout>
          </ChatPageLayout>
        </ShellPreferencesProvider>
      </QueryClientProvider>,
    );
    act(() => {
      useChatStore.getState().openSubagentPanel({ sessionId: "chat_1", attemptId: "att_1", turnId: "turn_1", live: true, path: [] });
    });
    const split = () => document.querySelector('[data-subagent-panel-mode="split"]');
    expect(split()).not.toBeNull();
    expect(listPx()).toBe(hidden ? 0 : 300);
    fireEvent.click(screen.getByRole("button", { name: hidden ? "Show sidebar" : "Hide sidebar" }));
    expect(listPx()).toBe(hidden ? 300 : 0);
    expect(split()).not.toBeNull();
    expect(screen.getByTestId("chat-conversation")).toBeInTheDocument();
    expect(useChatStore.getState().subagentPanel).not.toBeNull();
  });
});
