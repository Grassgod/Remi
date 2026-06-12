/** parseMentions: extracts typed mention links, de-duplicated, in order. */

import { test, expect } from "bun:test";
import { parseMentions } from "../src/agent/mentions.js";

test("extracts agent and member mentions with their ids", () => {
  const content =
    "Hey [@Ada](mention://agent/11111111-1111-1111-1111-111111111111), see " +
    "[@Bob](mention://member/22222222-2222-2222-2222-222222222222).";
  expect(parseMentions(content)).toEqual([
    { type: "agent", id: "11111111-1111-1111-1111-111111111111" },
    { type: "member", id: "22222222-2222-2222-2222-222222222222" },
  ]);
});

test("de-duplicates repeated mentions of the same target", () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const content = `[@A](mention://agent/${id}) and again [@A](mention://agent/${id})`;
  expect(parseMentions(content)).toEqual([{ type: "agent", id }]);
});

test("matches issue cross-references (no @) and the all sentinel", () => {
  const content = "[MUL-1](mention://issue/44444444-4444-4444-4444-444444444444) [@all](mention://all/all)";
  expect(parseMentions(content)).toEqual([
    { type: "issue", id: "44444444-4444-4444-4444-444444444444" },
    { type: "all", id: "all" },
  ]);
});

test("labels containing brackets still match", () => {
  const id = "55555555-5555-5555-5555-555555555555";
  expect(parseMentions(`[@David[TF]](mention://agent/${id})`)).toEqual([{ type: "agent", id }]);
});

test("plain text with no mention links yields nothing", () => {
  expect(parseMentions("just a normal comment, no mentions")).toEqual([]);
});
