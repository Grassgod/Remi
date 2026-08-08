import { describe, expect, it } from "vitest";
import {
  AttachmentSchema,
  BooleanWithDefaultSchema,
  OptionalStringSchema,
  ReactionSchema,
} from "./primitives";

// These four leaves used to be file-private inside the 1306-line schemas.ts.
// They are now imported by timeline/, comments/ and config/, so their
// leniency contract is a shared one and needs its own coverage.
describe("OptionalStringSchema", () => {
  it("passes strings through", () => {
    expect(OptionalStringSchema.parse("hello")).toBe("hello");
  });

  it("drops non-strings to undefined instead of failing", () => {
    for (const value of [42, null, undefined, {}, []]) {
      expect(OptionalStringSchema.parse(value)).toBeUndefined();
    }
  });
});

describe("BooleanWithDefaultSchema", () => {
  it("passes booleans through", () => {
    expect(BooleanWithDefaultSchema(false).parse(true)).toBe(true);
    expect(BooleanWithDefaultSchema(true).parse(false)).toBe(false);
  });

  it("falls back for non-booleans, including the string 'false'", () => {
    expect(BooleanWithDefaultSchema(true).parse("false")).toBe(true);
    expect(BooleanWithDefaultSchema(false).parse(null)).toBe(false);
    expect(BooleanWithDefaultSchema(true).parse(undefined)).toBe(true);
  });
});

describe("ReactionSchema", () => {
  it("requires every field the reaction row is keyed on", () => {
    const ok = {
      id: "r-1",
      comment_id: "c-1",
      actor_type: "member",
      actor_id: "u-1",
      emoji: "+1",
      created_at: "2026-05-11T00:00:00Z",
    };
    expect(ReactionSchema.safeParse(ok).success).toBe(true);
    expect(ReactionSchema.safeParse({ ...ok, emoji: undefined }).success).toBe(false);
  });

  it("keeps actor_type open so a new server-side actor kind still parses", () => {
    const parsed = ReactionSchema.parse({
      id: "r-1",
      comment_id: "c-1",
      actor_type: "squad",
      actor_id: "s-1",
      emoji: "eyes",
      created_at: "",
    });
    expect(parsed.actor_type).toBe("squad");
  });
});

describe("AttachmentSchema", () => {
  it("only requires id and passes unknown fields through", () => {
    const parsed = AttachmentSchema.parse({ id: "att-1", filename: "a.md", size_bytes: 3 });
    expect(parsed).toMatchObject({ id: "att-1", filename: "a.md", size_bytes: 3 });
  });

  it("fails the row (not the whole list) when id is missing", () => {
    expect(AttachmentSchema.safeParse({ filename: "a.md" }).success).toBe(false);
  });
});
