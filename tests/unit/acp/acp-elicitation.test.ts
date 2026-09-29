import { describe, it, expect } from "bun:test";

import {
  elicitationToQuestions,
  answersToElicitationContent,
} from "@acp/index.js";
import type { ElicitationCreateParams, ElicitationPropertySchema } from "@acp/index.js";
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

// Mirrors codex-acp 1.11.0 buildUserInputRequest() (dist/index.js:26343-26405):
// the short header is the field `title`, the question text is `description`,
// and a question that accepts a custom answer gets an extra
// `<questionId>__other` free-text property tagged `_meta.codex.isOtherAnswer`.
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

// Mirrors codex-acp 1.13.1 buildUserInputRequest()
// (dist/index.js:32052-32105): the question text is the field `title`, the
// short header is `description`, `message` is the fixed "Codex needs your
// input to continue." boilerplate, every field is tagged `_meta.codex`, a
// question that allows a custom answer appends the synthetic "None of the
// above" option and a `<id>_note` companion field tagged
// `_meta.codex = { questionId, role: "user_note" }`.
function codexUserInputRequest(
  properties: Record<string, ElicitationPropertySchema>,
  required: string[],
): ElicitationCreateParams {
  return {
    mode: "form",
    sessionId: "sess_1",
    toolCallId: "call_1",
    message: "Codex needs your input to continue.",
    requestedSchema: { type: "object", properties, required },
    _meta: { codex: { autoResolutionMs: null } },
  };
}

describe("elicitationToQuestions (codex >= 1.12)", () => {
  it("reads the issue's lunch sample: question from title, header from description, note folded in", () => {
    const questions = elicitationToQuestions(codexUserInputRequest({
      lunch: {
        title: "午饭吃什么？",
        description: "午饭",
        type: "string",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "面条 (Recommended)", title: "面条 (Recommended)" },
          { const: "米饭", title: "米饭" },
          {
            const: "None of the above",
            title: "None of the above",
            description: "Provide a different answer in the note field.",
          },
        ],
      },
      lunch_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "lunch", role: "user_note", isSecret: false } },
      },
    }, ["lunch"]))!;

    expect(questions).toHaveLength(1);
    expect(questions[0].fieldKey).toBe("lunch");
    expect(questions[0].otherFieldKey).toBe("lunch_note");
    expect(questions[0].question.question).toBe("午饭吃什么？");
    expect(questions[0].question.header).toBe("午饭");
    expect(questions[0].question.options).toEqual([
      { label: "面条 (Recommended)" },
      { label: "米饭" },
    ]);
  });

  it("keeps several questions apart and folds each note into its own question", () => {
    const questions = elicitationToQuestions(codexUserInputRequest({
      lunch: {
        title: "午饭吃什么？",
        description: "午饭",
        type: "string",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "面条", title: "面条" },
          { const: "None of the above", title: "None of the above" },
        ],
      },
      lunch_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "lunch", role: "user_note", isSecret: false } },
      },
      arrival: {
        title: "几点到？",
        description: "到达时间",
        type: "string",
        _meta: { codex: { isOther: false, isSecret: false } },
        oneOf: [
          { const: "12:00", title: "12:00", description: "午饭前" },
          { const: "18:00", title: "18:00" },
        ],
      },
    }, ["lunch", "arrival"]))!;

    expect(questions.map((q) => q.fieldKey)).toEqual(["lunch", "arrival"]);
    expect(questions[0].otherFieldKey).toBe("lunch_note");
    expect(questions[1].otherFieldKey).toBeUndefined();
    expect(questions[1].question.question).toBe("几点到？");
    expect(questions[1].question.header).toBe("到达时间");
    expect(questions[1].question.options).toEqual([
      { label: "12:00", description: "午饭前" },
      { label: "18:00" },
    ]);
  });

  it("keeps a note field whose questionId has no matching question as a standalone question", () => {
    const questions = elicitationToQuestions(codexUserInputRequest({
      orphan_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "gone", role: "user_note" } },
      },
    }, []))!;

    expect(questions).toHaveLength(1);
    expect(questions[0].fieldKey).toBe("orphan_note");
    expect(questions[0].otherFieldKey).toBeUndefined();
    expect(questions[0].question.question).toBe("Additional answer or note");
  });

  it("renders a question without options as free text and never consults message", () => {
    const questions = elicitationToQuestions(codexUserInputRequest({
      name: {
        title: "你的名字？",
        description: "姓名",
        type: "string",
        _meta: { codex: { isOther: false, isSecret: false } },
      },
    }, ["name"]))!;

    expect(questions).toHaveLength(1);
    expect(questions[0].question.question).toBe("你的名字？");
    expect(questions[0].question.header).toBe("姓名");
    expect(questions[0].question.options).toEqual([]);
  });

  it("leaves options alone when the question allows no custom answer", () => {
    const questions = elicitationToQuestions(codexUserInputRequest({
      arrival: {
        title: "几点到？",
        description: "到达时间",
        type: "string",
        _meta: { codex: { isOther: false, isSecret: false } },
        oneOf: [
          { const: "12:00", title: "12:00" },
          { const: "None of the above", title: "None of the above" },
        ],
      },
    }, ["arrival"]))!;

    expect(questions[0].otherFieldKey).toBeUndefined();
    expect(questions[0].question.options.map((o) => o.label)).toEqual(["12:00", "None of the above"]);
  });

  it("posts option labels to the question field and custom text to its note field", () => {
    const questions = elicitationToQuestions(codexUserInputRequest({
      lunch: {
        title: "午饭吃什么？",
        description: "午饭",
        type: "string",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "面条 (Recommended)", title: "面条 (Recommended)" },
          { const: "米饭", title: "米饭" },
          { const: "None of the above", title: "None of the above" },
        ],
      },
      lunch_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "lunch", role: "user_note", isSecret: false } },
      },
      arrival: {
        title: "几点到？",
        description: "到达时间",
        type: "string",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "12:00", title: "12:00" },
          { const: "None of the above", title: "None of the above" },
        ],
      },
      arrival_note: {
        type: "string",
        title: "Additional answer or note",
        _meta: { codex: { questionId: "arrival", role: "user_note", isSecret: false } },
      },
    }, ["lunch", "arrival"]))!;

    // Option answers go to the parent field; custom text goes to the note field
    // codex-acp reads back as `user_note: <text>`.
    expect(answersToElicitationContent(questions, { "午饭吃什么？": "面条 (Recommended)", "几点到？": "12:00" }))
      .toEqual({ lunch: "面条 (Recommended)", arrival: "12:00" });
    expect(answersToElicitationContent(questions, { "午饭吃什么？": "饺子", "几点到？": "13:30 左右" }))
      .toEqual({ lunch_note: "饺子", arrival_note: "13:30 左右" });
    expect(answersToElicitationContent(questions, { "午饭吃什么？": "米饭", "几点到？": "19 点吧" }))
      .toEqual({ lunch: "米饭", arrival_note: "19 点吧" });
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
