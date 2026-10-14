import { forwardRef, useRef, useImperativeHandle } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { UploadResult } from "@multiremi/core/hooks/use-file-upload";
import enCommon from "../../locales/en/common.json";
import enChat from "../../locales/en/chat.json";

function makeUpload(
  overrides: Partial<UploadResult> & {
    id: string;
    link: string;
    filename: string;
  },
): UploadResult {
  return {
    workspace_id: "ws-1",
    issue_id: null,
    comment_id: null,
    chat_session_id: null,
    chat_message_id: null,
    uploader_type: "member",
    uploader_id: "user-1",
    url: overrides.link,
    download_url: overrides.link,
    content_type: "image/png",
    size_bytes: 1,
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

const TEST_RESOURCES = { en: { common: enCommon, chat: enChat } };

// Track drop-zone callbacks so the test can simulate a real drop.
const dropHandlers = vi.hoisted(() => ({
  onDrop: null as null | ((files: File[]) => void),
}));
const editorProps = vi.hoisted(() => ({
  last: null as null | Record<string, unknown>,
  setContent: vi.fn(),
  /** Mimic ContentEditor's own defaultValue sync of a clean editor. */
  syncDefault: false,
}));
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@multiremi/core/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multiremi/core/logger")>();
  return { ...actual, createLogger: () => logger };
});

vi.mock("../../editor", () => ({
  useFileDropZone: ({ onDrop }: { onDrop: (files: File[]) => void }) => {
    dropHandlers.onDrop = onDrop;
    return { isDragOver: false, dropZoneProps: { "data-testid": "drop-zone" } };
  },
  FileDropOverlay: () => null,
  ContentEditor: forwardRef(function MockContentEditor(
    props: {
      defaultValue?: string;
      onUpdate?: (md: string) => void;
      placeholder?: string;
      onUploadFile?: (file: File) => Promise<UploadResult | null>;
      mentionMode?: string;
      mentionContextItems?: unknown[];
    },
    ref: React.Ref<unknown>,
  ) {
    const { defaultValue, onUpdate, placeholder, onUploadFile } = props;
    editorProps.last = props as unknown as Record<string, unknown>;
    const valueRef = useRef<string>(defaultValue ?? "");
    const lastDefault = useRef<string>(defaultValue ?? "");
    if (editorProps.syncDefault && (defaultValue ?? "") !== lastDefault.current) {
      if (valueRef.current === lastDefault.current) valueRef.current = defaultValue ?? "";
      lastDefault.current = defaultValue ?? "";
    }
    const uploadingRef = useRef(0);
    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      clearContent: () => {
        valueRef.current = "";
      },
      setContent: (markdown: string) => {
        editorProps.setContent(markdown);
        valueRef.current = markdown;
      },
      blur: () => {},
      focus: () => {},
      uploadFile: async (file: File) => {
        uploadingRef.current += 1;
        try {
          const result = await onUploadFile?.(file);
          if (result) {
            valueRef.current = `${valueRef.current}![](${result.link})`.trim();
            onUpdate?.(valueRef.current);
          }
        } finally {
          uploadingRef.current = Math.max(0, uploadingRef.current - 1);
        }
      },
      hasActiveUploads: () => uploadingRef.current > 0,
    }));
    return (
      <textarea
        data-testid="editor"
        placeholder={placeholder}
        onChange={(e) => {
          valueRef.current = e.target.value;
          onUpdate?.(e.target.value);
        }}
      />
    );
  }),
}));

// Mock chat store with an in-memory implementation that supports both
// (selector) calls and getState().
vi.mock("@multiremi/core/chat", () => {
  const state = {
    activeSessionId: null as string | null,
    selectedAgentId: "agent-1",
    inputDrafts: {} as Record<string, string>,
    inputDraftAttachments: {} as Record<string, Record<string, string>>,
    localAttachmentDetails: {} as Record<string, UploadResult>,
    followUpMode: "steer" as "steer" | "queue",
    queueEdit: {} as Record<string, { itemId: string; revision: number; stash: { draft: string; attachments: Record<string, string> } }>,
    finishQueueEdit: vi.fn((key: string, outcome: "restore" | "keep") => {
      const edit = state.queueEdit[key];
      if (!edit) return;
      delete state.queueEdit[key];
      if (outcome === "restore") state.inputDrafts[key] = edit.stash.draft;
    }),
    setInputDraft: vi.fn((key: string, content: string) => {
      state.inputDrafts[key] = content;
    }),
    clearInputDraft: vi.fn((key: string) => {
      delete state.inputDrafts[key];
      delete state.inputDraftAttachments[key];
    }),
    setInputDraftAttachment: vi.fn((key: string, url: string, id: string) => {
      state.inputDraftAttachments[key] = {
        ...state.inputDraftAttachments[key],
        [url]: id,
      };
    }),
    setLocalAttachmentDetail: vi.fn((attachment: UploadResult) => {
      state.localAttachmentDetails[attachment.id] = attachment;
    }),
  };
  return {
    DRAFT_NEW_SESSION: "__draft_new__",
    useChatStore: Object.assign(
      (selector?: (s: typeof state) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state },
    ),
  };
});

