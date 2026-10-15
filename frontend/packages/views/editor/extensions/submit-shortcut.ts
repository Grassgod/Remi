import { Extension } from "@tiptap/core";

/**
 * `invert` asks the submit handler to use the other of its two submit modes
 * for this one message. Chat uses it while a run is active to switch between
 * steering the run and queueing the message; other editors ignore it.
 */
export interface SubmitOptions {
  invert: boolean;
}

/**
 * `onSubmit` must return true when it actually handled the event and false
 * when there's no submit handler wired up. That lets us fall through to the
 * default Enter behaviour — inserting a newline — when appropriate.
 *
 * `Mod-Enter` submits. `invertibleSubmit` also binds `Mod-Shift-Enter` to
 * submit with `invert: true`; editors without a second mode leave that key
 * unbound, as before. `submitOnEnter` — when true, bare Enter also submits
 * (chat-style). When false, bare Enter keeps its default (newline).
 *
 * No shortcut submits while an IME composition is open: `view.composing` is
 * set by ProseMirror between compositionstart and compositionend, so the
 * Enter that confirms a pinyin or kana candidate never sends the message.
 */
export function createSubmitExtension(
  onSubmit: (options: SubmitOptions) => boolean,
  { submitOnEnter, invertibleSubmit = false }: { submitOnEnter: boolean; invertibleSubmit?: boolean },
) {
  return Extension.create({
    name: "submitShortcut",
    addKeyboardShortcuts() {
      const submit = (invert: boolean) => () => {
        if (this.editor.view.composing) return false;
        return onSubmit({ invert });
      };
      const shortcuts: Record<string, () => boolean> = { "Mod-Enter": submit(false) };
      if (invertibleSubmit) shortcuts["Mod-Shift-Enter"] = submit(true);
      if (submitOnEnter) {
        shortcuts.Enter = () => {
          const editor = this.editor;
          if (editor.view.composing) return false;
          // Let Enter insert a newline inside a code block.
          if (editor.isActive("codeBlock")) return false;
          return onSubmit({ invert: false });
        };
      }
      return shortcuts;
    },
  });
}
