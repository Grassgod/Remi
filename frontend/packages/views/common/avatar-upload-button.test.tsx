// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockUploadFile = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/core/api", () => ({
  api: { uploadFile: mockUploadFile },
}));

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mockToast }));

import { AvatarUploadButton } from "./avatar-upload-button";

function pngFile(name = "a.png") {
  return new File(["x"], name, { type: "image/png" });
}

beforeEach(() => {
  mockUploadFile.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
});
afterEach(() => cleanup());

describe("AvatarUploadButton", () => {
  it("uploads the picked file and hands the URL to the caller", async () => {
    mockUploadFile.mockResolvedValue({ url: "https://cdn/x.png" });
    const onUploaded = vi.fn();
    const { container } = render(
      <AvatarUploadButton
        ariaLabel="Change avatar"
        errorMessage="Failed"
        successMessage="Updated"
        onUploaded={onUploaded}
      >
        <span>AV</span>
      </AvatarUploadButton>
    );

    const input = container.querySelector("input[type=file]");
    expect(input).toBeTruthy();
    await userEvent.upload(input as HTMLInputElement, pngFile());

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("https://cdn/x.png"));
    expect(mockToast.success).toHaveBeenCalledWith("Updated");
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("stays silent on success when the caller gives no success copy", async () => {
    mockUploadFile.mockResolvedValue({ url: "https://cdn/x.png" });
    const { container } = render(
      <AvatarUploadButton errorMessage="Failed" onUploaded={vi.fn()}>
        <span>AV</span>
      </AvatarUploadButton>
    );

    await userEvent.upload(
      container.querySelector("input[type=file]") as HTMLInputElement,
      pngFile()
    );

    await waitFor(() => expect(mockUploadFile).toHaveBeenCalled());
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("surfaces the upload error message, falling back to the caller's copy", async () => {
    mockUploadFile.mockRejectedValue(new Error("boom"));
    const onUploaded = vi.fn();
    const { container } = render(
      <AvatarUploadButton errorMessage="Failed" onUploaded={onUploaded}>
        <span>AV</span>
      </AvatarUploadButton>
    );

    await userEvent.upload(
      container.querySelector("input[type=file]") as HTMLInputElement,
      pngFile()
    );

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("boom"));
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("rejects non-images client-side when the caller opts in", async () => {
    const onUploaded = vi.fn();
    const { container } = render(
      <AvatarUploadButton
        errorMessage="Failed"
        invalidTypeMessage="Pick an image"
        // The OS file dialog's "All files" escape hatch is exactly why the
        // component re-checks the type; widen `accept` so the test can
        // reproduce it (userEvent honours the attribute).
        accept="*/*"
        onUploaded={onUploaded}
      >
        <span>AV</span>
      </AvatarUploadButton>
    );

    // fireEvent rather than userEvent: userEvent enforces the `accept`
    // attribute, and the point of this guard is the OS dialog's "All files"
    // escape hatch that slips past it.
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith("Pick an image")
    );
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("locks the button and drops the overlay for viewers without permission", () => {
    const { container } = render(
      <AvatarUploadButton
        ariaLabel="Change logo"
        errorMessage="Failed"
        disabled
        showOverlay={false}
        onUploaded={vi.fn()}
      >
        <span>AV</span>
      </AvatarUploadButton>
    );

    expect(screen.getByRole("button", { name: "Change logo" })).toBeDisabled();
    expect(container.querySelector(".bg-black\\/40")).toBeNull();
  });

  it("reports the outer busy flag to children and the overlay", () => {
    render(
      <AvatarUploadButton errorMessage="Failed" busy onUploaded={vi.fn()}>
        {(busy) => <span>{busy ? "saving" : "idle"}</span>}
      </AvatarUploadButton>
    );

    expect(screen.getByText("saving")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("renders sibling affordances outside the clipped button", () => {
    const { container } = render(
      <AvatarUploadButton
        errorMessage="Failed"
        onUploaded={vi.fn()}
        renderAfter={() => <button type="button">clear</button>}
      >
        <span>AV</span>
      </AvatarUploadButton>
    );

    const clear = screen.getByRole("button", { name: "clear" });
    expect(clear).toBeInTheDocument();
    // Sibling, not a descendant — nested buttons would be invalid markup and
    // the outer button's overflow-hidden would clip it.
    expect(container.querySelector("button")?.contains(clear)).toBe(false);
  });

  it("passes the caller's accept list to the file input", () => {
    const { container } = render(
      <AvatarUploadButton
        errorMessage="Failed"
        accept="image/png,image/jpeg,image/webp"
        onUploaded={vi.fn()}
      >
        <span>AV</span>
      </AvatarUploadButton>
    );

    expect(
      container.querySelector("input[type=file]")?.getAttribute("accept")
    ).toBe("image/png,image/jpeg,image/webp");
  });
});
