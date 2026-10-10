import { describe, expect, it } from "vitest";

import {
  FILE_CARD_URL_PATTERN,
  isAllowedFileCardHref,
  preprocessFileCards,
} from "@multiremi/ui/markdown";

// Mirror the parser usage: a fresh anchored regex composed from the pattern.
const parser = new RegExp(
  `^!file\\[([^\\]]*)\\]\\((${FILE_CARD_URL_PATTERN.source})\\)$`,
);

describe("isAllowedFileCardHref", () => {
  it.each([
    ["/uploads/ok", true],
    ["/uploads/workspaces/abc/file.png", true],
    ["https://cdn.example.com/x", true],
    ["http://localhost:8080/uploads/x.png", true],
    ["HTTPS://CDN.EXAMPLE.COM/x", true],
  ])("accepts %s", (href, expected) => {
    expect(isAllowedFileCardHref(href)).toBe(expected);
  });

  it.each([
    ["JavaScript:alert(1)", false],
    ["//evil.com/x", false],
  ])("rejects %s", (href, expected) => {
    expect(isAllowedFileCardHref(href)).toBe(expected);
    const markdown = `!file[evil.txt](${href})`;
    expect(parser.test(markdown)).toBe(false);
    expect(preprocessFileCards(markdown, "cdn.example.com")).toBe(markdown);
  });
});

describe("FILE_CARD_URL_PATTERN", () => {
  it.each([
    "!file[doc.md](/uploads/x.md)",
    "!file[name](/uploads/workspaces/abc/019e.md)",
    "!file[doc.md](https://cdn.example.com/x.md)",
    "!file[doc.md](http://localhost:8080/uploads/x.md)",
  ])("parses %s", (input) => {
    expect(parser.test(input)).toBe(true);
  });

  it("does not parse a bare uploads path with a filename", () => {
    expect(parser.test("!file[doc.md](uploads/x.md)")).toBe(false);
  });
});

describe("preprocessFileCards (integration)", () => {
  const cdn = "cdn.example.com";

  it("converts !file[…](/uploads/…) into a file-card div", () => {
    const out = preprocessFileCards("!file[doc.md](/uploads/x.md)", cdn);
    expect(out).toContain('data-type="fileCard"');
    expect(out).toContain('data-href="/uploads/x.md"');
    expect(out).toContain('data-filename="doc.md"');
  });
});

// The same corpus drives the server and full renderer parity checks.
import FILE_CARD_CASES from "../../../../tests/unit/multiremi/file-card-fixtures.json";

describe("shared file-card URL and markdown contract corpus", () => {
  it.each(FILE_CARD_CASES)("$href -> $allowed", ({ href, markdown, allowed }) => {
    expect(isAllowedFileCardHref(href)).toBe(allowed);
    const exact = new RegExp(`^(?:${FILE_CARD_URL_PATTERN.source})$`).exec(href)?.[0] === href;
    expect(exact).toBe(allowed);
    expect(parser.test(markdown)).toBe(allowed);
    const output = preprocessFileCards(markdown, "");
    expect(output.includes('data-type="fileCard"')).toBe(allowed);
    if (!allowed) expect(output).toBe(markdown);
  });
});
