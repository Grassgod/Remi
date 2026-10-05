/**
 * Post-mount enhancement of one pre-rendered log row (MUL-403 plan 3/6 §3).
 *
 * `body_html` is final markup: the server rendered it with the same
 * remark/rehype/sanitize stack the client uses (`renderMarkdown`, C4), so the
 * list does **not** re-parse or re-highlight it. What the server deliberately
 * leaves out is the interactive chrome, because it is React, not markup:
 *
 * - a copy button on every code block;
 * - a live Mermaid diagram, or a sandboxed HTML preview, where a fence asked
 *   for one.
 * - a file card inside the server's statically reserved 40px slot.
 *
 * Everything this module does has to be **height-neutral**: the row it runs in
 * has already been positioned by `useAnchoredReveal`, and its height is what
 * the stick hook compensates against. Concretely:
 *
 * - the copy button is absolutely positioned inside a wrapper that adds no box
 *   of its own, and it is `opacity`-only, so it cannot contribute height;
 * - a preview replaces its `<pre>` with a slot whose fixed height is the height
 *   that `<pre>` already had, so the swap is invisible to layout and the
 *   preview (which loads asynchronously) is clipped or scrolled inside a box
 *   that never grows.
 *
 * Which `<pre>` is which fence is decided by content rather than by class name:
 * Shiki's output keeps no `language-` class (C4 replaces the sanitized
 * `<pre><code>` with highlighted markup after sanitize), and this layer may not
 * add one because the render pipeline belongs to C4. So each `<pre>`'s text is
 * matched against the ordered fences of `body_md`, the same markdown the HTML
 * was rendered from. An indented (non-fenced) code block matches no fence and
 * stays a plain block, which is the correct outcome.
 */

import { copyText } from "@multiremi/ui/lib/clipboard";
import { isAllowedFileCardHref } from "@multiremi/ui/markdown";

/** Preview kinds the list renders inside a fixed-height slot. */
export type EntryPreviewKind = "mermaid" | "html";

export interface EntryPreviewSlot {
  kind: EntryPreviewKind;
  /** The fixed-height box the caller portals the preview component into. */
  element: HTMLElement;
  /** Fence body, verbatim: the diagram or HTML source the preview renders. */
  source: string;
  /** Height of the block this slot replaced, in CSS pixels. */
  heightPx: number;
}

export interface EntryFileCardSlot {
  kind: "fileCard";
  element: HTMLElement;
  href: string;
  filename: string;
  allowed: boolean;
  heightPx: number;
}

export type EntryEnhancementSlot = EntryPreviewSlot | EntryFileCardSlot;

// Re-running also restores removed preview blocks and releases old listeners.
const activeEnhancements = new WeakMap<HTMLElement, () => void>();

export interface EnhanceEntryHtmlOptions {
  /** The same markdown `body_html` was rendered from. */
  markdown: string;
  /** `aria-label` for a code block's copy button. */
  copyLabel: string;
  /** `aria-label` while the copy just succeeded. */
  copiedLabel: string;
  /** Injected clipboard so tests do not need a real permission prompt. */
  writeClipboard?: (text: string) => void | Promise<void>;
}

export interface EnhancedEntryHtml {
  /** Slots to portal previews into. Empty when the row has no such fence. */
  slots: EntryEnhancementSlot[];
  /** Reverts the mutations this call made. Safe to call more than once. */
  dispose(): void;
}

/** Marks a wrapper this module created, so a re-run replaces it. */
export const CODE_BLOCK_ATTR = "data-entry-code-block";
/** The copy button, addressed by tests. */
export const COPY_BUTTON_ATTR = "data-entry-copy";
/** Marks the fixed-height box a preview was portalled into. */
export const PREVIEW_SLOT_ATTR = "data-entry-preview";

/** How long the copy button shows its check mark. */
export const COPIED_FEEDBACK_MS = 2_000;

interface Fence {
  language: string;
  body: string;
}

/**
 * Ordered fenced code blocks of a markdown document.
 *
 * A deliberately small parser: only backtick fences of three or more at the
 * start of a line are considered, the info string's first word is the
 * language, and the fence closes on a line of at least as many backticks. That
 * is the subset `renderMarkdown` turns into a highlighted block; tilde fences
 * and indented blocks produce plain `<pre>` elements, which this module leaves
 * alone.
 */
