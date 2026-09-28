import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_BLOCK_ATTR,
  COPIED_FEEDBACK_MS,
  COPY_BUTTON_ATTR,
  enhanceEntryHtml,
  parseFences,
  PREVIEW_SLOT_ATTR,
} from "./enhance";

/** Records every height read, so "the slot copied the block's height" is assertable. */
function makeContainer(html: string, heights: number[] = []): { container: HTMLDivElement; reads: number[] } {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const reads: number[] = [];
  for (const [index, pre] of [...container.querySelectorAll("pre")].entries()) {
    const height = heights[index] ?? 100;
    pre.getBoundingClientRect = () => ({ height, top: 0, bottom: height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    reads.push(height);
  }
  return { container, reads };
}

const COPY = { copyLabel: "Copy code", copiedLabel: "Copied" };

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseFences", () => {
  it("reads the language from the info string and the body verbatim", () => {
    const fences = parseFences(["```js", "const a = 1;", "```", "", "```mermaid", "graph TD;", "```"].join("\n"));
    expect(fences).toEqual([
      { language: "js", body: "const a = 1;" },
      { language: "mermaid", body: "graph TD;" },
    ]);
  });

  it("keeps a fence whose body is empty and ignores a bare closing run", () => {
    expect(parseFences("```html\n```")).toEqual([{ language: "html", body: "" }]);
    expect(parseFences(["````", "```", "````"].join("\n"))).toEqual([{ language: "", body: "```" }]);
  });

  it("does not treat an indented block or a tilde fence as a fence", () => {
    expect(parseFences("    indented code")).toEqual([]);
    expect(parseFences(["~~~js", "x", "~~~"].join("\n"))).toEqual([]);
  });
});

