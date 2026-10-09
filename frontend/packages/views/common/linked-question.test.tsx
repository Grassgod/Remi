import { describe, expect, it } from "vitest";
import { linkedQuestionId } from "./linked-question";

describe("question references on message surfaces", () => {
  it("uses the original Q for route notifications and answer history", () => {
    expect(linkedQuestionId("notification", { root_question_id: "original", question: {} })).toBe("original");
  });
  it.each(["question", "human_request", "decision_record"])("recognizes retained %s records without migrating them", key => {
    const metadata = { [key]: { status: "pending" } };
    expect(linkedQuestionId("original", metadata)).toBe("original");
    expect(metadata).toEqual({ [key]: { status: "pending" } });
  });
  it("leaves ordinary messages and unstructured decisions outside the Q projection", () => {
    expect(linkedQuestionId("ordinary", undefined)).toBeNull();
    expect(linkedQuestionId("ordinary", { kind: "decision" })).toBeNull();
  });
});
