import { describe, it, expect, vi } from "vitest";
import { getExtensionField } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { createSubmitExtension } from "./submit-shortcut";

function getShortcuts(
  ext: ReturnType<typeof createSubmitExtension>,
  editor: Partial<Editor>,
): Record<string, () => boolean> {
  const fn = getExtensionField<
    () => Record<string, () => boolean>
  >(ext, "addKeyboardShortcuts", {
    name: "submitShortcut",
    options: {},
    storage: {},
    editor: editor as Editor,
    type: null,
  });
  return fn?.() ?? {};
}

describe("createSubmitExtension", () => {
  const baseEditor = {
    view: { composing: false } as unknown as Editor["view"],
    isActive: () => false,
  } as Partial<Editor>;

  it("Mod-Enter always submits in the default mode", () => {
    const onSubmit = vi.fn(() => true);
    const shortcuts = getShortcuts(
      createSubmitExtension(onSubmit, { submitOnEnter: false }),
      baseEditor,
    );

    expect(shortcuts["Mod-Enter"]).toBeDefined();
    expect(shortcuts["Mod-Enter"]!()).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ invert: false });
  });

  it("leaves Mod-Shift-Enter unbound unless the editor has an inverted mode", () => {
    const shortcuts = getShortcuts(
      createSubmitExtension(vi.fn(() => true), { submitOnEnter: false }),
      baseEditor,
    );
    expect(shortcuts["Mod-Shift-Enter"]).toBeUndefined();
  });

  it("Mod-Shift-Enter submits in the inverted mode", () => {
    const onSubmit = vi.fn(() => true);
    const shortcuts = getShortcuts(
      createSubmitExtension(onSubmit, { submitOnEnter: false, invertibleSubmit: true }),
      baseEditor,
    );

    expect(shortcuts["Mod-Shift-Enter"]!()).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({ invert: true });
  });

  it("returns false when no submit handler is wired so the key falls through", () => {
    const shortcuts = getShortcuts(
      createSubmitExtension(() => false, { submitOnEnter: false, invertibleSubmit: true }),
      baseEditor,
    );

    expect(shortcuts["Mod-Enter"]!()).toBe(false);
    expect(shortcuts["Mod-Shift-Enter"]!()).toBe(false);
  });

  it.each(["Mod-Enter", "Mod-Shift-Enter"])("%s is suppressed during IME composition", (key) => {
    const onSubmit = vi.fn(() => true);
    const shortcuts = getShortcuts(
      createSubmitExtension(onSubmit, { submitOnEnter: false, invertibleSubmit: true }),
      {
        view: { composing: true } as unknown as Editor["view"],
        isActive: () => false,
      },
    );

    expect(shortcuts[key]!()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("bare Enter is not bound when submitOnEnter is false", () => {
    const onSubmit = vi.fn(() => true);
    const shortcuts = getShortcuts(
      createSubmitExtension(onSubmit, { submitOnEnter: false }),
      baseEditor,
    );

    expect(shortcuts.Enter).toBeUndefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("bare Enter submits when submitOnEnter is true", () => {
    const onSubmit = vi.fn(() => true);
    const shortcuts = getShortcuts(
      createSubmitExtension(onSubmit, { submitOnEnter: true }),
      baseEditor,
    );

    expect(shortcuts.Enter).toBeDefined();
    expect(shortcuts.Enter!()).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ invert: false });
  });

  it("Enter is suppressed during IME composition", () => {
    const onSubmit = vi.fn(() => true);
    const shortcuts = getShortcuts(
      createSubmitExtension(onSubmit, { submitOnEnter: true }),
      {
        view: { composing: true } as unknown as Editor["view"],
        isActive: () => false,
      },
    );

    expect(shortcuts.Enter!()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter is suppressed inside a code block", () => {
    const onSubmit = vi.fn(() => true);
    const shortcuts = getShortcuts(
      createSubmitExtension(onSubmit, { submitOnEnter: true }),
      {
        view: { composing: false } as unknown as Editor["view"],
        isActive: (name: string) => name === "codeBlock",
      },
    );

    expect(shortcuts.Enter!()).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("createSubmitExtension in a real editor", () => {
  async function mount(onSubmit: (options: { invert: boolean }) => boolean) {
    const [{ Editor }, { default: Document }, { default: Paragraph }, { default: Text }] = await Promise.all([
      import("@tiptap/core"), import("@tiptap/extension-document"),
      import("@tiptap/extension-paragraph"), import("@tiptap/extension-text"),
    ]);
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [Document, Paragraph, Text, createSubmitExtension(onSubmit, { submitOnEnter: false, invertibleSubmit: true })],
      content: "<p>hello</p>",
    });
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
      return editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event)) ?? false;
    };
    return { editor, press, element };
  }

  it("maps Mod-Enter and Mod-Shift-Enter through the keymap and ignores both while composing", async () => {
    const onSubmit = vi.fn(() => true);
    const { editor, press, element } = await mount(onSubmit);
    try {
      const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
      expect(press(mod)).toBe(true);
      expect(press({ ...mod, shiftKey: true })).toBe(true);
      expect(onSubmit.mock.calls).toEqual([[{ invert: false }], [{ invert: true }]]);
      press({});
      expect(onSubmit).toHaveBeenCalledTimes(2);
      (editor.view as unknown as { input: { composing: boolean } }).input.composing = true;
      expect(editor.view.composing).toBe(true);
      expect(press(mod)).toBe(false);
      expect(press({ ...mod, shiftKey: true })).toBe(false);
      expect(onSubmit).toHaveBeenCalledTimes(2);
    } finally {
      editor.destroy();
      element.remove();
    }
  });
});