import { ChatInput } from "./chat-input";
import { ApiError } from "@multiremi/core/api";
import { useChatStore } from "@multiremi/core/chat";
import { setCurrentWorkspace } from "@multiremi/core/platform";
beforeEach(() => {
  vi.clearAllMocks();
  setCurrentWorkspace("demo", "ws-1");
  const state = useChatStore.getState();
  state.inputDrafts = {};
  state.inputDraftAttachments = {};
  state.localAttachmentDetails = {};
  state.activeSessionId = null;
  state.selectedAgentId = "agent-1";
  state.followUpMode = "steer";
  state.queueEdit = {};
  editorProps.syncDefault = false;
});

/** The editor's Mod-Enter / Mod-Shift-Enter handler, as Tiptap calls it. */
function pressSubmitShortcut(invert: boolean) {
  const onSubmit = editorProps.last?.onSubmit as ((options: { invert: boolean }) => void) | undefined;
  act(() => onSubmit?.({ invert }));
}

function renderInput(
  props: Partial<React.ComponentProps<typeof ChatInput>> = {},
) {
  const onSend = props.onSend ?? vi.fn();
  const onUploadFile =
    props.onUploadFile ??
    vi.fn(async (_file: File) =>
      makeUpload({
        id: "att-1",
        link: "https://cdn.example/att-1.png",
        filename: "img.png",
      }),
    );
  const view = render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ChatInput
        onSend={onSend}
        onUploadFile={onUploadFile}
        agentName="Multiremi"
        {...props}
      />
    </I18nProvider>,
  );
  return { onSend, onUploadFile, ...view };
}

describe("ChatInput @ context wiring", () => {
  it("configures chat @ with current/recent issue/project context", () => {
    const contextItems = [
      {
        id: "issue-1",
        label: "MUL-1",
        type: "issue" as const,
        group: "current" as const,
      },
    ];

    renderInput({ contextItems });

    expect(editorProps.last?.mentionMode).toBe("context");
    expect(editorProps.last?.mentionContextItems).toBe(contextItems);
  });
});

