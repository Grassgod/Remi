/**
 * Shell layout preferences kept in cookies, so the server renders the app
 * navigation and the Chat list the way the user left them and the page does
 * not jump after hydration. Pure module: the workspace layout (a server
 * component) parses the cookies with it.
 */

/** Written by `SidebarProvider` (`true` expanded, `false` icon rail). */
export const APP_NAV_COOKIE = "sidebar_state";
export const CHAT_LIST_WIDTH_COOKIE = "chat_list_width";
export const CHAT_LIST_HIDDEN_COOKIE = "chat_list_hidden";
export const SHELL_PREFERENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const CHAT_LIST_DEFAULT_PX = 300;
export const CHAT_LIST_MIN_PX = 240;
export const CHAT_LIST_MAX_PX = 520;
/** The conversation beside the Chat list keeps at least this much. */
export const CHAT_CONVERSATION_RESERVE_PX = 480;

export interface ChatListPreference {
  width: number;
  hidden: boolean;
}

export interface ShellPreferences {
  navOpen: boolean;
  chatList: ChatListPreference;
}

export const DEFAULT_SHELL_PREFERENCES: ShellPreferences = {
  navOpen: true,
  chatList: { width: CHAT_LIST_DEFAULT_PX, hidden: false },
};

/**
 * Widest the Chat list may be on a Chat page `pageWidth` px wide (list and
 * conversation; 0: not measured yet). The page, not the window, so the app
 * navigation beside it never squeezes the conversation under 480px.
 */
export function chatListMaxWidth(pageWidth: number): number {
  if (!(pageWidth > 0)) return CHAT_LIST_MAX_PX;
  return Math.max(CHAT_LIST_MIN_PX, Math.min(CHAT_LIST_MAX_PX, pageWidth - CHAT_CONVERSATION_RESERVE_PX));
}

export function clampChatListWidth(width: number, pageWidth: number): number {
  if (!Number.isFinite(width)) return Math.min(CHAT_LIST_DEFAULT_PX, chatListMaxWidth(pageWidth));
  return Math.min(chatListMaxWidth(pageWidth), Math.max(CHAT_LIST_MIN_PX, Math.round(width)));
}

export function parseShellPreferences(read: (name: string) => string | undefined): ShellPreferences {
  const width = Number(read(CHAT_LIST_WIDTH_COOKIE));
  return {
    navOpen: read(APP_NAV_COOKIE) !== "false",
    chatList: {
      width: width > 0 ? clampChatListWidth(width, 0) : CHAT_LIST_DEFAULT_PX,
      hidden: read(CHAT_LIST_HIDDEN_COOKIE) === "true",
    },
  };
}

/** Client-only fallback for shells rendered without the server's preferences. */
export function readShellPreferencesFromDocument(): ShellPreferences {
  if (typeof document === "undefined") return DEFAULT_SHELL_PREFERENCES;
  const cookies = new Map(
    document.cookie.split(";").map((part) => {
      const [name = "", ...value] = part.trim().split("=");
      return [name, value.join("=")] as const;
    }),
  );
  return parseShellPreferences((name) => cookies.get(name));
}

export function writeShellPreferenceCookie(name: string, value: string | number | boolean): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${value}; path=/; max-age=${SHELL_PREFERENCE_COOKIE_MAX_AGE}; samesite=lax`;
}
