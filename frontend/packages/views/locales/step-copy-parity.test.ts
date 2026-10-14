import { describe, expect, it } from "vitest";
import { STEP_COPY_ZH } from "@multiremi/shared/trace-step-copy";
import en from "./en/chat.json";
import ja from "./ja/chat.json";
import ko from "./ko/chat.json";
import zh from "./zh-Hans/chat.json";

// The step copy has one source: `STEP_COPY_ZH` in `@multiremi/shared`, which
// Feishu and the CLI render directly. The web's zh-Hans table must be that
// object, key for key and word for word; the other locales translate the same
// keys (en with `_one` / `_other` plurals, ja and ko with `_other` only).

function baseKeys(table: Record<string, string>): string[] {
  return [...new Set(Object.keys(table).map((key) => key.replace(/_(one|other)$/, "")))].sort();
}

describe("step copy parity", () => {
  it("web zh-Hans equals STEP_COPY_ZH", () => {
    expect(zh.steps).toEqual(STEP_COPY_ZH);
  });

  it.each([["en", en], ["ja", ja], ["ko", ko]] as const)("%s translates every step key", (_locale, bundle) => {
    expect(baseKeys(bundle.steps)).toEqual(baseKeys(STEP_COPY_ZH));
  });

  it.each([["en", en], ["ja", ja], ["ko", ko]] as const)("%s keeps every placeholder", (_locale, bundle) => {
    const table = bundle.steps as Record<string, string>;
    const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
    for (const [key, text] of Object.entries(STEP_COPY_ZH)) {
      const translated = table[key] ?? table[key.replace(/_other$/, "_one")];
      expect(translated, key).toBeDefined();
      expect(placeholders(translated!), key).toEqual(placeholders(text));
    }
  });

  it("en has both plural forms for every summary fragment", () => {
    for (const key of Object.keys(STEP_COPY_ZH).filter((k) => k.endsWith("_other"))) {
      const base = key.slice(0, -"_other".length);
      expect(Object.keys(en.steps)).toEqual(expect.arrayContaining([`${base}_one`, `${base}_other`]));
    }
  });
});
