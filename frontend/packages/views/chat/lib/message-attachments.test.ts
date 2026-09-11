import { describe, expect, it } from "vitest";
import type { Attachment } from "@multiremi/core/types";
import { chatMessageMarkdown } from "./message-attachments";
const url = "/api/attachments/att-1/content";
const attachment = { id: "att-1", url } as Attachment;
describe("chat attachment presentation", () => {
  it("moves a linked authenticated file into the existing record attachment card", () => {
    expect(
      chatMessageMarkdown({
        content: `Please review\n\n!file[notes.txt](${url})`,
        attachments: [attachment],
      }),
    ).toBe("Please review");
  });
  it("retains unknown links and ordinary inline CDN attachments", () => {
    const unknown = `!file[notes.txt](${url})`;
    expect(chatMessageMarkdown({ content: unknown, attachments: [] })).toBe(
      unknown,
    );
    const inline = "!file[notes.txt](https://cdn.example/notes.txt)";
    expect(
      chatMessageMarkdown({ content: inline, attachments: [attachment] }),
    ).toBe(inline);
  });
});
