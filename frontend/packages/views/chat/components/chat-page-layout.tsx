"use client";

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { usePanelRef, type LayoutChangedMeta, type PanelSize } from "react-resizable-panels";
import { PanelLeft } from "lucide-react";
import { formatShortcut, modKey } from "@multiremi/core/platform";
import { Button } from "@multiremi/ui/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@multiremi/ui/components/ui/resizable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { cn } from "@multiremi/ui/lib/utils";
import {
  CHAT_LIST_DEFAULT_PX,
  CHAT_LIST_MIN_PX,
  chatListMaxWidth,
  clampChatListWidth,
} from "../../layout/shell-preferences";
import { useChatListPreference } from "../../layout/shell-preferences-provider";
import { useT } from "../../i18n";

const LIST_PANEL_ID = "chat-page-list";
const MAIN_PANEL_ID = "chat-page-main";
const LIST_ID = "chat-page-list-content";
/** Half the library's 10px fine-pointer target around the zero-width separator. */
const HANDLE_HIT_PX = 5;

interface ChatListToggle {
  hidden: boolean;
  toggle: () => void;
}

const ChatListToggleContext = createContext<ChatListToggle | null>(null);

/** The Chat page's width (list and conversation), followed through resizes; 0 until measured. */
function usePageWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Text fields keep Mod+B: the composer's editor binds it to bold. */
function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * The Chat page's two columns. On desktop the Chat list is a resizable,
 * collapsible panel (240px up to 520px, always leaving the conversation 480px;
 * double-clicking the handle restores 300px) that Mod+B or the header's
 * toggle hides and shows. Its width and hidden state live in cookies, so the
 * server renders them. Narrow screens keep one column at a time.
 */
export function ChatPageLayout({ list, showList, children }: {
  list: ReactNode;
  /** Narrow screens: the list instead of the conversation. */
  showList: boolean;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <div className="flex h-full min-h-0">
        <aside className={cn(showList ? "flex" : "hidden", "w-full min-h-0 flex-col bg-sidebar")}>{list}</aside>
        <main className={cn(showList ? "hidden" : "flex", "min-h-0 min-w-0 flex-1 flex-col")}>{children}</main>
      </div>
    );
  }
  return <DesktopChatPageLayout list={list}>{children}</DesktopChatPageLayout>;
}

function DesktopChatPageLayout({ list, children }: { list: ReactNode; children: ReactNode }) {
  const { t } = useT("chat");
  const { preference, setPreference } = useChatListPreference();
  const panelRef = usePanelRef();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const pageWidth = usePageWidth(groupRef);
  // The panel takes its size from the preference once; afterwards the panel
  // leads and the preference follows it.
  const [initialSize] = useState(() => (preference.hidden ? 0 : clampChatListWidth(preference.width, 0)));
  const [hidden, setHidden] = useState(preference.hidden);
  const savedWidth = preference.width;

  const listWidth = useCallback(() => {
    const panel = panelRef.current;
    const group = groupRef.current;
    if (!panel || !group) return 0;
    return Math.round((panel.getSize().asPercentage / 100) * group.getBoundingClientRect().width);
  }, [panelRef]);

  const toggle = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const hide = !panel.isCollapsed();
    if (hide) panel.collapse();
    else panel.resize(clampChatListWidth(savedWidth, pageWidth));
    setHidden(hide);
    setPreference({ width: savedWidth, hidden: hide });
  }, [pageWidth, panelRef, savedWidth, setPreference]);

  const resetWidth = useCallback(() => {
    panelRef.current?.resize(clampChatListWidth(CHAT_LIST_DEFAULT_PX, pageWidth));
    setHidden(false);
    setPreference({ width: CHAT_LIST_DEFAULT_PX, hidden: false });
  }, [pageWidth, panelRef, setPreference]);

  // The separator is zero-wide and the library hit-tests it by position, so
  // the conversation is what receives the double-click; test by position too.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const onDoubleClick = (event: MouseEvent) => {
      const handle = handleRef.current;
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      const onHandle = event.target instanceof Node && handle.contains(event.target);
      if (onHandle || (Math.abs(event.clientX - rect.left) <= HANDLE_HIT_PX
        && event.clientY >= rect.top && event.clientY <= rect.bottom)) resetWidth();
    };
    group.addEventListener("dblclick", onDoubleClick);
    return () => group.removeEventListener("dblclick", onDoubleClick);
  }, [resetWidth]);

  // Only the user's own drags and arrow keys change the remembered width; a
  // narrower page (window, or the nav expanding) squeezes the list without
  // forgetting it.
  const onLayoutChanged = useCallback((_layout: unknown, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const panel = panelRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    setHidden(collapsed);
    setPreference(collapsed ? { width: savedWidth, hidden: true } : { width: listWidth(), hidden: false });
  }, [listWidth, panelRef, savedWidth, setPreference]);

  const onResize = useCallback((size: PanelSize) => {
    setHidden(panelRef.current?.isCollapsed() ?? size.asPercentage === 0);
  }, [panelRef]);

  // A wider page gives the list back its remembered width.
  useEffect(() => {
    const panel = panelRef.current;
    if (!pageWidth || !panel || panel.isCollapsed()) return;
    const target = clampChatListWidth(savedWidth, pageWidth);
    if (Math.abs(listWidth() - target) > 1) panel.resize(target);
    // savedWidth is left out: a drag already sized the panel it records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidth]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.key !== "b" && event.key !== "B") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const toggleValue = useMemo(() => ({ hidden, toggle }), [hidden, toggle]);

  return (
    <ChatListToggleContext value={toggleValue}>
      <ResizablePanelGroup id="chat-page" orientation="horizontal" className="min-h-0 flex-1"
        elementRef={groupRef} onLayoutChanged={onLayoutChanged}>
        <ResizablePanel id={LIST_PANEL_ID} panelRef={panelRef} defaultSize={initialSize}
          minSize={CHAT_LIST_MIN_PX} maxSize={chatListMaxWidth(pageWidth)} collapsible
          groupResizeBehavior="preserve-pixel-size" onResize={onResize}
          className="flex min-h-0 flex-col" style={{ overflow: "hidden" }}>
          <aside id={LIST_ID} inert={hidden} className="flex h-full min-h-0 flex-col border-r bg-sidebar">
            {list}
          </aside>
        </ResizablePanel>
        <ResizableHandle elementRef={handleRef} aria-label={t(($) => $.page.resize_sidebar)} disableDoubleClick />
        <ResizablePanel id={MAIN_PANEL_ID} className="relative flex min-h-0 min-w-0 flex-col">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </ChatListToggleContext>
  );
}

/** 「隐藏/显示侧边栏」 in the Chat page header; nothing on narrow screens, which use the history button. */
export function ChatSidebarToggle() {
  const { t } = useT("chat");
  const toggle = use(ChatListToggleContext);
  if (!toggle) return null;
  const label = toggle.hidden ? t(($) => $.page.show_sidebar) : t(($) => $.page.hide_sidebar);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="-ml-1.5 text-muted-foreground max-md:hidden"
            aria-label={label}
            aria-expanded={!toggle.hidden}
            aria-controls={LIST_ID}
            aria-keyshortcuts="Meta+B Control+B"
            onClick={toggle.toggle}
          />
        }
      >
        <PanelLeft />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        <span className="text-muted-foreground">{formatShortcut(modKey, "B")}</span>
      </TooltipContent>
    </Tooltip>
  );
}
