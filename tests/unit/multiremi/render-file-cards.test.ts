import { describe, expect, test } from "bun:test";
import { FILE_CARD_URL_PATTERN, preprocessFileCards } from "@multiremi/render/preprocess.js";
import { renderMarkdown } from "@multiremi/render/markdown.js";
import { fromHtml } from "hast-util-from-html";
import FILE_CARD_CASES from "./file-card-fixtures.json";

describe("server file cards (MUL-518)", () => {
  for (const { href, markdown, allowed } of FILE_CARD_CASES) {
    test(`URL and prepass boundary: ${JSON.stringify(href)}`, () => {
      const exact = new RegExp(`^(?:${FILE_CARD_URL_PATTERN.source})$`).exec(href)?.[0] === href;
      expect(exact).toBe(allowed);
      const output = preprocessFileCards(markdown, "");
      expect(output.includes('data-type="fileCard"')).toBe(allowed);
      expect(renderMarkdown(markdown).html.includes('data-type="fileCard"')).toBe(allowed);
      if (!allowed) expect(output).toBe(markdown);
    });
  }
  test("escapes filename and URL attributes", () => {
    const html = renderMarkdown('!file[a"<.txt](/api/attachments/att_1/content?x=1&y=2)').html;
    const card = fromHtml(html, { fragment: true }).children[0];
    if (!card || card.type !== "element") throw new Error("Expected one card element");
    expect(card.tagName).toBe("div");
    expect(card.properties).toEqual({ dataType: "fileCard",
      dataFilename: 'a"<.txt', dataHref: "/api/attachments/att_1/content?x=1&y=2" });
    expect(card.children).toEqual([]);
  });
});
