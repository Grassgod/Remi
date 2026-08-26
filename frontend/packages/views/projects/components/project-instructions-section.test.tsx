// @vitest-environment jsdom

import { forwardRef, useImperativeHandle, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@multiremi/core/api";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enCommon from "../../locales/en/common.json";
import enProjects from "../../locales/en/projects.json";

const TEST_RESOURCES = {
  en: { common: enCommon, projects: enProjects },
};

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

vi.mock("../../editor", () => ({
  ContentEditor: forwardRef(function MockContentEditor(
    {
      defaultValue,
      onUpdate,
    }: {
      defaultValue: string;
      onUpdate: (value: string) => void;
    },
    ref,
  ) {
    const currentValueRef = useRef(defaultValue);
    currentValueRef.current = defaultValue;
    useImperativeHandle(ref, () => ({
      getMarkdown: () => currentValueRef.current,
    }));
    return (
      <textarea
        aria-label="Project instructions editor"
        value={defaultValue}
        onChange={(event) => onUpdate(event.target.value)}
      />
    );
  }),
  ReadonlyContent: ({ content, density }: { content: string; density?: string }) => (
    <div data-testid="instructions-preview" data-density={density}>
      {content}
    </div>
  ),
}));

// jsdom has no layout, so scrollHeight is always 0 and the preview would never
// consider itself overflowing. Drive it from the fixture instead.
function stubMeasuredHeight(height: number) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return this.querySelector("[data-testid='instructions-preview']") ? height : 0;
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  };
}

import { ProjectInstructionsSection } from "./project-instructions-section";

function renderSection(
  overrides: Partial<Parameters<typeof ProjectInstructionsSection>[0]> = {},
) {
  const props = {
    instructions: "**Test first.**",
    revision: 3,
    updatedAt: new Date().toISOString(),
    updatedByName: "Ada",
    editable: true,
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <ProjectInstructionsSection {...props} />
    </I18nProvider>,
  );
  return props;
}

describe("ProjectInstructionsSection", () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  it("shows a compact Markdown preview, explicit edit action, and update metadata", () => {
    renderSection();

    expect(screen.getByText("Project instructions")).toBeInTheDocument();
    expect(screen.getByTestId("instructions-preview")).toHaveTextContent(
      "**Test first.**",
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByText(/Updated today by Ada/i)).toBeInTheDocument();
  });

  it("renders the sidebar preview at compact density", () => {
    renderSection();

    expect(screen.getByTestId("instructions-preview")).toHaveAttribute(
      "data-density",
      "compact",
    );
  });

  it("offers no expand affordance when the preview fits", () => {
    const restore = stubMeasuredHeight(60);
    try {
      renderSection();
      expect(screen.queryByRole("button", { name: /Show all/i })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("fades and expands instructions that overflow the collapsed preview", () => {
    const restore = stubMeasuredHeight(400);
    try {
      renderSection({ instructions: "# Heading\n\n" + "- item\n".repeat(40) });

      const toggle = screen.getByRole("button", { name: /Show all/i });
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      // Clamp + fade while collapsed, so nothing is cut mid-element.
      const clamp = screen.getByTestId("instructions-preview").parentElement?.parentElement;
      expect(clamp).toHaveStyle({ maxHeight: "112px" });
      expect(clamp?.querySelector("[aria-hidden]")).toBeInTheDocument();

      fireEvent.click(toggle);

      const expanded = screen.getByRole("button", { name: /Show less/i });
      expect(expanded).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByTestId("instructions-preview").parentElement?.parentElement,
      ).not.toHaveStyle({ maxHeight: "112px" });
    } finally {
      restore();
    }
  });

  it("saves only on the explicit action and explains session effect and secret handling", async () => {
    const { onSave } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      screen.getByText(
        "Workspace instructions remain active. These project instructions are appended and do not replace them.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Do not include tokens, passwords, or other secrets."),
    ).toBeInTheDocument();

    fireEvent.change(
      screen.getByRole("textbox", { name: "Project Bootstrap Prompt" }),
      { target: { value: "Use **small** commits." } },
    );
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("Use **small** commits.", "", 3);
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Project prompts saved.",
    );
  });

  it("cancels edits and enforces the 4,000 character limit", () => {
    const { onSave } = renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", {
      name: "Project Bootstrap Prompt",
    });
    fireEvent.change(editor, { target: { value: "x".repeat(4001) } });

    expect(screen.getByText("4001 / 4000")).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("textbox", { name: "Project Bootstrap Prompt" }),
    ).toHaveValue("**Test first.**");
  });

  it("keeps the draft open and explains revision conflicts", async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiError(
        "project instructions revision conflict",
        409,
        "Conflict",
      ),
    );
    renderSection({ onSave });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project Bootstrap Prompt" }),
      { target: { value: "Keep this local draft." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Project instructions changed elsewhere. Your draft is still open; cancel and reopen the editor to review the latest version.",
      );
    });
    expect(
      screen.getByRole("textbox", { name: "Project Bootstrap Prompt" }),
    ).toHaveValue("Keep this local draft.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps using the revision captured when the editor opened", async () => {
    const onSave = vi.fn().mockRejectedValue(
      new ApiError("project instructions revision conflict", 409, "Conflict"),
    );
    const { rerender } = render(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ProjectInstructionsSection
          instructions="Initial"
          revision={4}
          updatedAt={null}
          editable
          onSave={onSave}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project Bootstrap Prompt" }),
      { target: { value: "Local draft" } },
    );

    rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <ProjectInstructionsSection
          instructions="Remote edit"
          revision={5}
          updatedAt={null}
          editable
          onSave={onSave}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith("Local draft", "", 4);
    });
  });

  it("keeps archived project instructions read-only", () => {
    renderSection({ editable: false });

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByTestId("instructions-preview")).toBeInTheDocument();
  });
});
