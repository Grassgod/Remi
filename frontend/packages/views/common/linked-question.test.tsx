import { describe, expect, it } from "vitest";
import { linkedQuestionId } from "./linked-question";

describe("question references on message surfaces", () => {
  it("uses the original Q for explicit route and presentation notifications", () => {
    expect(linkedQuestionId("notification", { root_question_id: "original", question_notification: true })).toBe("original");
    expect(linkedQuestionId("presentation", { root_question_id: "original", question_present_request: true })).toBe("original");
  });
  it("leaves answer, revision and status bodies visible without duplicating the original Q", () => {
    expect(linkedQuestionId("answer", { root_question_id: "original", human_response: { answers: { question: "Continue" } }, question_route_revision: 1 })).toBeNull();
    expect(linkedQuestionId("revision", { root_question_id: "original", question_answer_revision: true })).toBeNull();
    expect(linkedQuestionId("status", { root_question_id: "original", question_closed: true })).toBeNull();
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
