"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import {
  defaultSlashSelection,
  rankSlashMenu,
  type RankedSlashMenuItem,
  type SlashMenuItem,
  type SlashMenuModel,
} from "@multiremi/core/chat/slash-menu";
import { isImeComposing } from "@multiremi/core/utils";
import { useT } from "../../i18n";
import { createSuggestionPopupRender } from "./suggestion-popup";

/**
 * Where the `/` menu reads the agent's commands and skills. The composer owns
 * it and calls `set` as the catalogue loads, so a menu that is already open
 * fills in without the user typing another character.
 */
export interface SlashMenuSource {
  get: () => SlashMenuModel | null;
  subscribe: (listener: () => void) => () => void;
  /** Called each time the menu opens, so the composer can start reading the catalogue then. */
  opened?: () => void;
}

export interface WritableSlashMenuSource extends SlashMenuSource {
  set: (model: SlashMenuModel | null) => void;
}

export function createSlashMenuSource(
  initial: SlashMenuModel | null = null,
  opened?: () => void,
): WritableSlashMenuSource {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    opened,
    set: (model) => {
      if (model === current) return;
      current = model;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface SlashCommandListProps {
  source: SlashMenuSource;
  query: string;
  command: (item: SlashMenuItem) => void;
}

export interface SlashCommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

export const SlashCommandList = forwardRef<SlashCommandListRef, SlashCommandListProps>(
  function SlashCommandList({ source, query, command }, ref) {
    const { t } = useT("editor");
    const model = useSyncExternalStore(source.subscribe, source.get, source.get);
    const ranked = useMemo(
      // Not cut short: a catalogue is bounded (SLASH_COMMAND_LIMITS) and the list scrolls.
      () => rankSlashMenu(model?.items ?? [], query),
      [model, query],
    );
    const rankedKey = ranked.map((entry) => entry.item.id).join("\n");
    const [selectedIndex, setSelectedIndex] = useState(() => defaultSlashSelection(ranked));
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
      source.opened?.();
    }, [source]);

    // A new query or a newly loaded catalogue starts over from the default
    // pick; a weak match is never picked, so Enter keeps its own meaning.
    useEffect(() => {
      setSelectedIndex(defaultSlashSelection(ranked));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, rankedKey]);

    useEffect(() => {
      if (selectedIndex >= 0) itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (isImeComposing(event) || hasModifier(event)) return false;
        const count = ranked.length;
        if (event.key === "ArrowDown") {
          if (count === 0) return false;
          setSelectedIndex((index) => (index < 0 ? 0 : (index + 1) % count));
          return true;
        }
        if (event.key === "ArrowUp") {
          if (count === 0) return false;
          setSelectedIndex((index) => (index <= 0 ? count - 1 : index - 1));
          return true;
        }
        if (event.key === "Enter") {
          const entry = ranked[selectedIndex];
          if (!entry) return false;
          command(entry.item);
          return true;
        }
        if (event.key === "Tab") {
          if (event.shiftKey) return false;
          const entry = ranked[selectedIndex] ?? ranked[0];
          if (!entry) return false;
          command(entry.item);
          return true;
        }
        return false;
      },
    }));

    const agentRows: { entry: RankedSlashMenuItem; index: number }[] = [];
    const skillRows: { entry: RankedSlashMenuItem; index: number }[] = [];
    ranked.forEach((entry, index) => {
      (entry.item.group === "agent" ? agentRows : skillRows).push({ entry, index });
    });
    const typed = query.trim() !== "";
    const hasSkills = (model?.items ?? []).some((item) => item.group === "skill");

    const renderRow = ({ entry, index }: { entry: RankedSlashMenuItem; index: number }) => (
      <SlashCommandRow
        key={entry.item.id}
        item={entry.item}
        selected={index === selectedIndex}
        onSelect={() => command(entry.item)}
        buttonRef={(el) => {
          itemRefs.current[index] = el;
        }}
      />
    );

    // 「Agent 命令」: the catalogue's state decides what stands in for rows,
    // so loading or an error never reads as "this agent has no commands".
    let agentNote: ReactNode = null;
    if (model?.status === "loading") {
      agentNote = <SlashNote>{t(($) => $.slash_command.loading)}</SlashNote>;
    } else if (model?.status === "error") {
      agentNote = <SlashNote tone="warning">{t(($) => $.slash_command.load_failed)}</SlashNote>;
    } else if (model?.catalogue === "none") {
      agentNote = <SlashNote>{t(($) => $.slash_command.agent_commands_after_reply)}</SlashNote>;
    } else if (model?.catalogue === "preview" && agentRows.length > 0) {
      agentNote = <SlashNote>{t(($) => $.slash_command.preview_note)}</SlashNote>;
    }
    const showAgentGroup = model !== null && (agentRows.length > 0 || agentNote !== null);
    const skillNote = !typed && !hasSkills && model !== null
      ? <SlashNote>{t(($) => $.slash_command.no_skills_configured)}</SlashNote>
      : null;
    const showSkillGroup = skillRows.length > 0 || skillNote !== null;

    if (!showAgentGroup && !showSkillGroup) {
      return (
        <div className="rounded-md border bg-popover p-2 text-xs text-muted-foreground shadow-md" role="status">
          {t(($) => (typed ? $.slash_command.no_results : $.slash_command.empty))}
        </div>
      );
    }

    return (
      <div
        className="flex max-h-[420px] w-80 flex-col overflow-y-auto overscroll-contain rounded-md border bg-popover py-1 shadow-md"
        role="listbox"
        aria-label={t(($) => $.slash_command.aria_label)}
      >
        {showAgentGroup ? (
          <section data-slash-group="agent">
            <SlashGroupHeader>{t(($) => $.slash_command.group_agent)}</SlashGroupHeader>
            {agentNote}
            {agentRows.map(renderRow)}
          </section>
        ) : null}
        {showSkillGroup ? (
          <section data-slash-group="skill">
            <SlashGroupHeader>{t(($) => $.slash_command.group_skills)}</SlashGroupHeader>
            {skillNote}
            {skillRows.map(renderRow)}
          </section>
        ) : null}
      </div>
    );
  },
);