describe("ChatInput attachment wiring", () => {
  it("routes dropped files through the editor's upload handler", async () => {
    const { onUploadFile } = renderInput();
    expect(dropHandlers.onDrop).not.toBeNull();
    const file = new File(["x"], "drop.png", { type: "image/png" });
    await act(async () => {
      dropHandlers.onDrop?.([file]);
      // Microtask: the mock editor awaits onUploadFile before mutating its value.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onUploadFile).toHaveBeenCalledWith(file);
  });

  it("passes attachment_ids to onSend for uploads still referenced in the content", async () => {
    const onSend = vi.fn();
    const onUploadFile = vi.fn(async (_file: File) =>
      makeUpload({
        id: "att-42",
        link: "https://cdn.example/att-42.png",
        filename: "x.png",
      }),
    );
    renderInput({ onSend, onUploadFile });

    // Simulate the drop → editor.uploadFile → onUploadFile happy path. The
    // mock editor appends the markdown link into its value and calls
    // onUpdate so the input flips out of the empty state.
    const file = new File(["x"], "drop.png", { type: "image/png" });
    await act(async () => {
      dropHandlers.onDrop?.([file]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Wait for the submit button to become enabled (onUpdate has fired and
    // React has re-rendered). SubmitButton has no aria-label, so we pick
    // the last action button on the bar (FileUploadButton, SubmitButton).
    let sendButton: HTMLElement;
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      sendButton = buttons[buttons.length - 1]!;
      expect(sendButton).not.toBeDisabled();
    });
    fireEvent.click(sendButton!);

    expect(onSend).toHaveBeenCalledTimes(1);
    const [, ids, localAttachments] = onSend.mock.calls[0]!;
    expect(ids).toEqual(["att-42"]);
    expect(localAttachments).toMatchObject([{ id: "att-42", filename: "x.png" }]);
  });

  it("disables send while an upload is in flight, re-enables after it resolves", async () => {
    let resolveUpload: (v: UploadResult) => void;
    const uploadPromise = new Promise<UploadResult>((res) => {
      resolveUpload = res;
    });
    const onSend = vi.fn();
    const onUploadFile = vi.fn(() => uploadPromise);
    renderInput({ onSend, onUploadFile });

    // Give the editor some text so isEmpty=false — this isolates the
    // disabled state to the pending-upload condition (otherwise both
    // checks would fire and the test couldn't tell them apart).
    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "preview text" },
    });

    const file = new File(["x"], "slow.png", { type: "image/png" });
    await act(async () => {
      dropHandlers.onDrop?.([file]);
      await Promise.resolve();
    });

    // While the upload is pending the SubmitButton must be disabled.
    // Bypassing this would send the message with the attachment id
    // missing from the body.
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const sendButton = buttons[buttons.length - 1]!;
      expect(sendButton).toBeDisabled();
    });

    await act(async () => {
      resolveUpload!(
        makeUpload({
          id: "att-slow",
          link: "https://cdn.example/att-slow.png",
          filename: "slow.png",
        }),
      );
      await Promise.resolve();
    });

    let sendButton: HTMLElement;
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      sendButton = buttons[buttons.length - 1]!;
      expect(sendButton).not.toBeDisabled();
    });
    fireEvent.click(sendButton!);
    expect(onSend).toHaveBeenCalledTimes(1);
    const [, ids] = onSend.mock.calls[0]!;
    expect(ids).toEqual(["att-slow"]);
  });

  it("does not render the file upload button when onUploadFile is omitted", () => {
    renderInput({ onUploadFile: undefined });
    // FileUploadButton renders an icon button labelled by its tooltip — when
    // upload wiring is absent the chat input falls back to "submit + extras"
    // only. Probe by counting buttons: with no upload, only the submit
    // button is in the action row.
    const buttons = screen.getAllByRole("button");
    // The agent picker may render zero buttons
    // in this test (no leftAdornment passed). So a single button = submit.
    expect(buttons.length).toBe(1);
  });
});

describe("ChatInput sending and queue", () => {
  it("retains the draft after failure and retries the same message", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    renderInput({ onSend });
    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "Please keep this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith("Please keep this", undefined, [], "send");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("retains the draft and attachment binding after a send failure", async () => {
    useChatStore.getState().activeSessionId = "session-1";
    const sensitiveToken = "secret-chat-token";
    const sensitiveBody = "private draft echoed by gateway";
    const sensitiveCause = "https://gateway.example/?authorization=secret";
    const error = new ApiError("send failed", 502, "Bad Gateway", {
      token: sensitiveToken,
      content: sensitiveBody,
    });
    Object.defineProperty(error, "cause", {
      value: new Error(sensitiveCause),
      enumerable: true,
    });
    const attachment = makeUpload({
      id: "att-failed",
      link: "https://cdn.example/failed.png",
      filename: "failed.png",
      chat_session_id: "session-1",
    });
    const onSend = vi.fn().mockRejectedValue(error);
    renderInput({
      onSend,
      onUploadFile: vi.fn().mockResolvedValue(attachment),
    });
    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "Keep this draft" },
    });
    await act(async () => {
      dropHandlers.onDrop?.([new File(["x"], "failed.png")]);
      await Promise.resolve();
      await Promise.resolve();
    });
    const content = "Keep this draft![](https://cdn.example/failed.png)";

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByRole("alert");
    expect(onSend).toHaveBeenCalledWith(content, ["att-failed"], [attachment], "send");
    expect(useChatStore.getState().inputDrafts["session-1"]).toBe(content);
    expect(useChatStore.getState().inputDraftAttachments["session-1"]).toEqual({
      "https://cdn.example/failed.png": "att-failed",
    });
    expect(logger.error).toHaveBeenCalledWith("input.send.error", {
      draftKey: "session-1",
      contentLength: content.length,
      attachmentCount: 1,
      error: {
        name: "ApiError",
        message: "send failed",
        status: 502,
        statusText: "Bad Gateway",
      },
    });
    const logged = JSON.stringify(logger.error.mock.calls[0]?.[1]);
    expect(logged).not.toContain(content);
    expect(logged).not.toContain(sensitiveToken);
    expect(logged).not.toContain(sensitiveBody);
    expect(logged).not.toContain(sensitiveCause);
  });

  it("does not send from an archived session", () => {
    const onSend = vi.fn();
    renderInput({ onSend, disabled: true });
    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "Blocked" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();
  });
});

