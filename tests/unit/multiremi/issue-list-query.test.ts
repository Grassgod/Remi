import { afterEach, describe, expect, it } from "bun:test";
import { issueListQuery } from "@multiremi/api/helpers/issues.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("issueListQuery assignee type spellings", () => {
  for (const [name, mode, query, expected] of [
    ["compat accepts the legacy singular", "compat", "assignee_type=member", ["member"]],
    ["compat prefers the plural", "compat", "assignee_type=member&assignee_types=agent,squad", ["agent", "squad"]],
    ["compat does not fall back from an empty plural", "compat", "assignee_type=member&assignee_types=", []],
    ["compat ignores camelCase", "compat", "assigneeTypes=agent&assignee_type=member", ["member"]],
    ["native still ignores the singular", "native", "assignee_type=member&assigneeType=squad", []],
    ["native accepts snake-case plural", "native", "assignee_types=member&assignee_type=agent", ["member"]],
    ["native prefers camelCase plural", "native", "assigneeTypes=squad&assignee_types=agent&assignee_type=member", ["squad"]],
    ["native does not fall back from an empty camelCase plural", "native", "assigneeTypes=&assignee_types=agent&assignee_type=member", []],
  ] as const) {
    it(name, () => {
      const store = createStore();
      const params = new URLSearchParams(query);
      const result = issueListQuery(store, { req: { query: (key) => params.get(key) ?? undefined } }, mode);
      expect(result.assigneeTypes).toEqual([...expected]);
    });
  }
});
