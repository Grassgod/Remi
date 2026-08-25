import { describe, it, expect } from "bun:test";

import {
  elicitationToQuestions,
  answersToElicitationContent,
} from "@acp/index.js";
import type { ElicitationCreateParams } from "@acp/index.js";
import { sliceElicitationContext } from "@multiremi/daemon.js";

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

// Mirrors codex-acp's buildUserInputRequest (dist/index.js:25109-25172): each
// question carries its help text as a per-option `description`, and a question
// that accepts a custom answer gets an extra `<questionId>__other` free-text
// property tagged `_meta.codex.isOtherAnswer`.
function codexRequest(): ElicitationCreateParams {
  return {
    mode: "form",
    sessionId: "sess_1",
    message: "Which deploy target?",
    requestedSchema: {
      type: "object",
      properties: {
        q1: {
          type: "string",
          title: "Target",
          description: "Which deploy target?",
          _meta: { codex: { isOther: true, isSecret: false } },
          oneOf: [
            { const: "staging", title: "staging", description: "safe sandbox" },
            { const: "prod", title: "prod", description: "the real thing" },
          ],
        },
        q1__other: {
          type: "string",
          title: "Other",
          description: "Type your own answer instead of choosing an option above.",
          _meta: { codex: { questionId: "q1", isOtherAnswer: true, isSecret: false } },
        },
      },
      required: [],
    },
  };
}

describe("elicitationToQuestions (codex)", () => {
  it("folds the __other companion into its parent question and keeps option descriptions", () => {
    const questions = elicitationToQuestions(codexRequest())!;
    expect(questions).toHaveLength(1);
    expect(questions[0].fieldKey).toBe("q1");
    expect(questions[0].otherFieldKey).toBe("q1__other");
    expect(questions[0].question.question).toBe("Which deploy target?");
    expect(questions[0].question.options).toEqual([
      { label: "staging", description: "safe sandbox" },
      { label: "prod", description: "the real thing" },
    ]);
  });

  it("keeps a __other-suffixed field that owns no parent question", () => {
    const params: ElicitationCreateParams = {
      mode: "form",
      sessionId: "sess_1",
      message: "What is your other name?",
      requestedSchema: { type: "object", properties: { name__other: { type: "string" } } },
    };
    const questions = elicitationToQuestions(params)!;
    expect(questions).toHaveLength(1);
    expect(questions[0].fieldKey).toBe("name__other");
    expect(questions[0].otherFieldKey).toBeUndefined();
  });
});

// Mirrors claude-agent-acp >= 0.66.0 (dist/elicitation.js:75-110): the single
// form-level `customAnswer` is replaced by a per-question free-text companion
// `question_<n>_custom`, which the agent reads back in preference to the
// parent field. Left unfolded it renders as a required standalone question and
// blocks form submission (MUL-58).
function claudeCustomRequest(): ElicitationCreateParams {
  return {
    mode: "form",
    sessionId: "sess_1",
    message: "您这次让我用 AskUserQuestion 提问，主要是想测试什么？",
    requestedSchema: {
      type: "object",
      properties: {
        question_0: {
          type: "string",
          title: "测试目的",
          oneOf: [
            { const: "测试交互问答功能" },
            { const: "只是随便玩玩" },
          ],
        },
        question_0_custom: {
          type: "string",
          title: "Other",
          description: "Type your own answer instead of choosing an option above (optional).",
        },
      },
    },
  };
}

describe("elicitationToQuestions (claude >= 0.66)", () => {
  it("folds question_<n>_custom into its parent question instead of rendering it standalone", () => {
    const questions = elicitationToQuestions(claudeCustomRequest())!;
    expect(questions).toHaveLength(1);
    expect(questions[0].fieldKey).toBe("question_0");
    expect(questions[0].otherFieldKey).toBe("question_0_custom");
    expect(questions[0].question.header).toBe("测试目的");
    expect(questions[0].question.options.map((o) => o.label)).toEqual([
      "测试交互问答功能",
      "只是随便玩玩",
    ]);
  });

  it("keeps a _custom-suffixed field that owns no parent question", () => {
    const params: ElicitationCreateParams = {
      mode: "form",
      sessionId: "sess_1",
      message: "What is your custom name?",
      requestedSchema: { type: "object", properties: { question_9_custom: { type: "string" } } },
    };
    const questions = elicitationToQuestions(params)!;
    expect(questions).toHaveLength(1);
    expect(questions[0].fieldKey).toBe("question_9_custom");
    expect(questions[0].otherFieldKey).toBeUndefined();
  });

  it("posts option labels to the parent field and free text to the _custom companion", () => {
    const questions = elicitationToQuestions(claudeCustomRequest())!;
    const questionText = "您这次让我用 AskUserQuestion 提问，主要是想测试什么？";
    expect(answersToElicitationContent(questions, { [questionText]: "只是随便玩玩" })).toEqual({
      question_0: "只是随便玩玩",
    });
    expect(answersToElicitationContent(questions, { [questionText]: "有点问题, 我无法点击提交" })).toEqual({
      question_0_custom: "有点问题, 我无法点击提交",
    });
  });
});

describe("answersToElicitationContent", () => {
  it("posts a free-text answer to the __other field and an option label to the parent", () => {
    const questions = elicitationToQuestions(codexRequest())!;
    expect(answersToElicitationContent(questions, { "Which deploy target?": "prod" })).toEqual({ q1: "prod" });
    expect(answersToElicitationContent(questions, { "Which deploy target?": "canary-3" })).toEqual({
      q1__other: "canary-3",
    });
  });

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

describe("sliceElicitationContext", () => {
  it("consumes only assistant text emitted after the previous question", () => {
    const firstText = "First decision context.";
    const first = sliceElicitationContext(firstText, 0, "First question?", ["First question?"]);
    expect(first.context).toEqual({ text: firstText });

    const secondText = "Second decision context.";
    const second = sliceElicitationContext(
      firstText + secondText,
      first.offset,
      "Second question?",
      ["Second question?"],
    );
    expect(second.context).toEqual({ text: secondText });
    expect(second.offset).toBe((firstText + secondText).length);
  });

  it("omits context that only repeats the question or payload message", () => {
    const repeated = "  Which library should we use?\n";
    const result = sliceElicitationContext(
      repeated,
      0,
      "Which library should we use?",
      ["Which library should we use?"],
    );
    expect(result.context).toBeUndefined();
    expect(result.offset).toBe(repeated.length);
  });

  it("keeps the last 4000 characters and marks truncated context", () => {
    const result = sliceElicitationContext("a".repeat(4_001), 0, "Question?", ["Question?"]);
    expect(result.context?.text).toHaveLength(4_000);
    expect(result.context).toEqual({ text: "a".repeat(4_000), truncated: true });
  });
});
