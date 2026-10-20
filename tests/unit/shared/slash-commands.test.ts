/**
 * Slash commands in a turn's input (ADR 0025): parsing as the bridges read a
 * prompt, the per-provider block and hide lists, the note that keeps a blocked
 * command from running, and skill command names.
 */
import { describe, expect, it } from "bun:test";
import {
  BLOCKED_SLASH_COMMANDS,
  blockedSlashCommandNote,
  COMPACT_COMMAND_REPLY,
  guardBlockedSlashCommand,
  HIDDEN_SLASH_COMMANDS,
  isCompactCommand,
  leadingSlashCommand,
  skillCommandName,
  slashCommandHandling,
  type SlashCommandProvider,
} from "@multiremi/contracts/slash-commands.js";

const PROVIDERS: SlashCommandProvider[] = ["claude", "codex", "antigravity"];

/**
 * Whether a bridge would read a command at the start of `text`: codex-acp trims
 * the first text block and needs `/` first (dist/index.js 38864-38877);
 * claude-agent-acp trims for `/remote-control` (dist/acp-agent.js 191-202) and
 * Claude Code runs a leading `/name`. The most lenient reading is the test.
 */
function bridgeReadsCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("/") && trimmed.slice(1).trim().length > 0;
}

describe("leadingSlashCommand", () => {
  it("reads the name and the rest the way codex-acp does", () => {
    expect(leadingSlashCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(leadingSlashCommand("/review focus on tests")).toEqual({ name: "review", args: "focus on tests" });
    expect(leadingSlashCommand("/compact\n\nkeep the test output")).toEqual({ name: "compact", args: "keep the test output" });
    expect(leadingSlashCommand("  \n\t/LOGOUT  ")).toEqual({ name: "logout", args: "" });
    expect(leadingSlashCommand("/ logout")).toEqual({ name: "logout", args: "" });
    expect(leadingSlashCommand("　/status")).toEqual({ name: "status", args: "" });
    expect(leadingSlashCommand("/mcp:server:prompt arg")).toEqual({ name: "mcp:server:prompt", args: "arg" });
    expect(leadingSlashCommand("/$deploy-prod api")).toEqual({ name: "$deploy-prod", args: "api" });
  });

  it("finds nothing unless the text starts with a named command", () => {
    for (const text of ["", "/", "  /  ", "hello /compact", "[Alice] /logout", "$deploy-prod", "path/to/file"]) {
      expect(leadingSlashCommand(text)).toBeNull();
    }
  });
});

describe("block and hide lists", () => {
  it("block what the hosted bridges must not run", () => {
    expect(BLOCKED_SLASH_COMMANDS.codex).toEqual(["logout", "status"]);
    expect(BLOCKED_SLASH_COMMANDS.antigravity).toEqual(["logout", "usage"]);
    for (const name of ["remote-control", "login", "logout", "model", "effort", "fast", "config", "output-style",
      "autocompact", "auto-mode-setup", "clear", "usage",
      // Claude Code aliases of blocked commands.
      "rc", "settings", "reset", "new", "cost", "stats"]) {
      expect(BLOCKED_SLASH_COMMANDS.claude).toContain(name);
    }
  });

  it("never both block and hide a command, and keep names in lower case without a slash", () => {
    for (const provider of PROVIDERS) {
      const blocked = new Set(BLOCKED_SLASH_COMMANDS[provider]);
      for (const name of HIDDEN_SLASH_COMMANDS[provider]) expect(blocked.has(name)).toBe(false);
      for (const name of [...BLOCKED_SLASH_COMMANDS[provider], ...HIDDEN_SLASH_COMMANDS[provider]]) {
        expect(name).toBe(name.toLowerCase());
        expect(name).not.toMatch(/^[/$]|\s/);
      }
    }
  });

  it("decide per provider, with or without the slash, in any case", () => {
    expect(slashCommandHandling("codex", "/status")).toBe("block");
    expect(slashCommandHandling("claude", "status")).toBeNull();
    expect(slashCommandHandling("claude", "/Model")).toBe("block");
    expect(slashCommandHandling("codex", "model")).toBeNull();
    expect(slashCommandHandling("codex", "plan")).toBe("hide");
    expect(slashCommandHandling("claude", "rename")).toBe("hide");
    expect(slashCommandHandling("claude", "compact")).toBeNull();
    expect(slashCommandHandling("codex", "review")).toBeNull();
    // A `$` name is a skill mention, which no bridge runs as a command.
    expect(slashCommandHandling("codex", "$logout")).toBeNull();
  });

  it("give an unknown provider every list", () => {
    for (const name of new Set(PROVIDERS.flatMap((provider) => BLOCKED_SLASH_COMMANDS[provider]))) {
      expect(slashCommandHandling(undefined, name)).toBe("block");
      expect(slashCommandHandling("opencode", name)).toBe("block");
    }
    expect(slashCommandHandling(null, "plan")).toBe("hide");
  });
});

describe("guardBlockedSlashCommand", () => {
  for (const provider of PROVIDERS) {
    for (const name of BLOCKED_SLASH_COMMANDS[provider]) {
      it(`puts the note in front of ${provider} /${name}, so no bridge reads a command at the start`, () => {
        for (const typed of [`/${name}`, `/${name} some args`, `  \n/${name.toUpperCase()}\nmore`, `/ ${name}`, `\t/${name}`]) {
          expect(bridgeReadsCommand(typed)).toBe(true);
          const sent = guardBlockedSlashCommand(provider, typed);
          expect(sent).toBe(`${blockedSlashCommandNote(name)}\n\n${typed}`);
          expect(sent.startsWith("[Remi] ")).toBe(true);
          expect(bridgeReadsCommand(sent)).toBe(false);
          // Applying it again changes nothing.
          expect(guardBlockedSlashCommand(provider, sent)).toBe(sent);
        }
      });
    }
  }

  it("leaves allowed commands, skill mentions, hidden commands and mid-text commands alone", () => {
    for (const [provider, text] of [
      ["claude", "/compact"], ["codex", "/compact keep it short"], ["claude", "/review"], ["codex", "/review-branch main"],
      ["codex", "/$deploy-prod api"], ["codex", "$logout"], ["claude", "/$logout"], ["claude", "/status"],
      ["codex", "/plan"], ["claude", "/rename foo"], ["antigravity", "/plan"],
      ["codex", "[Alice] /logout"], ["claude", "please run /model opus"], ["codex", "hello"],
    ] as const) {
      expect(guardBlockedSlashCommand(provider, text)).toBe(text);
    }
  });

  it("says the command did not run, in one short line", () => {
    const note = blockedSlashCommandNote("logout");
    expect(note).toBe("[Remi] The user typed the command /logout, which Remi does not run here. It reached you as text and did not run.");
    expect(note).not.toContain("\n");
  });
});

describe("isCompactCommand", () => {
  it("recognises /compact with or without instructions, and nothing else", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("/compact\n\nkeep the test output")).toBe(true);
    expect(isCompactCommand(" /COMPACT")).toBe(true);
    for (const text of ["/compactor", "compact", "please /compact", "[Alice] /compact", "/context", ""]) {
      expect(isCompactCommand(text)).toBe(false);
    }
    expect(COMPACT_COMMAND_REPLY).toBe("Context compacted.");
  });
});

