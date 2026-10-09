import { describe, expect, it } from "vitest";
import { questionAnswerBody, questionReplyText } from "./question-answer";

describe("readable native answers", () => {
  it("shows a selected label intact, including commas, from the native reply envelope", () => {
    const response = { answers: { "Which?": "A, B" } };
    expect(questionReplyText(JSON.stringify(response), { root_question_id: "q", human_response: response })).toBe("A, B");
  });
  it("retains the association for several questions and custom answers", () => {
    const response = { answers: { "Where?": "Staging", "Why?": "A custom explanation" } };
    expect(questionAnswerBody({ response, body_md: JSON.stringify(response) })).toBe("Where?\n\nStaging\n\nWhy?\n\nA custom explanation");
  });
  it("preserves separately authored answer prose", () => {
    const response = { answers: { "Which?": "A" } };
    const body_md = "Choose A after reviewing the evidence.";
    expect(questionAnswerBody({ response, body_md })).toBe(body_md);
    expect(questionReplyText(body_md, { root_question_id: "q", human_response: response })).toBe(body_md);
  });
  it("uses the original permission label while retaining its transport value", () => {
    const response = { option_id: "allow_once" };
    expect(questionAnswerBody({ response, body_md: JSON.stringify(response) }, [{ value: "allow_once", label: "Allow once" }])).toBe("Allow once");
    expect(response.option_id).toBe("allow_once");
  });
  it("leaves ordinary JSON and unknown response shapes intact", () => {
    const response = { answers: { "Which?": { unknown: true } } };
    const body = JSON.stringify(response);
    expect(questionReplyText(body, { human_response: response })).toBe(body);
    expect(questionReplyText(body, { root_question_id: "q", human_response: response })).toBe(body);
  });
});
