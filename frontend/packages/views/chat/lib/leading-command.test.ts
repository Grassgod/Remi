import { describe, expect, it } from "vitest";
import { leadingCommandChipMarkdown } from "./leading-command";

describe("leadingCommandChipMarkdown", () => {
  it("turns the leading command into a chip link and keeps the rest", () => {
    expect(leadingCommandChipMarkdown("/compact")).toBe("[/compact](slash://command/compact)");
    expect(leadingCommandChipMarkdown("/compact keep the plan\n\nmore")).toBe("[/compact](slash://command/compact) keep the plan\n\nmore");
    expect(leadingCommandChipMarkdown("/mcp:github:pr 12")).toBe("[/mcp:github:pr](slash://command/mcp%3Agithub%3Apr) 12");
  });

  it("leaves paths, mid-text commands, old skill links and `$` mentions alone", () => {
    for (const text of ["/tmp/x is missing", "please /compact", "/ logout", "[/deploy](slash://skill/s1) now", "$deploy now", "/"]) {
      expect(leadingCommandChipMarkdown(text)).toBe(text);
    }
  });
});