describe("skillCommandName", () => {
  /** The directory name Remi used before ADR 0025; ASCII names keep their directories. */
  const before = (value: string) =>
    String(value || "skill").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "skill";

  it("keeps the directory name of every ASCII skill", () => {
    for (const name of ["Deploy Runbook", "Review", "git-commit", "  Git Commit  ", "v1.2 release", "..hidden", "--x--",
      "Deploy (prod)!", "snake_case", "", "   ", "a/b\\c"]) {
      expect(skillCommandName(name)).toBe(before(name));
    }
  });

  it("gives a name with other letters a stable short hash, so two of them never share a directory", () => {
    const review = skillCommandName("代码审查");
    const deploy = skillCommandName("部署");
    expect(review).toMatch(/^skill-[0-9a-f]{6}$/);
    expect(deploy).toMatch(/^skill-[0-9a-f]{6}$/);
    expect(review).not.toBe(deploy);
    expect(skillCommandName("代码审查")).toBe(review);
    expect(skillCommandName("PR 审查")).toMatch(/^pr-[0-9a-f]{6}$/);
  });

  it("is always a directory the skill manifest accepts and a command a `/` can carry", () => {
    for (const name of ["Deploy Runbook", "代码审查", "", ".", "..", "-", "Ünïcode Ñame", "a".repeat(80)]) {
      const command = skillCommandName(name);
      expect(command).toMatch(/^[a-z0-9_][a-z0-9._-]*$/);
      expect(bridgeReadsCommand(`/${command} args`)).toBe(true);
      expect(leadingSlashCommand(`/${command} args`)?.name).toBe(command);
    }
  });
});
