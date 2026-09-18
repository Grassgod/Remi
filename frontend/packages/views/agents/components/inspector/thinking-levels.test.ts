import { describe, expect, it } from "vitest";
import { getModelThinkingLevels } from "./thinking-levels";
import type { RuntimeModel } from "@multiremi/core/types";

const thinking = (...values: string[]) => ({ supported_levels: values.map(value => ({ value, label: value })) });
const models: RuntimeModel[] = [
  { id: "a", label: "A", thinking: thinking("low", "high") },
  { id: "b", label: "B", thinking: thinking("high", "max") },
  { id: "unknown", label: "Unknown" },
];

describe("default model reasoning capabilities", () => {
  it("never offers stale levels when the authoritative capability state is unavailable", () => {
    for (const status of ["unknown", "unsupported", "error"] as const) {
      const unavailable = { ...thinking("high"), status };
      expect(getModelThinkingLevels([{ id: "a", label: "A", thinking: unavailable }], "a")).toEqual([]);
      expect(getModelThinkingLevels(models, "", unavailable)).toEqual([]);
    }
  });

  it("offers only the intersection of advertised effort values for legacy catalogs", () => {
    expect(getModelThinkingLevels(models, "")).toEqual(thinking("high").supported_levels);
  });
  it("does not invent levels without evidence or on disagreement", () => {
    expect(getModelThinkingLevels([], "")).toEqual([]);
    expect(getModelThinkingLevels([models[0]!, { id: "c", label: "C", thinking: thinking("max") }], "")).toEqual([]);
  });
  it("never substitutes default or sibling capabilities for an explicit model", () => {
    expect(getModelThinkingLevels(models, "a", thinking("max"))).toEqual(thinking("low", "high").supported_levels);
    expect(getModelThinkingLevels(models, "unknown", thinking("max"))).toEqual([]);
    expect(getModelThinkingLevels(models, "missing", thinking("max"))).toEqual([]);
  });
  it("keeps a known concrete default authoritative, even without reasoning metadata", () => {
    expect(getModelThinkingLevels([...models, { id: "default-model", label: "Default", default: true }], "")).toEqual([]);
  });
});