function SlashGroupHeader({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
      {children}
    </div>
  );
}

function SlashNote({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" }) {
  return (
    <div
      className={`px-3 pb-1.5 text-[11px] leading-snug ${tone === "warning" ? "text-warning" : "text-muted-foreground"}`}
      role={tone === "warning" ? "alert" : undefined}
    >
      {children}
    </div>
  );
}

function SlashCommandRow({
  item,
  selected,
  onSelect,
  buttonRef,
}: {
  item: SlashMenuItem;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const { t } = useT("editor");
  // A platform skill keeps its own name ("Deploy Prod"); what is sent follows it.
  const named = item.group === "skill" && item.label !== item.invocation.replace(/^[/$]/, "");
  const tag = item.group === "agent"
    ? item.kind === "skill" ? t(($) => $.slash_command.kind_skill)
      : item.kind === "mcp_prompt" ? t(($) => $.slash_command.kind_mcp) : null
    : null;
  return (
    <button
      type="button"
      ref={buttonRef}
      role="option"
      aria-selected={selected}
      data-slash-item={item.id}
      className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left text-xs transition-colors ${
        selected ? "bg-accent" : "hover:bg-accent/50"
      }`}
      // Keep focus (and the open suggestion) in the editor until the click lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-medium">{named ? item.label : item.invocation}</span>
        {named ? <span className="shrink-0 text-muted-foreground">{item.invocation}</span> : null}
        {item.hint ? <span className="min-w-0 truncate text-muted-foreground/70">{item.hint}</span> : null}
        {tag ? (
          <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">{tag}</span>
        ) : null}
      </span>
      {item.description ? <span className="truncate text-muted-foreground">{item.description}</span> : null}
    </button>
  );
}

/**
 * The `/` menu: opens only when the `/` is the first character of the
 * message, and picking a row puts the item's chip there, followed by a space.
 * The chip is sent as its raw invocation (see slash-command-extension.ts).
 */
export function createSlashCommandSuggestion(source: SlashMenuSource): Omit<
  SuggestionOptions<SlashMenuItem>,
  "editor"
> {
  const pluginKey = new PluginKey("slashCommandSuggestion");

  return {
    char: "/",
    pluginKey,
    allow: ({ state, range }) => range.from === 1 && state.doc.firstChild?.type.name === "paragraph",
    items: ({ query }) => rankSlashMenu(source.get()?.items ?? [], query).map((entry) => entry.item),
    command: ({ editor, range, props }) => {
      const nodeAfter = editor.view.state.selection.$to.nodeAfter;
      if (nodeAfter?.text?.startsWith(" ")) range.to += 1;

      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "slashCommand",
            attrs: {
              id: props.id,
              label: props.label,
              invocation: props.invocation,
              hint: props.hint,
              mentionSuggestionChar: "/",
            },
          },
          { type: "text", text: " " },
        ])
        .run();

      window.getSelection()?.collapseToEnd();
    },
    render: createSuggestionPopupRender<SlashMenuItem, SlashMenuItem, SlashCommandListRef, SlashCommandListProps>({
      pluginKey,
      component: SlashCommandList,
      getProps: (props) => ({
        source,
        query: props.query,
        command: props.command,
      }),
      onKeyDown: (ref, props) => ref?.onKeyDown(props) ?? false,
    }),
  };
}
