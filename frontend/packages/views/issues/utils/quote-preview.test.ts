import { describe, it, expect } from "vitest";
import { quotePreview } from "./quote-preview";

describe("quotePreview", () => {
  it("returns short plain text unchanged", () => {
    expect(quotePreview("收到，以后我就叫周周")).toBe("收到，以后我就叫周周");
  });

  it("renders a mention as its label, not as markdown", () => {
    expect(
      quotePreview("[@周周](mention://agent/de8efbcc-eaa1-4605) 看一下这个"),
    ).toBe("@周周 看一下这个");
  });

  it("keeps only the text of a link", () => {
    expect(quotePreview("see [the docs](https://example.com/a/b) first")).toBe(
      "see the docs first",
    );
  });

  it("drops images entirely", () => {
    expect(quotePreview("before ![shot](/uploads/a.png) after")).toBe(
      "before after",
    );
  });

  it("removes inline code and fence markers", () => {
    expect(quotePreview("run `bun test` now")).toBe("run bun test now");
    expect(quotePreview("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("removes emphasis markers", () => {
    expect(quotePreview("**bold** and _italic_ and ~~gone~~")).toBe(
      "bold and italic and gone",
    );
  });

  it("removes heading, bullet and blockquote line markers", () => {
    expect(quotePreview("## Title\n- one\n- two\n> quoted")).toBe(
      "Title one two quoted",
    );
  });

  it("collapses newlines and runs of whitespace into single spaces", () => {
    expect(quotePreview("first\n\n  second\tthird ")).toBe(
      "first second third",
    );
  });

  it("truncates past the char budget with an ellipsis", () => {
    // 60 chars in, 40 + ellipsis out.
    const long = "a".repeat(60);
    expect(quotePreview(long)).toBe(`${"a".repeat(40)}…`);
  });

  it("counts stripped text, not raw markdown, against the budget", () => {
    // The mention's URL is 40+ chars on its own; a raw slice would show
    // nothing but a link target.
    expect(
      quotePreview(
        "[@周周](mention://agent/de8efbcc-eaa1-4605-a6ac-d50cfa88e447) 收到，以后我就叫周周",
      ),
    ).toBe("@周周 收到，以后我就叫周周");
  });

  it("honours an explicit budget", () => {
    expect(quotePreview("abcdefghij", 4)).toBe("abcd…");
  });

  it("handles an empty body", () => {
    expect(quotePreview("")).toBe("");
  });
});
