import { describe, it, expect } from "bun:test";

import {
  elicitationToQuestions,
  answersToElicitationContent,
} from "@remi/acp-provider";
import type { ElicitationCreateParams } from "@remi/acp-provider";

// Mirrors the request shape the Claude ACP agent (>= 0.44.0) builds from the
// AskUserQuestion tool in askUserQuestionsToCreateRequest().
function askRequest(overrides: Partial<ElicitationCreateParams> = {}): ElicitationCreateParams {
  return {
    mode: "form",
    sessionId: "sess_1",
    message: "Which library should we use?",
    requestedSchema: {
      type: "object",
      properties: {
        question_0: {
          type: "string",
          title: "Library",
          oneOf: [
            { const: "lodash", title: "lodash — battle-tested utils" },
            { const: "ramda", title: "ramda" },
          ],
        },
        customAnswer: {
          type: "string",
          title: "Other",
          description: "Type your own answer instead of choosing an option above (optional).",
        },
      },
    },
    ...overrides,
  };
}

describe("elicitationToQuestions", () => {
  it("converts a single-question form, using message as the question text", () => {
    const questions = elicitationToQuestions(askRequest());
    expect(questions).toHaveLength(1);
    const q = questions![0];
    expect(q.fieldKey).toBe("question_0");
    expect(q.question.question).toBe("Which library should we use?");
    expect(q.question.header).toBe("Library");
    expect(q.question.multiSelect).toBe(false);
    expect(q.question.options).toEqual([
      { label: "lodash", description: "battle-tested utils" },
      { label: "ramda" },
    ]);
  });

  it("converts multi-question forms with per-field question text and multi-select", () => {
    const params = askRequest({
      message: "Please answer the following questions.",
      requestedSchema: {
        type: "object",
        properties: {
          question_0: {
            type: "string",
            description: "Pick a color",
            oneOf: [{ const: "red" }, { const: "blue" }],
          },
          question_1: {
            type: "array",
            title: "Tools",
            description: "Which tools do you want?",
            items: { anyOf: [{ const: "hammer" }, { const: "saw" }] },
          },
          customAnswer: { type: "string", title: "Other" },
        },
      },
    });
    const questions = elicitationToQuestions(params)!;
    expect(questions).toHaveLength(2);
    expect(questions[0].question.question).toBe("Pick a color");
    expect(questions[1].question.question).toBe("Which tools do you want?");
    expect(questions[1].question.multiSelect).toBe(true);
    expect(questions[1].question.options.map((o) => o.label)).toEqual(["hammer", "saw"]);
  });

  it("renders schema-less or url elicitations as unsupported", () => {
    expect(elicitationToQuestions(askRequest({ requestedSchema: undefined }))).toBeNull();
    expect(elicitationToQuestions(askRequest({ mode: "url", url: "https://example.com" }))).toBeNull();
  });

  it("treats free-text fields (no enum) as open questions", () => {
    const params = askRequest({
      message: "What is your name?",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    });
    const questions = elicitationToQuestions(params)!;
    expect(questions).toHaveLength(1);
    expect(questions[0].question.question).toBe("What is your name?");
    expect(questions[0].question.options).toEqual([]);
  });
});

describe("answersToElicitationContent", () => {
  it("maps answers keyed by question text back to field keys", () => {
    const questions = elicitationToQuestions(askRequest())!;
    const content = answersToElicitationContent(questions, {
      "Which library should we use?": "lodash",
    });
    expect(content).toEqual({ question_0: "lodash" });
  });

  it("omits empty answers so the agent treats them as skipped", () => {
    const questions = elicitationToQuestions(askRequest())!;
    expect(answersToElicitationContent(questions, { "Which library should we use?": "  " })).toEqual({});
    expect(answersToElicitationContent(questions, {})).toEqual({});
  });
});