export function parseFences(markdown: string): Fence[] {
  const lines = markdown.split("\n");
  const fences: Fence[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = /^(`{3,})\s*(.*)$/.exec(lines[index] ?? "");
    if (!opening) {
      index += 1;
      continue;
    }
    const marker = opening[1] ?? "```";
    const language = (opening[2] ?? "").trim().split(/[\s:{]/)[0]?.toLowerCase() ?? "";
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index] ?? "")) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    // Skip the closing fence when there is one.
    if (index < lines.length) index += 1;
    fences.push({ language, body: body.join("\n") });
  }
  return fences;
}

/** Trailing whitespace is not part of a block's identity. */
function normalizeCode(value: string): string {
  return value.replace(/\s+$/u, "");
}

/**
 * Pair each code block in the rendered DOM with the fence it came from.
 *
 * Matching is by content, so an indented code block (which has no fence) cannot
 * shift every later block onto the wrong language the way a positional pairing
 * would. Each fence is claimed at most once.
 */
function matchFences(blocks: readonly HTMLElement[], fences: readonly Fence[]): Array<Fence | null> {
  const used = new Set<number>();
  return blocks.map((block) => {
    const text = normalizeCode(block.textContent ?? "");
    if (!text) return null;
    const found = fences.findIndex(
      (fence, index) => !used.has(index) && normalizeCode(fence.body) === text,
    );
    if (found === -1) return null;
    used.add(found);
    return fences[found] ?? null;
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";
const COPY_ICON_PATH = "M9 9h10v10H9zM5 15V5h10";
const CHECK_ICON_PATH = "M4 12l5 5L20 6";

/** A copy/check glyph, so this layer needs no icon library. */
function copyIcon(document: Document, path: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(SVG_NS, "path");
  shape.setAttribute("d", path);
  svg.appendChild(shape);
  return svg;
}

interface CopyButtonOptions {
  code: string;
  label: string;
  copiedLabel: string;
  write: (text: string) => void | Promise<void>;
}

/**
 * One absolutely positioned copy button.
 *
 * `opacity` carries the hover reveal because it cannot affect layout, and the
 * element is taken out of flow so a wide label or a focus ring cannot reflow
 * the block it belongs to.
 */
function buildCopyButton(
  document: Document,
  options: CopyButtonOptions,
): { element: HTMLButtonElement; dispose(): void } {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(COPY_BUTTON_ATTR, "");
  button.setAttribute("aria-label", options.label);
  button.title = options.label;
  button.style.cssText = [
    "position:absolute",
    "top:6px",
    "right:6px",
    "margin:0",
    "padding:2px",
    "line-height:0",
    "border-radius:4px",
    "border:0",
    "background:transparent",
    "color:inherit",
    "cursor:pointer",
    "opacity:0",
  ].join(";");
  button.appendChild(copyIcon(document, COPY_ICON_PATH));

  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const show = (): void => {
    button.style.opacity = "1";
  };
  const hide = (): void => {
    button.style.opacity = "0";
  };
  const resetFeedback = (): void => {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    button.replaceChildren(copyIcon(document, COPY_ICON_PATH));
    button.setAttribute("aria-label", options.label);
  };
  const markCopied = (): void => {
    resetFeedback();
    button.replaceChildren(copyIcon(document, CHECK_ICON_PATH));
    button.setAttribute("aria-label", options.copiedLabel);
    resetTimer = setTimeout(() => {
      resetTimer = null;
      resetFeedback();
    }, COPIED_FEEDBACK_MS);
  };
  const onClick = (): void => {
    let result: void | Promise<void>;
    try {
      result = options.write(options.code);
    } catch {
      return;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).then(markCopied, () => undefined);
      return;
    }
    markCopied();
  };

  button.addEventListener("mouseenter", show);
  button.addEventListener("mouseleave", hide);
  button.addEventListener("focus", show);
  button.addEventListener("blur", hide);
  button.addEventListener("click", onClick);
  return {
    element: button,
    dispose: () => {
      if (resetTimer !== null) clearTimeout(resetTimer);
      button.removeEventListener("mouseenter", show);
      button.removeEventListener("mouseleave", hide);
      button.removeEventListener("focus", show);
      button.removeEventListener("blur", hide);
      button.removeEventListener("click", onClick);
      button.remove();
    },
  };
}

/**
 * Enhance one row in place.
 *
 * Returns the preview slots the caller has to fill (this module has no React)
 * and a `dispose` that undoes every mutation it made. Runs synchronously and
 * before paint: the preview slot's height is read from the block it replaces in
 * the same task, so nothing between the two has a chance to lay out.
 */
export function enhanceEntryHtml(
  container: HTMLElement,
  options: EnhanceEntryHtmlOptions,
): EnhancedEntryHtml {
  activeEnhancements.get(container)?.();
  const document = container.ownerDocument;
  const write = options.writeClipboard
    ?? (async (text: string) => {
      if (!await copyText(text)) throw new Error("Could not copy code block");
    });

  const disposers: Array<() => void> = [];
  const blocks = [...container.querySelectorAll("pre")].filter(
    (pre): pre is HTMLPreElement => pre instanceof HTMLPreElement && !pre.closest('div[data-type="fileCard"]'),
  );
  const fences = matchFences(blocks, parseFences(options.markdown));
  const slots: EntryEnhancementSlot[] = [];

  const cards = [...container.querySelectorAll<HTMLElement>('div[data-type="fileCard"]')]
    .filter(card => !card.parentElement?.closest('div[data-type="fileCard"]'));
  for (const card of cards) {
    const href = card.getAttribute("data-href") ?? "";
    const filename = card.getAttribute("data-filename") ?? "";
    const originalChildren = [...card.childNodes];
    const slot = document.createElement("div");
    slot.setAttribute(PREVIEW_SLOT_ATTR, "fileCard");
    card.replaceChildren(slot);
    disposers.push(() => card.replaceChildren(...originalChildren));
    slots.push({ kind: "fileCard", element: slot, href, filename,
      allowed: isAllowedFileCardHref(href), heightPx: card.getBoundingClientRect().height });
  }

  for (const [index, block] of blocks.entries()) {
    const fence = fences[index] ?? null;
    const button = buildCopyButton(document, {
      code: block.textContent ?? "",
      label: options.copyLabel,
      copiedLabel: options.copiedLabel,
      write,
    });
    disposers.push(button.dispose);

    const kind: EntryPreviewKind | null = fence?.language === "mermaid"
      ? "mermaid"
      : fence?.language === "html"
        ? "html"
        : null;

    // The wrapper is the positioning context for the button and adds no box of
    // its own, so wrapping a block leaves its height exactly as measured.
    const originalStyle = block.getAttribute("style");
    const heightPx = block.getBoundingClientRect().height;
    const margin = document.defaultView?.getComputedStyle(block).margin ?? "0";
    const wrapper = document.createElement("div");
    wrapper.setAttribute(CODE_BLOCK_ATTR, "");
    wrapper.style.cssText = `position:relative;display:flow-root;margin:${margin};padding:0;border:0`;
    block.replaceWith(wrapper);
    wrapper.appendChild(block);
    block.style.margin = "0";
    disposers.push(() => {
      wrapper.replaceWith(block);
      if (originalStyle === null) block.removeAttribute("style");
      else block.setAttribute("style", originalStyle);
    });

    if (kind === null) {
      wrapper.appendChild(button.element);
      continue;
    }

    // A preview: swap the block for a slot of exactly the height the block had,
    // so the swap cannot move a pixel. The caller portals the real component in.
    const slot = document.createElement("div");
    slot.setAttribute(PREVIEW_SLOT_ATTR, kind);
    slot.style.cssText = [
      "position:relative",
      `height:${Math.max(0, heightPx)}px`,
      "overflow:auto",
      "margin:0",
    ].join(";");
    block.replaceWith(slot);
    block.remove();
    disposers.push(() => {
      slot.replaceWith(block);
    });
    wrapper.appendChild(slot);
    wrapper.appendChild(button.element);
    slots.push({ kind, element: slot, source: fence?.body ?? "", heightPx });
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const undo of [...disposers].reverse()) undo();
    if (activeEnhancements.get(container) === dispose) activeEnhancements.delete(container);
  };
  activeEnhancements.set(container, dispose);
  return {
    slots,
    dispose,
  };
}
