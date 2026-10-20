import { describe, expect, it } from "vitest";
import type { ChatSlashCommandsResponse, SlashCommandEntry } from "@multiremi/contracts/slash-commands";
import {
  blockedSlashCommand,
  buildSlashMenu,
  defaultSlashSelection,
  platformSkillInvocation,
  rankSlashMenu,
  slashInvocation,
  startsWithSlashCommand,
  type SlashMenuItem,
} from "./slash-menu";

const command = (name: string, fields: Partial<SlashCommandEntry> = {}): SlashCommandEntry => ({
  name, description: "", hint: null, kind: "command", ...fields,
});
const response = (commands: SlashCommandEntry[], state: ChatSlashCommandsResponse["state"] = "session"): ChatSlashCommandsResponse => ({
  state, provider: "claude", reported_at: null, commands,
});

describe("buildSlashMenu", () => {
  it("lists the agent's commands, then its platform skills", () => {
    const model = buildSlashMenu({
      provider: "claude",
      status: "ready",
      response: response([command("compact", { hint: "[instructions]" }), command("mcp:github:pr", { kind: "mcp_prompt" })]),
      skills: [{ id: "s1", name: "Deploy Prod", description: "Ship it" }],
    });
    expect(model).toMatchObject({ status: "ready", catalogue: "session", provider: "claude" });
    expect(model.items.map((item) => [item.group, item.invocation, item.hint])).toEqual([
      ["agent", "/compact", "[instructions]"],
      ["agent", "/mcp:github:pr", null],
      ["skill", "/deploy-prod", null],
    ]);
  });

  it("merges a native skill entry into its platform skill by skill id, never by name", () => {
    const model = buildSlashMenu({
      provider: "claude",
      status: "ready",
      response: response([
        // The Remi-installed skill, advertised under its slug.
        command("deploy-prod", { kind: "skill", skill_id: "s1", hint: "<env>", description: "native text" }),
        // The user's own skill with the platform skill's name: a different item.
        command("Deploy Prod", { kind: "skill" }),
      ]),
      skills: [{ id: "s1", name: "Deploy Prod", description: "" }],
    });
    expect(model.items).toEqual([
      expect.objectContaining({ id: "agent:Deploy Prod", group: "agent", invocation: "/Deploy Prod" }),
      {
        id: "skill:s1", group: "skill", label: "Deploy Prod", invocation: "/deploy-prod",
        description: "native text", hint: "<env>", kind: "skill", skillId: "s1",
      },
    ]);
  });

  it("keeps Codex's own /review apart from a platform skill called review", () => {
    const model = buildSlashMenu({
      provider: "codex",
      status: "ready",
      response: response([command("review")]),
      skills: [{ id: "s2", name: "review" }],
    });
    expect(model.items.map((item) => [item.group, item.invocation])).toEqual([["agent", "/review"], ["skill", "$review"]]);
  });

  it("keeps a Codex skill's `$` and gives unadvertised skills the provider's invocation", () => {
    const model = buildSlashMenu({
      provider: "codex",
      status: "ready",
      response: response([command("$review", { kind: "skill" })]),
      skills: [{ id: "s1", name: "Deploy Prod" }],
    });
    expect(model.items.map((item) => item.invocation)).toEqual(["$review", "$deploy-prod"]);
  });

  it("shows only platform skills before the catalogue is read, and says why", () => {
    for (const status of ["loading", "error"] as const) {
      const model = buildSlashMenu({ provider: "claude", status, response: null, skills: [{ id: "s1", name: "x" }] });
      expect(model).toMatchObject({ status, catalogue: null });
      expect(model.items.map((item) => item.group)).toEqual(["skill"]);
    }
    const none = buildSlashMenu({ provider: "claude", status: "ready", response: response([], "none"), skills: [] });
    expect(none).toMatchObject({ status: "ready", catalogue: "none", items: [] });
  });
});