it("retains uploaded attachment IDs when moving to another chat surface", async () => {
  useChatStore.getState().activeSessionId = "session-1";
  const uploaded = makeUpload({
    id: "att-cross",
    link: "https://cdn.example/cross.png",
    filename: "cross.png",
    chat_session_id: "session-1",
  });
  const panel = renderInput({
    onUploadFile: vi.fn().mockResolvedValue(uploaded),
  });
  await act(async () => {
    dropHandlers.onDrop?.([new File(["x"], "cross.png")]);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(useChatStore.getState().inputDraftAttachments["session-1"]).toEqual({
    "https://cdn.example/cross.png": "att-cross",
  });
  panel.unmount();
  const onSend = vi.fn().mockResolvedValue(undefined);
  renderInput({ onSend });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(onSend).toHaveBeenCalledWith("![](https://cdn.example/cross.png)", [
      "att-cross",
    ], [uploaded], "send"),
  );
  await waitFor(() =>
    expect(
      useChatStore.getState().inputDraftAttachments["session-1"],
    ).toBeUndefined(),
  );
});

it("does not write a late upload into a newly selected workspace", async () => {
  let finish!: (result: UploadResult) => void;
  const upload = new Promise<UploadResult>((resolve) => {
    finish = resolve;
  });
  renderInput({ onUploadFile: vi.fn(() => upload) });
  await act(async () => {
    dropHandlers.onDrop?.([new File(["x"], "old.png")]);
  });
  setCurrentWorkspace("another", "ws-2");
  await act(async () => {
    finish(
      makeUpload({
        id: "old-file",
        filename: "old.png",
        link: "https://cdn.example/old.png",
      }),
    );
  });
  expect(useChatStore.getState().inputDraftAttachments).toEqual({});
});

it("does not clear a new workspace draft when an earlier send completes", async () => {
  let finish!: () => void;
  const sent = new Promise<void>((resolve) => {
    finish = resolve;
  });
  renderInput({ onSend: vi.fn(() => sent) });
  fireEvent.change(screen.getByTestId("editor"), {
    target: { value: "Old workspace message" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  setCurrentWorkspace("another", "ws-2");
  const state = useChatStore.getState();
  state.inputDrafts = { "__draft_new__:agent-1": "New workspace draft" };
  await act(async () => {
    finish();
  });
  expect(state.inputDrafts["__draft_new__:agent-1"]).toBe(
    "New workspace draft",
  );
});

describe("ChatInput follow-up modes", () => {
  const type = (value: string) =>
    fireEvent.change(screen.getByTestId("editor"), { target: { value } });
  /** Lets the previous send settle so the next one is not skipped as in flight. */
  const settle = () => act(async () => {});

  it("sends normally while idle, from the button and from either shortcut", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderInput({ onSend });
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
    type("Idle message");
    pressSubmitShortcut(true);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Idle message", undefined, [], "send"));
    await settle();
    type("Second");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Second", undefined, [], "send"));
  });

  it("steers by default while running; Mod-Shift-Enter queues this one message", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn();
    renderInput({ onSend, onStop, isRunning: true });
    const button = screen.getByRole("button", { name: "Steer" });
    expect(button).toHaveAttribute("title", "Steer · Ctrl+Enter\nQueue · Ctrl+Shift+Enter");
    expect(button).toHaveAttribute("data-follow-up-mode", "steer");
    type("Use the staging database");
    pressSubmitShortcut(false);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Use the staging database", undefined, [], "steer"));
    await settle();
    type("Then write the summary");
    pressSubmitShortcut(true);
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Then write the summary", undefined, [], "queue"));
    await settle();
    type("Click");
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Click", undefined, [], "steer"));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("queues by default when the preference says so; Mod-Shift-Enter steers", async () => {
    useChatStore.getState().followUpMode = "queue";
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderInput({ onSend, isRunning: true });
    const button = screen.getByRole("button", { name: "Queue" });
    expect(button).toHaveAttribute("title", "Queue · Ctrl+Enter\nSteer · Ctrl+Shift+Enter");
    type("After this run");
    fireEvent.click(button);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("After this run", undefined, [], "queue"));
    await settle();
    type("Right now");
    pressSubmitShortcut(true);
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Right now", undefined, [], "steer"));
  });

  it("never sends from bare Enter, so a composing IME candidate cannot submit", () => {
    renderInput({ isRunning: true });
    // Only the Mod shortcuts submit; the extension also ignores them while composing.
    expect(editorProps.last?.submitOnEnter).toBeUndefined();
    expect(typeof editorProps.last?.onSubmit).toBe("function");
  });
});

describe("ChatInput queued-message edit", () => {
  const edit = { itemId: "qmsg_1", revision: 2, stash: { draft: "my own draft", attachments: {} } };
  function editing(onSaveQueueEdit = vi.fn().mockResolvedValue(undefined)) {
    const state = useChatStore.getState();
    state.activeSessionId = "session-1";
    state.inputDrafts["session-1"] = "Queued text";
    state.queueEdit["session-1"] = edit;
    const onSend = vi.fn();
    const view = renderInput({ onSend, onSaveQueueEdit, isRunning: true });
    return { ...view, onSend, onSaveQueueEdit };
  }

  it("shows the edit strip and saves through the queue instead of sending", async () => {
    const { onSend, onSaveQueueEdit } = editing();
    expect(screen.getByText("Editing queued message")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "Queued text, edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaveQueueEdit).toHaveBeenCalledWith("session-1", edit, "Queued text, edited", []));
    expect(onSend).not.toHaveBeenCalled();
    // The store settles the draft; the composer clears nothing itself.
    expect(useChatStore.getState().clearInputDraft).not.toHaveBeenCalled();
  });

  it("saves from Mod-Enter and Mod-Shift-Enter alike", async () => {
    const { onSaveQueueEdit } = editing();
    pressSubmitShortcut(true);
    await waitFor(() => expect(onSaveQueueEdit).toHaveBeenCalledWith("session-1", edit, "Queued text", []));
  });

  it("cancels from the strip and from Esc, restoring the stashed draft into the editor", async () => {
    editing();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useChatStore.getState().finishQueueEdit).toHaveBeenCalledWith("session-1", "restore");
    useChatStore.getState().queueEdit["session-1"] = edit;
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape" });
    expect(useChatStore.getState().finishQueueEdit).toHaveBeenCalledTimes(2);
  });

  it("keeps Esc for an IME composition or an open suggestion", () => {
    const { container } = editing();
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape", isComposing: true });
    const suggestion = document.createElement("span");
    suggestion.className = "suggestion";
    container.querySelector("[aria-disabled], [data-testid='drop-zone']")?.appendChild(suggestion);
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape" });
    expect(useChatStore.getState().finishQueueEdit).not.toHaveBeenCalled();
  });

  it("writes a draft changed outside the editor into it", async () => {
    const state = useChatStore.getState();
    state.activeSessionId = "session-1";
    state.inputDrafts["session-1"] = "Before";
    const view = renderInput({});
    state.inputDrafts["session-1"] = "Loaded queued message";
    view.rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatInput onSend={vi.fn()} agentName="Multiremi" />
      </I18nProvider>,
    );
    await waitFor(() => expect(editorProps.setContent).toHaveBeenCalledWith("Loaded queued message"));
  });

  it("does not treat the lazily created session of a first send as an outside edit", async () => {
    let finish!: () => void;
    const onSend = vi.fn(() => {
      useChatStore.getState().activeSessionId = "session-new";
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const view = renderInput({ onSend });
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "First message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    view.rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatInput onSend={onSend} agentName="Multiremi" />
      </I18nProvider>,
    );
    await act(async () => { finish(); });
    expect(editorProps.setContent).not.toHaveBeenCalled();
  });

  it("enables the primary button when an outside change fills an empty draft", async () => {
    editorProps.syncDefault = true;
    const state = useChatStore.getState();
    state.activeSessionId = "session-1";
    const view = renderInput({});
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    state.inputDrafts["session-1"] = "Loaded queued message";
    view.rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatInput onSend={vi.fn()} agentName="Multiremi" />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
  });

  it("explains a failed save and stays in edit mode", async () => {
    editing(vi.fn().mockRejectedValue(new Error("offline")));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the queue");
    expect(screen.getByText("Editing queued message")).toBeInTheDocument();
  });
});

