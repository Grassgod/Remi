// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enSkills from "../../locales/en/skills.json";
import { FileViewer } from "./file-viewer";

vi.mock("../../common/markdown", () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));

function show(path: string, content: string, encoding?: "utf8" | "base64") {
  const onChange = vi.fn();
  render(<I18nProvider locale="en" resources={{ en: { skills: enSkills } }}>
    <FileViewer path={path} content={content} encoding={encoding} onChange={onChange} />
  </I18nProvider>);
  return onChange;
}

describe("Skill file viewer", () => {
  it.each(["assets/pixel.png", "binary.md"])("offers the original binary file for download without a text editor: %s", path => {
    const content = "iVBORw0KGgoA/w==";
    const onChange = show(path, content, "base64");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(content)).not.toBeInTheDocument();
    expect(screen.getByText(/binary attachment is read-only/)).toBeInTheDocument();
    const download = screen.getByRole("link", { name: "Download file" });
    expect(download).toHaveAttribute("download", path.split("/").pop());
    expect(download).toHaveAttribute("href", `data:application/octet-stream;base64,${content}`);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([undefined, "utf8"] as const)("keeps UTF8 text editable with encoding %s", encoding => {
    const onChange = show("notes.txt", "Original text", encoding);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited text" } });
    expect(onChange).toHaveBeenCalledWith("Edited text");
    expect(screen.queryByRole("link", { name: "Download file" })).not.toBeInTheDocument();
  });
});
