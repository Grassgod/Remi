import { act, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { buildSlashMenu, type SlashMenuModel } from "@multiremi/core/chat/slash-menu";
import type { ChatSlashCommandsResponse, SlashCommandEntry } from "@multiremi/contracts/slash-commands";
import enEditor from "../../locales/en/editor.json";
import { SlashCommandExtension } from "./slash-command-extension";
import {
  SlashCommandList,
  createSlashCommandSuggestion,
  createSlashMenuSource,
  type SlashCommandListRef,
  type SlashMenuSource,
} from "./slash-command-suggestion";

const TEST_RESOURCES = { en: { editor: enEditor } };

function I18nWrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  const rect = () => new DOMRect(0, 0, 0, 0);
  const rectList = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: rect });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: rectList });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", { configurable: true, value: rectList });
  Object.defineProperty(Text.prototype, "getClientRects", { configurable: true, value: rectList });
});

const command = (name: string, fields: Partial<SlashCommandEntry> = {}): SlashCommandEntry => ({
  name, description: "", hint: null, kind: "command", ...fields,
});

function menu({
  state = "session",
  provider = "claude",
  commands = [command("compact", { description: "Compact the context", hint: "[instructions]" }), command("review")],
  skills = [{ id: "s1", name: "Deploy Prod", description: "Ship it" }],
  status = "ready",
}: {
  state?: ChatSlashCommandsResponse["state"];
  provider?: string;
  commands?: SlashCommandEntry[];
  skills?: { id: string; name: string; description?: string }[];
  status?: SlashMenuModel["status"];
} = {}): SlashMenuModel {
  return buildSlashMenu({
    provider,
    status,
    response: status === "ready" ? { state, provider, reported_at: null, commands } : null,
    skills,
  });
}

function renderList(source: SlashMenuSource, query = "", run = vi.fn()) {
  const ref = createRef<SlashCommandListRef>();
  const view = render(
    <I18nWrapper>
      <SlashCommandList ref={ref} source={source} query={query} command={run} />
    </I18nWrapper>,
  );
  return { ref, run, view };
}

const key = (k: string, init: KeyboardEventInit = {}) => ({ event: new KeyboardEvent("keydown", { key: k, ...init }) });