describe("enhanceEntryHtml", () => {
  it("adds one copy button per code block without adding a box of its own", () => {
    const html = [
      "<p>text</p>",
      '<pre class="shiki"><code>const a = 1;</code></pre>',
      "<p>more</p>",
      '<pre class="shiki"><code>const b = 2;</code></pre>',
    ].join("");
    const { container } = makeContainer(html);
    const markdown = ["```js", "const a = 1;", "```", "", "```js", "const b = 2;", "```"].join("\n");

    const enhanced = enhanceEntryHtml(container, { ...COPY, markdown, writeClipboard: () => {} });
    const buttons = container.querySelectorAll(`[${COPY_BUTTON_ATTR}]`);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Copy code");
    // Absolutely positioned, so it is outside the flow that determines height.
    expect((buttons[0] as HTMLElement).style.position).toBe("absolute");
    // The block keeps its place: one wrapper per block, and the <pre> survives.
    expect(container.querySelectorAll(`[${CODE_BLOCK_ATTR}]`)).toHaveLength(2);
    expect(container.querySelectorAll("pre")).toHaveLength(2);
    enhanced.dispose();
  });

  it("copies the block's own text and shows the check mark for the feedback window", async () => {
    vi.useFakeTimers();
    const html = '<pre class="shiki"><code>const a = 1;</code></pre>';
    const { container } = makeContainer(html);
    const written: string[] = [];
    const enhanced = enhanceEntryHtml(container, {
      ...COPY,
      markdown: ["```js", "const a = 1;", "```"].join("\n"),
      writeClipboard: (text) => {
        written.push(text);
      },
    });

    const button = container.querySelector(`[${COPY_BUTTON_ATTR}]`) as HTMLButtonElement;
    button.click();
    expect(written).toEqual(["const a = 1;"]);
    expect(button.getAttribute("aria-label")).toBe("Copied");

    vi.advanceTimersByTime(COPIED_FEEDBACK_MS + 1);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
    enhanced.dispose();
  });

  it("swaps a mermaid fence for a fixed-height slot carrying the fence source", () => {
    const html = '<pre class="shiki"><code>graph TD; A--&gt;B;</code></pre>';
    const { container } = makeContainer(html, [264]);
    const enhanced = enhanceEntryHtml(container, {
      ...COPY,
      markdown: ["```mermaid", "graph TD; A-->B;", "```"].join("\n"),
    });

    const slot = container.querySelector(`[${PREVIEW_SLOT_ATTR}="mermaid"]`) as HTMLElement;
    expect(slot).not.toBeNull();
    // The slot takes exactly the height the block had, so the swap cannot move
    // anything above or below it.
    expect(slot.style.height).toBe("264px");
    expect(slot.style.position).toBe("relative");
    expect(slot.style.overflow).toBe("auto");
    expect(enhanced.slots).toHaveLength(1);
    expect(enhanced.slots[0]).toMatchObject({ kind: "mermaid", heightPx: 264, source: "graph TD; A-->B;" });
    // The block itself is gone from the document: nothing double-renders.
    expect(container.querySelector("pre")).toBeNull();
    enhanced.dispose();
  });

  it("routes an html fence to the html slot, and leaves an unknown language alone", () => {
    const html = '<pre><code>&lt;p&gt;hi&lt;/p&gt;</code></pre><pre><code>plain</code></pre>';
    const { container } = makeContainer(html, [480, 40]);
    const enhanced = enhanceEntryHtml(container, {
      ...COPY,
      markdown: ["```html", "<p>hi</p>", "```", "", "```rust", "plain", "```"].join("\n"),
    });
    expect(container.querySelector(`[${PREVIEW_SLOT_ATTR}="html"]`)).not.toBeNull();
    expect(container.querySelectorAll(`[${PREVIEW_SLOT_ATTR}]`)).toHaveLength(1);
    // The rust block is not a preview kind; it keeps its <pre> and gains a button.
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelectorAll(`[${COPY_BUTTON_ATTR}]`)).toHaveLength(2);
    expect(enhanced.slots.map((slot) => slot.kind)).toEqual(["html"]);
    enhanced.dispose();
  });

  it("pairs blocks with fences by content, so an indented block cannot shift the languages", () => {
    // A non-fenced block first, then a mermaid fence: positional pairing would
    // hand the indented text the mermaid language and lose the preview.
    const html = '<pre><code>indented</code></pre><pre class="shiki"><code>graph TD;</code></pre>';
    const { container } = makeContainer(html, [24, 120]);
    const enhanced = enhanceEntryHtml(container, {
      ...COPY,
      markdown: "    indented\n\n```mermaid\ngraph TD;\n```",
    });
    expect(enhanced.slots.map((slot) => slot.kind)).toEqual(["mermaid"]);
    expect(container.querySelectorAll(`[${PREVIEW_SLOT_ATTR}]`)).toHaveLength(1);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    enhanced.dispose();
  });

  it("restores the original markup on dispose, including the previews", () => {
    const html = '<p>x</p><pre class="shiki"><code>graph TD;</code></pre>';
    const { container } = makeContainer(html, [120]);
    const before = container.innerHTML;
    const enhanced = enhanceEntryHtml(container, {
      ...COPY,
      markdown: ["```mermaid", "graph TD;", "```"].join("\n"),
    });
    expect(container.innerHTML).not.toBe(before);

    enhanced.dispose();
    expect(container.innerHTML).toBe(before);
    expect(container.querySelectorAll(`[${COPY_BUTTON_ATTR}]`)).toHaveLength(0);
    // Idempotent: a second dispose must not throw or re-remove nodes.
    enhanced.dispose();
    expect(container.innerHTML).toBe(before);
  });

  it("replaces its own wrappers when it runs twice, instead of nesting them", () => {
    const html = '<pre class="shiki"><code>a</code></pre>';
    const { container } = makeContainer(html);
    const markdown = ["```js", "a", "```"].join("\n");
    enhanceEntryHtml(container, { ...COPY, markdown, writeClipboard: () => {} });
    const second = enhanceEntryHtml(container, { ...COPY, markdown, writeClipboard: () => {} });

    expect(container.querySelectorAll(`[${CODE_BLOCK_ATTR}]`)).toHaveLength(1);
    expect(container.querySelectorAll(`[${COPY_BUTTON_ATTR}]`)).toHaveLength(1);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    second.dispose();
  });

  it("survives a container with no code blocks", () => {
    const { container } = makeContainer("<p>just text</p>");
    const enhanced = enhanceEntryHtml(container, { ...COPY, markdown: "just **text**" });
    expect(enhanced.slots).toEqual([]);
    expect(container.innerHTML).toBe("<p>just text</p>");
    enhanced.dispose();
  });
});
