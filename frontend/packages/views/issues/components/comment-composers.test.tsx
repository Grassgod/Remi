import { forwardRef, useImperativeHandle, useRef, type Ref } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { UploadResult } from "@multiremi/core/hooks/use-file-upload";
import { renderWithI18n } from "../../test/i18n";
import { CommentInput, type ReplyTarget } from "./comment-input";

const uploadWithToast = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/api", () => ({
  api: {},
}));

vi.mock("@multiremi/core/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ uploadWithToast }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">
      {actorType}:{actorId}
    </span>
  ),
}));

vi.mock("../../editor", () => ({
  useFileDropZone: () => ({
    isDragOver: false,
    dropZoneProps: { "data-testid": "drop-zone" },
  }),
  FileDropOverlay: () => null,
  ContentEditor: forwardRef(function MockContentEditor(
    {
      defaultValue,
      onUpdate,
      placeholder,
      onUploadFile,
    }: {
      defaultValue?: string;
      onUpdate?: (markdown: string) => void;
      placeholder?: string;
      onUploadFile?: (file: File) => Promise<UploadResult | null>;
    },
    ref: Ref<unknown>,
  ) {
    const valueRef = useRef(defaultValue ?? "");

    useImperativeHandle(ref, () => ({
      getMarkdown: () => valueRef.current,
      clearContent: () => {
        valueRef.current = "";
      },
      focus: () => {},
      blur: () => {},
      uploadFile: async (file: File) => {
        const result = await onUploadFile?.(file);
        if (!result) return;
        valueRef.current = `${valueRef.current}\n${result.url}`.trim();
        onUpdate?.(valueRef.current);
      },
      hasActiveUploads: () => false,
    }));

    return (
      <textarea
        data-testid="editor"
        defaultValue={defaultValue}
        placeholder={placeholder}
        onChange={(event) => {
          valueRef.current = event.target.value;
          onUpdate?.(event.target.value);
        }}
      />
    );
  }),
}));

function renderCommentInput({
  onSubmit = vi.fn().mockResolvedValue(undefined),
  replyTo,
  onCancelReply = vi.fn(),
}: {
  onSubmit?: (content: string, attachmentIds?: string[]) => Promise<void>;
  replyTo?: ReplyTarget | null;
  onCancelReply?: () => void;
} = {}) {
  const view = renderWithI18n(
    <CommentInput
      issueId="issue-1"
      onSubmit={onSubmit}
      replyTo={replyTo}
      onCancelReply={onCancelReply}
    />,
  );
  return { ...view, onSubmit, onCancelReply };
}

function getSubmitButton(container: HTMLElement): HTMLButtonElement {
  const buttons = container.querySelectorAll("button");
  const button = buttons[buttons.length - 1];
  if (!button) throw new Error("Expected submit button to render");
  return button;
}

beforeEach(() => {
  uploadWithToast.mockReset();
  localStorage.clear();
});

const replyTarget: ReplyTarget = {
  commentId: "comment-1",
  authorLabel: "带头大哥",
  strippedPreview: "收到，以后我就叫周周",
};

describe("comment composers", () => {
  it("renders the single composer without a manual expand control", () => {
    const { container } = renderCommentInput();

    expect(screen.getByPlaceholderText("Leave a comment...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    expect(container.querySelectorAll("button")).toHaveLength(2);

    const shell = screen.getByTestId("drop-zone");
    expect(shell.className).not.toMatch(/max-h-/);
    expect(shell.className).not.toContain("h-[70vh]");
  });

  it("keeps main comment submission wired after removing expand", async () => {
    const { container, onSubmit } = renderCommentInput();

    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: "hello from composer" },
    });
    fireEvent.click(getSubmitButton(container));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("hello from composer", undefined);
    });
  });

  describe("reply context", () => {
    it("shows no chip when the composer is writing a new message", () => {
      renderCommentInput();

      expect(screen.queryByText(/^Replying to/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Cancel reply" }),
      ).not.toBeInTheDocument();
    });

    it("names the message being answered, quoting its stripped preview", () => {
      renderCommentInput({ replyTo: replyTarget });

      expect(
        screen.getByText("Replying to 带头大哥: 收到，以后我就叫周周"),
      ).toBeInTheDocument();
    });

    it("clears the context from the chip's × control", () => {
      const { onCancelReply } = renderCommentInput({ replyTo: replyTarget });

      fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
      expect(onCancelReply).toHaveBeenCalledTimes(1);
    });

    it("still submits through the same handler while a reply is pending", async () => {
      const { container, onSubmit } = renderCommentInput({ replyTo: replyTarget });

      fireEvent.change(screen.getByTestId("editor"), {
        target: { value: "On it" },
      });
      fireEvent.click(getSubmitButton(container));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith("On it", undefined);
      });
    });
  });
});