describe("SlashCommandList", () => {
  it("shows the agent's commands and the platform skills in two groups", () => {
    renderList(createSlashMenuSource(menu()));
    const agent = screen.getByText("Agent commands").closest("section")!;
    const skills = screen.getByText("Skills").closest("section")!;
    expect(within(agent).getByText("/compact")).toBeInTheDocument();
    expect(within(agent).getByText("[instructions]")).toBeInTheDocument();
    expect(within(agent).getByText("/review")).toBeInTheDocument();
    // A platform skill keeps its name and inserts the provider's invocation: its slug, `/` on Claude.
    expect(within(skills).getByText("Deploy Prod")).toBeInTheDocument();
    expect(within(skills).getByText("/deploy-prod")).toBeInTheDocument();
    expect(within(skills).getByText("Ship it")).toBeInTheDocument();
  });

  it("marks an agent command's source when the bridge says it", () => {
    renderList(createSlashMenuSource(menu({
      commands: [command("frontend-design", { kind: "skill" }), command("github:pr", { kind: "mcp_prompt" }), command("init")],
    })));
    expect(screen.getByRole("option", { name: /frontend-design/ })).toHaveTextContent("Skill");
    expect(screen.getByRole("option", { name: /github:pr/ })).toHaveTextContent("MCP");
    expect(screen.getByRole("option", { name: /init/ })).toHaveTextContent(/^\/init$/);
  });

  it("writes Codex skills with `$`", () => {
    renderList(createSlashMenuSource(menu({ provider: "codex", commands: [] })));
    expect(screen.getByText("$deploy-prod")).toBeInTheDocument();
  });

  it("notes a preview catalogue, and that agent commands come after the first reply", () => {
    const source = createSlashMenuSource(menu({ state: "preview" }));
    renderList(source);
    expect(screen.getByText(/From your last chat with this agent/)).toBeInTheDocument();

    act(() => source.set(menu({ state: "none", commands: [] })));
    expect(screen.getByText(/show up after its first reply/)).toBeInTheDocument();
    // Platform skills still show.
    expect(screen.getByText("/deploy-prod")).toBeInTheDocument();
  });

  it("does not read loading or a failed read as an empty catalogue", () => {
    const source = createSlashMenuSource(menu({ status: "loading" }));
    renderList(source);
    expect(screen.getByText(/Loading this agent's commands/)).toBeInTheDocument();
    expect(screen.queryByText("No commands or skills")).not.toBeInTheDocument();

    act(() => source.set(menu({ status: "error" })));
    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load this agent's commands/);
    expect(screen.getByText("/deploy-prod")).toBeInTheDocument();
  });

  it("fills in a menu that is already open when the catalogue arrives", () => {
    const source = createSlashMenuSource(menu({ status: "loading" }));
    renderList(source, "comp");
    expect(screen.queryByText("/compact")).not.toBeInTheDocument();
    act(() => source.set(menu()));
    expect(screen.getByText("/compact")).toBeInTheDocument();
  });

  it("tells the menu it opened", () => {
    const opened = vi.fn();
    renderList(createSlashMenuSource(menu(), opened));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("says so when nothing matches", () => {
    renderList(createSlashMenuSource(menu()), "zzz");
    expect(screen.getByText("No matching commands or skills")).toBeInTheDocument();
  });

  it("picks an exact or prefix match for Enter", () => {
    const { ref, run } = renderList(createSlashMenuSource(menu()), "comp");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/compact");
    expect(ref.current!.onKeyDown(key("Enter"))).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ invocation: "/compact", hint: "[instructions]" }));
  });

  it("does not pick a weak match, so Enter keeps its own meaning", () => {
    // "act" is only contained in "compact": no row is picked.
    const { ref, run } = renderList(createSlashMenuSource(menu()), "act");
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.queryByRole("option", { selected: true })).not.toBeInTheDocument();
    expect(ref.current!.onKeyDown(key("Enter"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
    // An arrow key picks it on purpose.
    act(() => {
      expect(ref.current!.onKeyDown(key("ArrowDown"))).toBe(true);
    });
    expect(ref.current!.onKeyDown(key("Enter"))).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ invocation: "/compact" }));
  });

  it("leaves nothing picked before the user types after the slash", () => {
    const { ref } = renderList(createSlashMenuSource(menu()));
    expect(ref.current!.onKeyDown(key("Enter"))).toBe(false);
  });

  it("never takes Mod-Enter, Ctrl-Enter or an IME Enter", () => {
    const { ref, run } = renderList(createSlashMenuSource(menu()), "compact");
    expect(ref.current!.onKeyDown(key("Enter", { metaKey: true }))).toBe(false);
    expect(ref.current!.onKeyDown(key("Enter", { ctrlKey: true }))).toBe(false);
    expect(ref.current!.onKeyDown(key("Enter", { isComposing: true }))).toBe(false);
    expect(ref.current!.onKeyDown(key("Enter", { keyCode: 229 }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("completes the first row with Tab", () => {
    const { ref, run } = renderList(createSlashMenuSource(menu()), "r");
    expect(ref.current!.onKeyDown(key("Tab"))).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ invocation: "/review" }));
  });

  it("lets arrow keys and Enter fall through when there is nothing to pick", () => {
    const { ref } = renderList(createSlashMenuSource(null), "");
    expect(ref.current!.onKeyDown(key("ArrowDown"))).toBe(false);
    expect(ref.current!.onKeyDown(key("ArrowUp"))).toBe(false);
    expect(ref.current!.onKeyDown(key("Enter"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In a real editor
// ---------------------------------------------------------------------------

let editor: Editor | null = null;

afterEach(() => {
  act(() => editor?.destroy());
  editor = null;
  document.body.innerHTML = "";
});

function makeEditor(model: SlashMenuModel | null = menu()) {
  const source = createSlashMenuSource(model);
  editor = new Editor({
    extensions: [
      StarterKit,
      Markdown,
      SlashCommandExtension.configure({
        HTMLAttributes: { class: "slash-command" },
        suggestion: createSlashCommandSuggestion(source),
      }),
    ],
    content: "",
  });
  render(
    <I18nWrapper>
      <EditorContent editor={editor} />
    </I18nWrapper>,
  );
  return { editor, source };
}

async function type(ed: Editor, text: string) {
  await act(async () => {
    ed.commands.focus("end");
    ed.commands.insertContent(text);
  });
}

function pressKey(ed: Editor, k: string, init: KeyboardEventInit = {}) {
  let handled = false;
  act(() => {
    const event = new KeyboardEvent("keydown", { key: k, ...init });
    handled = ed.view.someProp("handleKeyDown", (f) => f(ed.view, event)) ?? false;
  });
  return handled;
}

describe("the / menu in the editor", () => {
  it("opens only when / starts the message", async () => {
    const { editor: ed } = makeEditor();
    await type(ed, "hello /");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await act(async () => {
      ed.commands.clearContent();
    });
    await type(ed, "/");
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  });

  it("puts a chip that is sent as the raw command, and shows its hint without sending it", async () => {
    const { editor: ed } = makeEditor();
    await type(ed, "/comp");
    await waitFor(() => expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/compact"));
    expect(pressKey(ed, "Enter")).toBe(true);

    expect(ed.view.dom.querySelector(".slash-command")).toHaveTextContent("/compact");
    expect(ed.view.dom.querySelector(".slash-command-hint")).toHaveTextContent("[instructions]");
    expect(ed.getMarkdown()).toBe("/compact ");

    await type(ed, "keep the plan");
    expect(ed.view.dom.querySelector(".slash-command-hint")).toBeNull();
    expect(ed.getMarkdown()).toBe("/compact keep the plan");
  });

  it("sends a Codex skill as `$name`", async () => {
    const { editor: ed } = makeEditor(menu({ provider: "codex", commands: [] }));
    await type(ed, "/deploy");
    await waitFor(() => expect(screen.getByRole("option", { selected: true })).toHaveTextContent("$deploy-prod"));
    pressKey(ed, "Enter");
    expect(ed.getMarkdown()).toBe("$deploy-prod ");
  });

  it("does not escape the invocation", async () => {
    const { editor: ed } = makeEditor(menu({ commands: [command("my_command*x")] }));
    await type(ed, "/my_");
    await waitFor(() => expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/my_command*x"));
    pressKey(ed, "Tab");
    await type(ed, "a_b");
    expect(ed.getMarkdown()).toBe("/my_command*x a_b");
  });

  it("leaves Mod-Enter to the editor's own submit", async () => {
    const { editor: ed } = makeEditor();
    await type(ed, "/compact");
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    expect(pressKey(ed, "Enter", { metaKey: true })).toBe(false);
    expect(ed.getMarkdown()).toBe("/compact");
  });

  it("still reads old skill links", async () => {
    const { editor: ed } = makeEditor();
    await act(async () => {
      ed.commands.setContent("[/deploy](slash://skill/s1) now", { contentType: "markdown" });
    });
    expect(ed.view.dom.querySelector(".slash-command")).toHaveTextContent("/deploy");
    expect(ed.getMarkdown()).toBe("[/deploy](slash://skill/s1) now");
  });
});
