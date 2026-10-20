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
    followUpMode: "queue" as "steer" | "queue",
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
    restoreToDraft: vi.fn((key: string, body: string, attachments: Record<string, string>) => {
      state.inputDrafts[key] = [state.inputDrafts[key]?.trim(), body].filter(Boolean).join("\n\n");
      state.inputDraftAttachments[key] = { ...state.inputDraftAttachments[key], ...attachments };
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

import { ChatInput, chatComposerAction, STOP_CONFIRM_MS } from "./chat-input";
import { ApiError } from "@multiremi/core/api";
import { useChatStore } from "@multiremi/core/chat";
import { setCurrentWorkspace } from "@multiremi/core/platform";
import { CHAT_COLUMN_CLASS } from "../lib/chat-column";
beforeEach(() => {
  vi.clearAllMocks();
  setCurrentWorkspace("demo", "ws-1");
  const state = useChatStore.getState();
  state.inputDrafts = {};
  state.inputDraftAttachments = {};
  state.localAttachmentDetails = {};
  state.activeSessionId = null;
  state.selectedAgentId = "agent-1";
  // The store's default when nothing is stored.
  state.followUpMode = "queue";
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
        // The chat on screen; tests name it through the mocked store.
        sessionId={props.sessionId !== undefined ? props.sessionId : useChatStore.getState().activeSessionId}
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

  it("lays the pickers and the actions out in one footer row", () => {
    renderInput({ leftAdornment: <button type="button">Agent</button>, rightAdornment: <span>Ring</span> });
    const footer = document.querySelector<HTMLElement>("[data-chat-composer-footer]")!;
    const start = footer.querySelector<HTMLElement>("[data-chat-composer-footer-start]")!;
    // The pickers shrink into what the actions leave instead of sliding under
    // them, and their box is the container the location label collapses in.
    expect(start).toContainElement(screen.getByRole("button", { name: "Agent" }));
    expect(start.className).toMatch(/(^|\s)@container(\s|$)/);
    expect(start.className).toContain("min-w-0");
    expect(start.className).toContain("flex-1");
    const actions = start.nextElementSibling as HTMLElement;
    expect(actions.className).toContain("shrink-0");
    expect(actions).toContainElement(screen.getByRole("button", { name: "Send" }));
    expect(actions).toHaveTextContent("Ring");
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

  it("keeps the draft of the chat on screen, not of the stored selection", () => {
    // The page shows session-1 while the stored selection names a new chat.
    useChatStore.getState().activeSessionId = null;
    renderInput({ sessionId: "session-1" });
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "For the chat on screen" } });
    expect(useChatStore.getState().inputDrafts).toEqual({ "session-1": "For the chat on screen" });
  });

  it("clears the composer on submit and keeps what is typed while the send is in flight", async () => {
    useChatStore.getState().activeSessionId = "session-1";
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderInput({ onSend });
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "Sent text" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(useChatStore.getState().inputDrafts["session-1"]).toBeUndefined();
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "Typed meanwhile" } });
    await act(async () => { finish(); });
    expect(useChatStore.getState().inputDrafts["session-1"]).toBe("Typed meanwhile");
    // Only the submit emptied the editor (without an update); nothing wrote into it after.
    expect(editorProps.setContent.mock.calls).toEqual([[""]]);
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

  it("queues by default while running; Mod-Shift-Enter steers this one message", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn();
    renderInput({ onSend, onStop, isRunning: true });
    type("After this run");
    const button = screen.getByRole("button", { name: "Queue" });
    expect(button).toHaveAttribute("title", "Queue · Ctrl+Enter\nSteer · Ctrl+Shift+Enter");
    expect(button).toHaveAttribute("data-composer-action", "queue");
    pressSubmitShortcut(false);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("After this run", undefined, [], "queue"));
    await settle();
    type("Right now");
    pressSubmitShortcut(true);
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Right now", undefined, [], "steer"));
    await settle();
    type("Click");
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Click", undefined, [], "queue"));
    await settle();
    // The composer emptied: the same button now stops the run.
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("steers when the preference says so; Mod-Shift-Enter queues", async () => {
    useChatStore.getState().followUpMode = "steer";
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderInput({ onSend, isRunning: true });
    type("Use the staging database");
    const button = screen.getByRole("button", { name: "Steer" });
    expect(button).toHaveAttribute("title", "Steer · Ctrl+Enter\nQueue · Ctrl+Shift+Enter");
    expect(button).toHaveAttribute("data-composer-action", "steer");
    fireEvent.click(button);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Use the staging database", undefined, [], "steer"));
    await settle();
    type("Then write the summary");
    pressSubmitShortcut(true);
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("Then write the summary", undefined, [], "queue"));
  });

  it.each([
    ["idle, empty", { editing: false, isRunning: false, isEmpty: true, isSending: false }, "queue", "send"],
    ["idle, typed", { editing: false, isRunning: false, isEmpty: false, isSending: false }, "steer", "send"],
    ["running, empty", { editing: false, isRunning: true, isEmpty: true, isSending: false }, "queue", "stop"],
    ["running, empty, steer preference", { editing: false, isRunning: true, isEmpty: true, isSending: false }, "steer", "stop"],
    ["running, typed", { editing: false, isRunning: true, isEmpty: false, isSending: false }, "queue", "queue"],
    ["running, typed, steer preference", { editing: false, isRunning: true, isEmpty: false, isSending: false }, "steer", "steer"],
    ["running, a send in flight", { editing: false, isRunning: true, isEmpty: true, isSending: true }, "queue", "queue"],
    ["editing a queued message", { editing: true, isRunning: true, isEmpty: false, isSending: false }, "queue", "save"],
    ["editing, emptied", { editing: true, isRunning: true, isEmpty: true, isSending: false }, "queue", "save"],
  ] as const)("one primary button: %s", (_name, state, preference, action) => {
    expect(chatComposerAction({ ...state, preference })).toBe(action);
  });

  it("shows one button per state: Send, Stop, the follow-up mode", async () => {
    const onStop = vi.fn();
    const view = renderInput({ onStop });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    const rerender = (props: Partial<React.ComponentProps<typeof ChatInput>>) => view.rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatInput sessionId={null} onSend={vi.fn()} onStop={onStop} agentName="Multiremi" {...props} />
      </I18nProvider>,
    );
    rerender({ isRunning: true, stopLabel: "Stop the reply (background tasks keep running)" });
    const stop = screen.getByRole("button", { name: "Stop the reply (background tasks keep running)" });
    expect(stop).toHaveAttribute("data-composer-action", "stop");
    expect(stop).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    type("Typed");
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Queue" })).toBeEnabled();
    // The same element changes, so focus stays on it.
    expect(screen.getByRole("button", { name: "Queue" })).toBe(stop);
    type("");
    expect(screen.getByRole("button", { name: /^Stop/ })).toBe(stop);
    rerender({ isRunning: false });
    expect(screen.getByRole("button", { name: "Send" })).toBe(stop);
  });

  it("replaces Stop with the submit as soon as text is typed, before the editor's debounced update", () => {
    renderInput({ onStop: vi.fn(), isRunning: true });
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    // An editing host the mock does not report through onUpdate.
    const host = document.createElement("div");
    host.textContent = "t";
    document.querySelector("[data-chat-composer]")!.appendChild(host);
    fireEvent.input(host);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
    expect(useChatStore.getState().setInputDraft).not.toHaveBeenCalled();
  });

  it("does not stop the run from the second click of a double click on submit", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn();
    renderInput({ onSend, onStop, isRunning: true });
    type("Queued once");
    fireEvent.click(screen.getByRole("button", { name: "Queue" }), { detail: 1 });
    await settle();
    const stop = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stop, { detail: 2 });
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.click(stop, { detail: 1 });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("keeps the spinning submit, not Stop, while a send is in flight", async () => {
    let finish!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderInput({ onSend, onStop: vi.fn(), isRunning: true });
    type("In flight");
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(screen.getByRole("button", { name: "Queue" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await act(async () => { finish(); });
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("stops from Esc twice without clearing the typed draft", () => {
    useChatStore.getState().activeSessionId = "session-1";
    const onStop = vi.fn();
    renderInput({ onStop, isRunning: true, stopLabel: "Stop the reply (background tasks keep running)" });
    type("Half-written follow-up");
    const editorKeydown = vi.fn();
    screen.getByTestId("editor").addEventListener("keydown", editorKeydown);
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Press Esc again to confirm: Stop the reply (background tasks keep running)",
    );
    expect(onStop).not.toHaveBeenCalled();
    // The editor's Escape-to-blur does not run, so the second Esc lands here.
    expect(editorKeydown).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
    expect(useChatStore.getState().inputDrafts["session-1"]).toBe("Half-written follow-up");
  });

  it("disarms the Esc stop on another key or after the confirm window", () => {
    vi.useFakeTimers();
    try {
      const onStop = vi.fn();
      renderInput({ onStop, isRunning: true });
      const editor = screen.getByTestId("editor");
      fireEvent.keyDown(editor, { key: "Escape" });
      fireEvent.keyDown(editor, { key: "a" });
      expect(screen.queryByRole("status")).toBeNull();
      fireEvent.keyDown(editor, { key: "Escape" });
      act(() => { vi.advanceTimersByTime(STOP_CONFIRM_MS); });
      expect(screen.queryByRole("status")).toBeNull();
      fireEvent.keyDown(editor, { key: "Escape" });
      expect(onStop).not.toHaveBeenCalled();
      // An IME composition keeps its Esc.
      fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
      expect(onStop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves Esc to the editor while idle", () => {
    renderInput({ onStop: vi.fn() });
    const editorKeydown = vi.fn();
    screen.getByTestId("editor").addEventListener("keydown", editorKeydown);
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape" });
    expect(editorKeydown).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("steers the first queued message from Mod-Shift-Enter on an empty composer while queueing", () => {
    const onSend = vi.fn();
    const onSteerFirstQueued = vi.fn();
    renderInput({ onSend, onSteerFirstQueued, isRunning: true });
    // Mod-Enter would queue, and there is nothing to queue.
    pressSubmitShortcut(false);
    expect(onSteerFirstQueued).not.toHaveBeenCalled();
    pressSubmitShortcut(true);
    expect(onSteerFirstQueued).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([
    ["the steer preference", { followUpMode: "steer" as const, isRunning: true }],
    ["an idle chat", { followUpMode: "queue" as const, isRunning: false }],
  ])("does not steer a queued message from an empty composer with %s", (_name, { followUpMode, isRunning }) => {
    useChatStore.getState().followUpMode = followUpMode;
    const onSteerFirstQueued = vi.fn();
    renderInput({ onSteerFirstQueued, isRunning });
    pressSubmitShortcut(false);
    pressSubmitShortcut(true);
    expect(onSteerFirstQueued).not.toHaveBeenCalled();
  });

  it("never sends from bare Enter, so a composing IME candidate cannot submit", () => {
    renderInput({ isRunning: true });
    // Only the Mod shortcuts submit; the extension also ignores them while composing.
    expect(editorProps.last?.submitOnEnter).toBeUndefined();
    expect(typeof editorProps.last?.onSubmit).toBe("function");
    // Chat opts in to Mod-Shift-Enter; other editors leave it unbound.
    expect(editorProps.last?.invertibleSubmit).toBe(true);
  });

  it.each([
    ["queue_full", "The queue is full (50 messages). Steer or delete queued messages first."],
    ["chat_archived", "This chat is archived. Restore it to send queued messages."],
  ])("explains a %s refusal and keeps the draft", async (code, copy) => {
    const onSend = vi.fn().mockRejectedValue(new ApiError(code, code === "queue_full" ? 400 : 409, "x", { error: code, code }));
    renderInput({ onSend, isRunning: true });
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "One more" } });
    pressSubmitShortcut(false);
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(onSend).toHaveBeenCalledWith("One more", undefined, [], "queue");
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
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
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

  it("keeps Save, and steers nothing, when the edited text is emptied", () => {
    const state = useChatStore.getState();
    state.activeSessionId = "session-1";
    state.inputDrafts["session-1"] = "Queued text";
    state.queueEdit["session-1"] = edit;
    const onSteerFirstQueued = vi.fn();
    renderInput({ onSteerFirstQueued, onStop: vi.fn(), isRunning: true });
    // The mock textarea starts blank, so change it before emptying it.
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("editor"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    pressSubmitShortcut(true);
    expect(onSteerFirstQueued).not.toHaveBeenCalled();
  });

  it("cancels from the strip and from Esc, restoring the stashed draft into the editor", async () => {
    editing();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useChatStore.getState().finishQueueEdit).toHaveBeenCalledWith("session-1", "restore");
    useChatStore.getState().queueEdit["session-1"] = edit;
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape" });
    expect(useChatStore.getState().finishQueueEdit).toHaveBeenCalledTimes(2);
  });

  it("stops Esc at the composer so the editor's blur shortcut does not run", () => {
    editing();
    const editorKeydown = vi.fn();
    screen.getByTestId("editor").addEventListener("keydown", editorKeydown);
    fireEvent.keyDown(screen.getByTestId("editor"), { key: "Escape" });
    expect(useChatStore.getState().finishQueueEdit).toHaveBeenCalledWith("session-1", "restore");
    expect(editorKeydown).not.toHaveBeenCalled();
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
        <ChatInput sessionId="session-1" onSend={vi.fn()} agentName="Multiremi" />
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
        <ChatInput sessionId="session-new" onSend={onSend} agentName="Multiremi" />
      </I18nProvider>,
    );
    await act(async () => { finish(); });
    // The submit's own emptying, not an outside draft written into the editor.
    expect(editorProps.setContent.mock.calls).toEqual([[""]]);
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
        <ChatInput sessionId="session-1" onSend={vi.fn()} agentName="Multiremi" />
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

describe("ChatInput model chip", () => {
  const opus = { modelId: "claude-opus-4-1-20250805", label: "Opus 4.1", effort: null, fallback: false };
  const chip = () => document.querySelector<HTMLElement>("[data-chat-model]");

  it("names the model read-only after the pickers in the footer's start slot", () => {
    renderInput({ leftAdornment: <button type="button">Agent</button>, model: opus });
    const start = document.querySelector<HTMLElement>("[data-chat-composer-footer-start]")!;
    const shown = screen.getByRole("group", { name: "Model: Opus 4.1" });
    expect(shown).toBe(chip());
    expect(start).toContainElement(shown);
    expect(screen.getByRole("button", { name: "Agent" }).compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shown).toHaveTextContent(/^Opus 4\.1$/);
    // Not a control: no button inside, no menu chevron, no hover background.
    expect(shown.querySelector("button")).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).not.toContain("Opus 4.1");
    expect(shown.className).not.toMatch(/hover:/);
    expect(shown).toHaveClass("cursor-default");
    // The full id and where it is changed.
    expect(shown.title).toBe("claude-opus-4-1-20250805\nSet in the agent's settings");
  });

  it("adds the effort level after the name", () => {
    renderInput({ model: { ...opus, effort: "High" } });
    expect(screen.getByRole("group", { name: "Model: Opus 4.1 · High" })).toHaveTextContent("Opus 4.1· High");
    expect(chip()!.title).toBe("claude-opus-4-1-20250805\nReasoning effort: High\nSet in the agent's settings");
  });

  it("shows the raw id when the catalog has no name for it", () => {
    renderInput({ model: { ...opus, label: null } });
    expect(screen.getByRole("group", { name: "Model: claude-opus-4-1-20250805" })).toBeInTheDocument();
  });

  it("calls an unset model the default model", () => {
    renderInput({ model: { modelId: null, label: null, effort: null, fallback: false } });
    expect(screen.getByRole("group", { name: "Model: Default model" })).toHaveTextContent("Default model");
    expect(chip()!.title).toBe("No model set: the runtime's default model runs\nSet in the agent's settings");
  });

  it("explains a running turn that switched to the fallback model", () => {
    renderInput({ model: { modelId: "claude-sonnet-4-5", label: "Sonnet 4.5", effort: null, fallback: true } });
    expect(screen.getByRole("group", { name: "Model: Sonnet 4.5" })).toBeInTheDocument();
    expect(chip()!.title).toBe("claude-sonnet-4-5\nThis turn switched to the fallback model\nSet in the agent's settings");
    expect(chip()!.querySelector("svg")).toHaveClass("text-warning");
  });

  it("takes only the room the pickers leave: the name truncates, then the effort and the chip hide", () => {
    renderInput({ leftAdornment: <button type="button">Agent</button>, model: { ...opus, effort: "High" } });
    const shown = chip()!;
    // Its slot grows from zero into the free space (never squeezing a picker)
    // and is the container its own narrow-width rules read.
    const slot = shown.parentElement!;
    expect(slot).toHaveAttribute("data-chat-model-slot");
    expect(slot.className).toMatch(/(^|\s)@container\/model(\s|$)/);
    expect(slot).toHaveClass("flex-1", "min-w-0", "max-w-64");
    expect(slot.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
    expect(shown).toHaveClass("min-w-0", "max-w-full", "@max-[4.5rem]/model:hidden");
    expect(shown.querySelector("[data-chat-model-name]")).toHaveClass("min-w-0", "truncate");
    expect(shown.lastElementChild).toHaveClass("shrink-0", "whitespace-nowrap", "@max-[8rem]/model:hidden");
    // It sits in the start slot, which yields to the actions; the send button keeps its own box.
    const start = document.querySelector<HTMLElement>("[data-chat-composer-footer-start]")!;
    expect(start.lastElementChild).toBe(slot);
    const actions = start.nextElementSibling as HTMLElement;
    expect(actions).not.toContainElement(shown);
    expect(actions).toContainElement(screen.getByRole("button", { name: "Send" }));
  });

  it("renders nothing while there is no agent or it is still loading", () => {
    const { rerender } = renderInput({ leftAdornment: <button type="button">Agent</button> });
    expect(chip()).toBeNull();
    rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatInput sessionId={null} onSend={vi.fn()} model={null} />
      </I18nProvider>,
    );
    expect(chip()).toBeNull();
    // Arriving later adds only the chip: no placeholder was reserved for it.
    const start = document.querySelector<HTMLElement>("[data-chat-composer-footer-start]")!;
    expect(start.children).toHaveLength(0);
    rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ChatInput sessionId={null} onSend={vi.fn()} model={opus} />
      </I18nProvider>,
    );
    expect(start.children).toHaveLength(1);
    expect(start.firstElementChild).toContainElement(chip());
  });
});

describe("ChatInput Chat column", () => {
  it("puts the composer's border on the shared Chat column's edges, like the message text", () => {
    renderInput({});
    const composer = document.querySelector<HTMLElement>("[data-chat-composer]")!;
    expect(composer.parentElement).toHaveClass(...CHAT_COLUMN_CLASS.split(" "));
    // The card fills the column: no width or inset of its own to drift from the list's.
    expect(composer).toHaveClass("w-full");
    expect(composer.className).not.toMatch(/(^|\s)(max-w-|mx-|px-)/);
  });
});
