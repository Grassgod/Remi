import { describe, expect, test } from "bun:test";
import { fromHtml } from "hast-util-from-html";
import { FILE_CARD_URL_PATTERN, preprocessFileCards } from "@multiremi/render/preprocess.js";
import { renderMarkdown } from "@multiremi/render/markdown.js";

describe("authenticated attachment file cards (MUL-499)", () => {
  test.each([
    "/api/attachments/att-1/content",
    "/api/attachments/Att_ABC-123/content?workspace_slug=acme&download=1",
    "/api/attachments/att/content?",
  ])("renders a TXT file card for %s", href => {
    const markdown = `!file[notes.txt](${href})`;
    expect(preprocessFileCards(markdown, "")).toContain('data-type="fileCard"');
    const { html } = renderMarkdown(markdown);
    expect(html).toContain('data-type="fileCard"');
    expect(html).toContain('data-filename="notes.txt"');
    const card = fromHtml(html, { fragment: true }).children.find(node => node.type === "element" && node.properties.dataType === "fileCard");
    expect(card?.type === "element" ? card.properties.dataHref : undefined).toBe(href);
  });

  test.each([
    "/api/attachments//content",
    "/api/attachments/att.1/content",
    "/api/attachments/../content",
    "/api/attachments/att/../content",
    "/api/attachments/%2e%2e/content",
    "/api/attachments/att/content/extra",
    "/api/attachments/att/content#fragment",
    "/api/attachments/att/content?next=..",
    "/api/attachments/att/content?x=bad)value",
    "/api/attachments/att/content?x=bad value",
    "/api/attachments/att/content?x=bad\tvalue",
    "/api/attachments/att/content\n",
    "/api/attachments/att\\other/content",
    "/api/internal/att/content",
    "//host/api/attachments/att/content",
    "javascript:alert(1)",
    "data:text/plain,test",
  ])("rejects %s", href => {
    const markdown = `!file[notes.txt](${href})`;
    expect(preprocessFileCards(markdown, "")).not.toContain('data-type="fileCard"');
    expect(renderMarkdown(markdown).html).not.toContain('data-type="fileCard"');
  });

  test("frontend and server use the same URL pattern", async () => {
    const specifier = "@multiremi/ui/markdown";
    const frontend = await import(specifier) as { FILE_CARD_URL_PATTERN: RegExp };
    expect(FILE_CARD_URL_PATTERN.source).toBe(frontend.FILE_CARD_URL_PATTERN.source);
  });
});
