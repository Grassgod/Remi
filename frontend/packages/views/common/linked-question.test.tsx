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
  it.each(["question", "human_request"])("recognizes retained %s records without migrating them", key => {
    const metadata = { [key]: { status: "pending" } };
    expect(linkedQuestionId("original", metadata)).toBe("original");
    expect(metadata).toEqual({ [key]: { status: "pending" } });
  });
  it.each(["issue_id", "source_issue_id"])("recognizes actual historical Issue questions by %s without migrating them", key => {
    const record = { status: "pending", [key]: "iss_source" };
    expect(linkedQuestionId("original", { decision_record: record })).toBe("original");
    expect(record).toEqual({ status: "pending", [key]: "iss_source" });
  });
  it.each([undefined, null, false, [], { status: "pending" }, { issue_id: "  " }, { source_issue_id: 42 }])("keeps ordinary or malformed decision state outside the Q projection (%j)", record => {
    expect(linkedQuestionId("ordinary", { decision_record: record })).toBeNull();
  });
  it("keeps new ordinary choices outside the Q projection", () => {
    expect(linkedQuestionId("ordinary", { message_choice: { status: "pending" } })).toBeNull();
  });
  it("leaves ordinary messages and unstructured decisions outside the Q projection", () => {
    expect(linkedQuestionId("ordinary", undefined)).toBeNull();
    expect(linkedQuestionId("ordinary", { kind: "decision" })).toBeNull();
  });
});
