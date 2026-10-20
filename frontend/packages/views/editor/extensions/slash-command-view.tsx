"use client";

import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { slashCommandChipText } from "./slash-command-utils";

export function SlashCommandView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className="inline">
      <span className="slash-command">{slashCommandChipText(node.attrs)}</span>
    </NodeViewWrapper>
  );
}
