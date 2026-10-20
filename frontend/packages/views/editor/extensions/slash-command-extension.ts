import Mention from "@tiptap/extension-mention";
import { mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { SlashCommandView } from "./slash-command-view";
import { formatSlashCommandLabel, slashCommandChipText } from "./slash-command-utils";

const hintPluginKey = new PluginKey("slashCommandHint");

/**
 * The argument hint of a chip that starts the message, while nothing follows
 * it yet: a widget after the caret, the way a placeholder sits. It is a
 * decoration, not content, so it is never part of what is sent.
 */
function slashCommandHint(doc: ProseMirrorNode): DecorationSet {
  const paragraph = doc.firstChild;
  const chip = paragraph?.type.name === "paragraph" ? paragraph.firstChild : null;
  const hint = chip?.type.name === "slashCommand" && typeof chip.attrs.hint === "string" ? chip.attrs.hint.trim() : "";
  if (!paragraph || !chip || !hint || doc.childCount > 1) return DecorationSet.empty;
  const rest = paragraph.textBetween(chip.nodeSize, paragraph.content.size, "\n", "\n");
  if (rest.trim() !== "") return DecorationSet.empty;
  const widget = () => {
    const span = document.createElement("span");
    span.className = "slash-command-hint";
    span.setAttribute("aria-hidden", "true");
    span.contentEditable = "false";
    span.textContent = hint;
    return span;
  };
  // Inside the paragraph, at its end: just after the space that follows the chip.
  return DecorationSet.create(doc, [Decoration.widget(1 + paragraph.content.size, widget, { side: 1, key: `hint:${hint}` })]);
}

export const SlashCommandExtension = Mention.extend({
  name: "slashCommand",

  addNodeView() {
    return ReactNodeViewRenderer(SlashCommandView);
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(
        { "data-type": "slash-command" },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      slashCommandChipText(node.attrs),
    ];
  },

  renderText({ node }) {
    return slashCommandChipText(node.attrs);
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      // What the message starts with: `/compact`, `/deploy-prod`, `$deploy-prod`.
      // Old chips (`slash://skill/…` links) have none.
      invocation: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-invocation"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.invocation === "string" ? { "data-invocation": attributes.invocation } : {},
      },
      // The argument hint: decoration only, never rendered into the message.
      hint: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: hintPluginKey,
        props: { decorations: (state) => slashCommandHint(state.doc) },
      }),
    ];
  },

  parseHTML() {
    return [{ tag: 'span[data-type="slash-command"]' }];
  },

  markdownTokenizer: {
    name: "slashCommand",
    level: "inline" as const,
    start(src: string) {
      return src.search(/\[\/(?:\\.|[^\]])+\]\(slash:\/\/skill\//);
    },
    tokenize(src: string) {
      const match = src.match(
        /^\[\/((?:\\.|[^\]])+)\]\(slash:\/\/skill\/([^)]+)\)/,
      );
      if (!match) return undefined;
      const rawLabel = match[1]?.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
      return {
        type: "slashCommand",
        raw: match[0],
        attributes: { label: rawLabel, id: match[2] },
      };
    },
  },

  parseMarkdown: (token: any, helpers: any) => {
    return helpers.createNode("slashCommand", token.attributes);
  },

  renderMarkdown: (node: any) => {
    const { id, label, invocation } = node.attrs || {};
    // A chip from the `/` menu is sent as the agent reads it: the raw command.
    if (typeof invocation === "string" && invocation) return invocation;
    const safeLabel = formatSlashCommandLabel(label)
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
    return `[/${safeLabel}](slash://skill/${id})`;
  },
});
