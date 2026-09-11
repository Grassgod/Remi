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
}));

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
    const uploadingRef = useRef(0);
    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      clearContent: () => {
        valueRef.current = "";
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
import { useChatStore } from "@multiremi/core/chat";
import { setCurrentWorkspace } from "@multiremi/core/platform";
beforeEach(() => {
  setCurrentWorkspace("demo", "ws-1");
  const state = useChatStore.getState();
  state.inputDrafts = {};
  state.inputDraftAttachments = {};
  state.activeSessionId = null;
  state.selectedAgentId = "agent-1";
});

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
    const [, ids] = onSend.mock.calls[0]!;
    expect(ids).toEqual(["att-42"]);
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
    expect(onSend).toHaveBeenLastCalledWith("Please keep this", undefined);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("allows queueing without removing the current stop control", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn();
    renderInput({ onSend, onStop, isRunning: true, supportsQueue: true });
    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "Next instruction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("Next instruction", undefined),
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
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
    ]),
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
