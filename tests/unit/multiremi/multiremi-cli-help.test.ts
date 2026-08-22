/**
 * Guards `showHelp` against drifting from the dispatcher (MUL-70).
 *
 * The help text is the first source of truth humans and agents use to decide
 * what the CLI can do — a command missing from it reads as "unsupported" even
 * when the dispatcher routes it fine. Rather than hard-coding the command
 * list twice, these tests parse the real dispatch sites (the top-level switch
 * in `multiremi.ts` and the `issue` subcommand usage string) and assert every
 * dispatched command is documented.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { showHelp } from "../../../apps/remi/cli/multiremi/help.js";

const cliDir = join(import.meta.dir, "../../../apps/remi/cli");

const realConsoleLog = console.log;

afterEach(() => {
  console.log = realConsoleLog;
});

function capturedHelpText(): string {
  const lines: string[] = [];
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };
  try {
    showHelp();
  } finally {
    console.log = realConsoleLog;
  }
  return lines.join("\n");
}

/** `case "x":` labels of the top-level command switch in runMultiremi. */
function topLevelDispatchCommands(): string[] {
  const source = readFileSync(join(cliDir, "multiremi.ts"), "utf8");
  const start = source.indexOf("switch (parsed.command)");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("default:", start));
  const commands = [...body.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);
  expect(commands.length).toBeGreaterThan(0);
  // Flag aliases (--help, -V, ...) are spellings of documented commands.
  return commands.filter((command) => !command.startsWith("-"));
}

/** Subcommand tokens from the `issue` handler's own usage error. */
function issueSubcommands(): string[] {
  const source = readFileSync(join(cliDir, "multiremi/commands/issue.ts"), "utf8");
  const match = /usage: multiremi issue ([a-z|-]+) \.\.\./.exec(source);
  expect(match).not.toBeNull();
  const subcommands = match![1].split("|").filter(Boolean);
  expect(subcommands.length).toBeGreaterThan(0);
  return subcommands;
}

/** The command column starts each Commands line at two spaces of indent. */
function documentsCommand(helpText: string, command: string): boolean {
  return new RegExp(`^ {2}${command}(?:\\s|$)`, "m").test(helpText);
}

describe("multiremi help/dispatcher alignment", () => {
  it("documents every top-level dispatcher command", () => {
    const helpText = capturedHelpText();
    const undocumented = topLevelDispatchCommands()
      .filter((command) => !documentsCommand(helpText, command));
    expect(undocumented).toEqual([]);
  });

  it("documents every issue subcommand", () => {
    const helpText = capturedHelpText();
    const undocumented = issueSubcommands()
      .filter((subcommand) => !documentsCommand(helpText, `issue ${subcommand}`));
    expect(undocumented).toEqual([]);
  });
});
