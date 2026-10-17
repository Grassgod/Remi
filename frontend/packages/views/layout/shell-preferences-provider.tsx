"use client";

import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  CHAT_LIST_HIDDEN_COOKIE,
  CHAT_LIST_WIDTH_COOKIE,
  readShellPreferencesFromDocument,
  writeShellPreferenceCookie,
  type ChatListPreference,
  type ShellPreferences,
} from "./shell-preferences";

interface AppNavPreference {
  open: boolean;
  setOpen: (open: boolean) => void;
}

interface ChatListPreferenceState {
  preference: ChatListPreference;
  setPreference: (next: ChatListPreference) => void;
}

const AppNavPreferenceContext = createContext<AppNavPreference | null>(null);
const ChatListPreferenceContext = createContext<ChatListPreferenceState | null>(null);

function writeChatListCookies(next: ChatListPreference) {
  writeShellPreferenceCookie(CHAT_LIST_WIDTH_COOKIE, next.width);
  writeShellPreferenceCookie(CHAT_LIST_HIDDEN_COOKIE, next.hidden);
}

/**
 * Holds the shell layout the server read from cookies. It sits in the
 * workspace layout, so the state outlives client navigations: the Chat page
 * comes back as the user left it. `SidebarProvider` writes the nav cookie.
 */
export function ShellPreferencesProvider({ initial, children }: { initial: ShellPreferences; children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(initial.navOpen);
  const [chatList, setChatList] = useState(initial.chatList);
  const setChatListPreference = useCallback((next: ChatListPreference) => {
    setChatList((prev) => (prev.width === next.width && prev.hidden === next.hidden ? prev : next));
    writeChatListCookies(next);
  }, []);
  const nav = useMemo(() => ({ open: navOpen, setOpen: setNavOpen }), [navOpen]);
  const list = useMemo(
    () => ({ preference: chatList, setPreference: setChatListPreference }),
    [chatList, setChatListPreference],
  );
  return (
    <AppNavPreferenceContext value={nav}>
      <ChatListPreferenceContext value={list}>{children}</ChatListPreferenceContext>
    </AppNavPreferenceContext>
  );
}

/** Whether the app navigation is expanded; null outside the provider. */
export function useAppNavPreference(): AppNavPreference | null {
  return use(AppNavPreferenceContext);
}

/** The Chat list's width and hidden state; outside the provider, local state seeded from the cookies. */
export function useChatListPreference(): ChatListPreferenceState {
  const shared = use(ChatListPreferenceContext);
  const [local, setLocal] = useState(() => (shared ? null : readShellPreferencesFromDocument().chatList));
  const setLocalPreference = useCallback((next: ChatListPreference) => {
    setLocal(next);
    writeChatListCookies(next);
  }, []);
  return shared ?? { preference: local!, setPreference: setLocalPreference };
}