describe("invocations", () => {
  it("writes a catalogue name and a platform skill the way the provider reads them", () => {
    expect(slashInvocation("compact")).toBe("/compact");
    expect(slashInvocation("$deploy")).toBe("$deploy");
    expect(platformSkillInvocation("claude", "Deploy Prod")).toBe("/deploy-prod");
    expect(platformSkillInvocation("antigravity", "Deploy Prod")).toBe("/deploy-prod");
    expect(platformSkillInvocation("codex", "Deploy Prod")).toBe("$deploy-prod");
  });
});

const item = (label: string, fields: Partial<SlashMenuItem> = {}): SlashMenuItem => ({
  id: `agent:${label}`, group: "agent", label, invocation: `/${label}`, description: "", hint: null,
  kind: "command", skillId: null, ...fields,
});

describe("rankSlashMenu", () => {
  const items = [
    item("compact-history"),
    item("review", { description: "Check a PR, then pull it" }),
    item("pr-comments"),
    item("compact"),
    item("git-compact"),
    item("recompact"),
    item("deploy", { group: "skill", id: "skill:s1", invocation: "/deploy" }),
    item("pr", { group: "skill", id: "skill:s2", invocation: "/pr" }),
  ];

  it("ranks exact, prefix, word start, contains, then description, inside each group", () => {
    expect(rankSlashMenu(items, "compact").map((entry) => [entry.item.label, entry.strength])).toEqual([
      ["compact", "exact"],
      ["compact-history", "prefix"],
      ["git-compact", "word"],
      ["recompact", "contains"],
    ]);
    expect(rankSlashMenu(items, "pull").map((entry) => [entry.item.label, entry.strength])).toEqual([
      ["review", "description"],
    ]);
  });

  it("keeps 「Agent 命令」 before 「技能」 whatever the match", () => {
    expect(rankSlashMenu(items, "pr").map((entry) => [entry.item.group, entry.item.label, entry.strength])).toEqual([
      ["agent", "pr-comments", "prefix"],
      ["agent", "review", "description"],
      ["skill", "pr", "exact"],
    ]);
  });

  it("ignores case and a typed `/` or `$`, and shows everything for an empty query", () => {
    expect(rankSlashMenu(items, "/COMPACT")[0]?.item.label).toBe("compact");
    expect(rankSlashMenu([item("x", { invocation: "$deploy" })], "$dep")[0]?.strength).toBe("prefix");
    expect(rankSlashMenu(items, "").every((entry) => entry.strength === null)).toBe(true);
    expect(rankSlashMenu(items, "")).toHaveLength(items.length);
  });
});

describe("defaultSlashSelection", () => {
  it("picks the first exact match, else the first prefix match, else nothing", () => {
    const items = [item("compact-history"), item("compact"), item("recompact")];
    expect(defaultSlashSelection(rankSlashMenu(items, "compact"))).toBe(0);
    expect(rankSlashMenu(items, "compact")[0]?.item.label).toBe("compact");
    expect(defaultSlashSelection(rankSlashMenu(items, "comp"))).toBe(0);
    expect(defaultSlashSelection(rankSlashMenu(items, "pact"))).toBe(-1);
    expect(defaultSlashSelection(rankSlashMenu(items, ""))).toBe(-1);
  });
});

describe("message checks", () => {
  it("names a command Remi will not run for the provider", () => {
    expect(blockedSlashCommand("claude", "/model opus")).toBe("model");
    expect(blockedSlashCommand("claude", "  /Clear")).toBe("clear");
    expect(blockedSlashCommand("codex", "/model")).toBeNull();
    expect(blockedSlashCommand("codex", "/status")).toBe("status");
    expect(blockedSlashCommand("claude", "/compact")).toBeNull();
    expect(blockedSlashCommand("claude", "please /model")).toBeNull();
  });

  it("knows a message that starts with a command", () => {
    expect(startsWithSlashCommand("/compact")).toBe(true);
    expect(startsWithSlashCommand("\n/review now")).toBe(true);
    expect(startsWithSlashCommand("hello /compact")).toBe(false);
    expect(startsWithSlashCommand("/")).toBe(false);
    expect(startsWithSlashCommand("$deploy")).toBe(false);
  });
});
