// Ported from OpenAI Codex `codex-rs/shell-command/src/parse_command.rs`
// (https://github.com/openai/codex), Copyright 2025 OpenAI, licensed under the
// Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations.
//
// The word splitting and quoting rules follow the `shlex` crate
// (https://github.com/comex/rust-shlex), Copyright 2015 Nicholas Allegra
// (comex), licensed under the Apache License, Version 2.0 or the MIT license.
//
// Modified: translated to TypeScript and narrowed to the bash/zsh/sh subset the
// trace translator needs. PowerShell handling is not ported. Codex parses
// `bash -lc` scripts with tree-sitter and keeps only "word-only" command
// sequences; tree-sitter is replaced here by a small scanner that accepts the
// same subset (words, quotes, `&&` `||` `|` `;` and newlines) and returns null
// for anything else (`$`, backticks, redirections, heredocs, subshells, braces,
// comments, assignments, background `&`, unbalanced quotes), which makes the
// whole command a single `unknown` action, as Codex does when tree-sitter
// rejects a script. Results use the trace contract's `CommandAction` shape
// instead of Codex's `ParsedCommand`.

import type { CommandAction } from "@multiremi/contracts/trace";

type Tokens = readonly string[];

const CONNECTORS: ReadonlySet<string> = new Set(["&&", "||", "|", ";"]);
const SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "sh"]);

/**
 * Parse a shell command into display actions (read, list files, search,
 * unknown), the TypeScript port of Codex `parse_command`.
 *
 * - A string is a shell script, as the Bash tool and the Codex shell run it. A
 *   string that is itself `bash|zsh|sh -c|-lc '<script>'` is unwrapped once.
 * - An array is an argv, parsed exactly as Codex parses its exec argv.
 *
 * If any part is unknown, the result is one `unknown` action for the whole
 * command. `cwd`, when given, resolves relative `read` paths.
 */
export function parseCommand(command: string | Tokens, cwd?: string | null): CommandAction[] {
  let parsed: CommandAction[];
  let whole: string;
  if (typeof command === "string") {
    whole = unwrapShellString(command);
    parsed = parseShellScript(whole);
  } else {
    const script = extractShellScript(command);
    whole = script ?? shlexJoin(command);
    parsed = script !== null ? parseShellScript(script) : parseArgv(command);
  }
  const deduped: CommandAction[] = [];
  for (const action of parsed) {
    const previous = deduped[deduped.length - 1];
    if (previous && sameAction(previous, action)) continue;
    deduped.push(action);
  }
  const actions: CommandAction[] = deduped.some((action) => action.type === "unknown")
    ? [{ type: "unknown", command: whole }]
    : deduped;
  if (!cwd) return actions;
  return actions.map((action) => action.type === "read" ? { ...action, path: joinPaths(cwd, action.path) } : action);
}

/**
 * Shorten a path to the last component, excluding `build`/`dist`/`node_modules`/`src`.
 * It also pulls out a useful path from a directory such as:
 * - webview/src -> webview
 * - foo/src/ -> foo
 * - packages/app/node_modules/ -> app
 */
export function shortDisplayPath(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = trimmed.split("/").reverse()
    .filter((part) => part !== "" && part !== "build" && part !== "dist" && part !== "node_modules" && part !== "src");
  return parts[0] ?? trimmed;
}

/**
 * Return true if this looks like a small formatting helper in a pipeline.
 * Examples: `head -n 40`, `tail -n +10`, `wc -l`, `awk ...`, `cut ...`, `tr ...`.
 * We try to keep variants that clearly include a file path (e.g. `tail -n 30 file`).
 * Exported for the ported unit tests.
 */
export function isSmallFormattingCommand(tokens: Tokens): boolean {
  const cmd = tokens[0];
  if (cmd === undefined) return false;
  switch (cmd) {
    // Always formatting; typically used in pipes. `nl` is special-cased in
    // summarize so `nl <file>` is treated as a read.
    case "wc": case "tr": case "cut": case "sort": case "uniq": case "tee": case "column": case "yes": case "printf":
      return true;
    case "xargs":
      return !isMutatingXargsCommand(tokens);
    case "awk":
      return awkDataFileOperand(tokens.slice(1)) === null;
    case "head": {
      // Formatting when no explicit file operand is present: `head`, `head -n50`, `head -n 40`.
      if (tokens.length === 1) return true;
      if (tokens.length === 2) return tokens[1]!.startsWith("-");
      if (tokens.length === 3) {
        const [, flag, count] = tokens;
        return (flag === "-n" || flag === "-c") && allDigits(count!);
      }
      return false;
    }
    case "tail": {
      // Formatting when no explicit file operand is present: `tail -n +10`, `tail -c 100`.
      if (tokens.length === 1) return true;
      if (tokens.length === 2) return tokens[1]!.startsWith("-");
      if (tokens.length === 3) {
        const [, flag, count] = tokens;
        return (flag === "-n" || flag === "-c")
          && (allDigits(count!) || (count!.startsWith("+") && allDigits(count!.slice(1))));
      }
      return false;
    }
    case "sed": {
      // Keep `sed -n <range> file` (a read) and in-place edits (unknown);
      // otherwise sed is a formatting helper in a pipeline.
      const args = tokens.slice(1);
      return !sedHasInPlaceFlag(args) && sedReadPath(args) === null;
    }
    default:
      return false;
  }
}

// ── Shell layer ─────────────────────────────────────────────────────────────

/** `[bash|zsh|sh (any path), -c|-lc, script]` -> script (Codex `extract_bash_command`). */
function extractShellScript(command: Tokens): string | null {
  if (command.length !== 3) return null;
  const [shell, flag, script] = command as [string, string, string];
  if (flag !== "-c" && flag !== "-lc") return null;
  const base = (shell.split(/[\\/]/).pop() ?? shell).replace(/\.exe$/i, "");
  return SHELLS.has(base) ? script : null;
}

function unwrapShellString(script: string): string {
  const commands = splitWordOnlyScript(script);
  if (commands?.length !== 1) return script;
  return extractShellScript(commands[0]!) ?? script;
}

/** Codex `parse_shell_script`: the `bash -lc` path. */
function parseShellScript(script: string): CommandAction[] {
  const allCommands = splitWordOnlyScript(script);
  if (!allCommands || allCommands.length === 0) return [{ type: "unknown", command: script }];
  const scriptTokens = shlexSplit(script) ?? [script];
  const hadMultipleCommands = allCommands.length > 1;
  // Drop small formatting helpers so pipelines summarize the primary command.
  const filtered = allCommands.filter((tokens) => !isSmallFormattingCommand(tokens));
  if (filtered.length === 0) return [{ type: "unknown", command: script }];

  let commands = summarizeWithCd(filtered);
  if (commands.length > 1) {
    commands = commands.filter((action) => !(action.type === "unknown" && action.command === "true"));
    commands = simplify(commands);
  }
  if (commands.length === 1) {
    // A single remaining command is attributed the full script for reads and
    // listings without connectors; pipelines keep only the primary command,
    // except `... | sed -n`, which keeps the whole script.
    const hadConnectors = hadMultipleCommands || scriptTokens.some((token) => CONNECTORS.has(token));
    const joined = shlexJoin(scriptTokens);
    commands = commands.map((action) => {
      switch (action.type) {
        case "read": {
          if (!hadConnectors) return { ...action, command: joined };
          const hasPipe = scriptTokens.includes("|");
          const hasSedN = scriptTokens.some((token, i) => token === "sed" && scriptTokens[i + 1] === "-n");
          return hasPipe && hasSedN ? { ...action, command: script } : action;
        }
        case "list_files":
        case "search":
          return hadConnectors ? action : { ...action, command: joined };
        default:
          return action;
      }
    });
  }
  return commands;
}

/** Codex `parse_command_impl` for an argv that is not a shell wrapper. */
function parseArgv(command: Tokens): CommandAction[] {
  const normalized = normalizeTokens(command);
  const parts = normalized.some((token) => CONNECTORS.has(token)) ? splitOnConnectors(normalized) : [normalized];
  return simplify(summarizeWithCd(parts));
}

/** Summarize each command, tracking `cd` to compute effective read paths. */
function summarizeWithCd(parts: readonly Tokens[]): CommandAction[] {
  const commands: CommandAction[] = [];
  let cwd: string | null = null;
  for (const tokens of parts) {
    if (tokens[0] === "cd") {
      const dir = cdTarget(tokens.slice(1));
      if (dir !== null) cwd = cwd === null ? dir : joinPaths(cwd, dir);
      continue;
    }
    const parsed = summarizeMainTokens(tokens);
    commands.push(parsed.type === "read" && cwd !== null ? { ...parsed, path: joinPaths(cwd, parsed.path) } : parsed);
  }
  return commands;
}

function simplify(commands: CommandAction[]): CommandAction[] {
  let current = commands;
  for (let next = simplifyOnce(current); next; next = simplifyOnce(current)) current = next;
  return current;
}

function simplifyOnce(commands: readonly CommandAction[]): CommandAction[] | null {
  if (commands.length <= 1) return null;
  const firstToken = (action: CommandAction): string | undefined =>
    action.type === "unknown" ? shlexSplit(action.command)?.[0] : undefined;
  const without = (index: number) => [...commands.slice(0, index), ...commands.slice(index + 1)];

  // echo ... && ...rest => ...rest
  if (firstToken(commands[0]!) === "echo") return commands.slice(1);
  // cd foo && [any command] => [any command]
  const cd = commands.findIndex((action) => firstToken(action) === "cd");
  if (cd >= 0 && commands.length > cd + 1) return without(cd);
  // cmd || true => cmd
  const truthy = commands.findIndex((action) => action.type === "unknown" && action.command === "true");
  if (truthy >= 0) return without(truthy);
  // nl -[any_flags] && ...rest => ...rest
  const nl = commands.findIndex((action) => {
    if (action.type !== "unknown") return false;
    const tokens = shlexSplit(action.command);
    return !!tokens && tokens[0] === "nl" && tokens.slice(1).every((token) => token.startsWith("-"));
  });
  if (nl >= 0) return without(nl);
  return null;
}

/** Drop a leading `yes |` / `no |`. */
function normalizeTokens(command: Tokens): Tokens {
  const [first, pipe] = command;
  if (pipe === "|" && (first === "yes" || first === "y" || first === "no" || first === "n")) return command.slice(2);
  return command;
}

function splitOnConnectors(tokens: Tokens): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (CONNECTORS.has(token)) {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length) out.push(current);
  return out;
}

function trimAtConnector(tokens: Tokens): Tokens {
  const index = tokens.findIndex((token) => CONNECTORS.has(token));
  return index < 0 ? tokens : tokens.slice(0, index);
}

// ── Summaries ───────────────────────────────────────────────────────────────

function unknown(main: Tokens): CommandAction {
  return { type: "unknown", command: shlexJoin(main) };
}

function read(main: Tokens, path: string): CommandAction {
  return { type: "read", command: shlexJoin(main), name: shortDisplayPath(path), path };
}

function listFiles(main: Tokens, path: string | null): CommandAction {
  return { type: "list_files", command: shlexJoin(main), path };
}

function search(main: Tokens, query: string | null, path: string | null): CommandAction {
  return { type: "search", command: shlexJoin(main), query, path };
}

function shortOrNull(path: string | null | undefined): string | null {
  return path === null || path === undefined ? null : shortDisplayPath(path);
}

const LS_FLAGS = ["-I", "-w", "--block-size", "--format", "--time-style", "--color", "--quoting-style"];
const EZA_FLAGS = ["-I", "--ignore-glob", "--color", "--sort", "--time-style", "--time"];
const TREE_FLAGS = ["-L", "-P", "-I", "--charset", "--filelimit", "--sort"];
const DU_FLAGS = ["-d", "--max-depth", "-B", "--block-size", "--exclude", "--time-style"];
const RG_FLAGS = ["-g", "--glob", "--iglob", "-t", "--type", "--type-add", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context", "--max-depth"];
const AG_FLAGS = ["-G", "-g", "--file-search-regex", "--ignore-dir", "--ignore-file", "--path-to-ignore"];
const BAT_FLAGS = ["--theme", "--language", "--style", "--terminal-width", "--tabs", "--line-range", "--map-syntax"];
const LESS_FLAGS = ["-p", "-P", "-x", "-y", "-z", "-j", "--pattern", "--prompt", "--tabs", "--shift", "--jump-target"];
const GREP_VALUE_FLAGS = ["-m", "--max-count", "-C", "--context", "-A", "--after-context", "-B", "--before-context"];

function summarizeMainTokens(main: Tokens): CommandAction {
  const head = main[0];
  const tail = main.slice(1);
  switch (head) {
    case "ls": case "eza": case "exa":
      return listFiles(main, shortOrNull(firstNonFlagOperand(tail, head === "ls" ? LS_FLAGS : EZA_FLAGS)));
    case "tree":
      return listFiles(main, shortOrNull(firstNonFlagOperand(tail, TREE_FLAGS)));
    case "du":
      return listFiles(main, shortOrNull(firstNonFlagOperand(tail, DU_FLAGS)));
    case "rg": case "rga": case "ripgrep-all": {
      const args = trimAtConnector(tail);
      const nonFlags = skipFlagValues(args, RG_FLAGS).filter((arg) => !arg.startsWith("-"));
      if (args.includes("--files")) return listFiles(main, shortOrNull(nonFlags[0]));
      return search(main, nonFlags[0] ?? null, shortOrNull(nonFlags[1]));
    }
    case "git": {
      const [sub, ...subTail] = tail;
      if (sub === "grep") return parseGrepLike(main, subTail);
      if (sub === "ls-files") {
        return listFiles(main, shortOrNull(firstNonFlagOperand(subTail, ["--exclude", "--exclude-from", "--pathspec-from-file"])));
      }
      return unknown(main);
    }
    case "fd": {
      const [query, path] = parseFdQueryAndPath(tail);
      return query !== null ? search(main, query, path) : listFiles(main, path);
    }
    case "find": {
      const [query, path] = parseFindQueryAndPath(tail);
      return query !== null ? search(main, query, path) : listFiles(main, path);
    }
    case "grep": case "egrep": case "fgrep":
      return parseGrepLike(main, tail);
    case "ag": case "ack": case "pt": {
      const nonFlags = skipFlagValues(trimAtConnector(tail), AG_FLAGS).filter((arg) => !arg.startsWith("-"));
      return search(main, nonFlags[0] ?? null, shortOrNull(nonFlags[1]));
    }
    case "cat": case "more":
      return readOrUnknown(main, singleNonFlagOperand(tail, []));
    case "bat": case "batcat":
      return readOrUnknown(main, singleNonFlagOperand(tail, BAT_FLAGS));
    case "less":
      return readOrUnknown(main, singleNonFlagOperand(tail, LESS_FLAGS));
    case "head":
      return summarizeHeadTail(main, tail, false);
    case "tail":
      return summarizeHeadTail(main, tail, true);
    case "awk":
      return readOrUnknown(main, awkDataFileOperand(tail));
    case "nl":
      // Avoid treating option values as paths (e.g., nl -s "  ").
      return readOrUnknown(main, skipFlagValues(tail, ["-s", "-w", "-v", "-i", "-b"]).find((arg) => !arg.startsWith("-")) ?? null);
    case "sed":
      return readOrUnknown(main, sedReadPath(tail));
    default:
      if (head !== undefined && isPythonCommand(head)) {
        return pythonWalksFiles(tail) ? listFiles(main, null) : unknown(main);
      }
      return unknown(main);
  }
}

function readOrUnknown(main: Tokens, path: string | null): CommandAction {
  return path !== null ? read(main, path) : unknown(main);
}

/** `head -n 50 file`, `head -n50 file`, `tail -n +10 file`, `head file`. */
function summarizeHeadTail(main: Tokens, tail: Tokens, allowPlus: boolean): CommandAction {
  const validCount = (value: string): boolean => {
    if (!allowPlus) return allDigits(value);
    const digits = value.startsWith("+") ? value.slice(1) : value;
    return digits !== "" && allDigits(digits);
  };
  const [first, second] = tail;
  const separateCount = first === "-n" && second !== undefined && validCount(second);
  const hasValidN = first === "-n" ? separateCount : first !== undefined && first.startsWith("-n") && validCount(first.slice(2));
  if (hasValidN) {
    // Skip the count consumed by a separate `-n`.
    const path = (separateCount ? tail.slice(2) : tail).find((arg) => !arg.startsWith("-"));
    if (path !== undefined) return read(main, path);
  }
  if (tail.length === 1 && !first!.startsWith("-")) return read(main, first!);
  return unknown(main);
}

function parseGrepLike(main: Tokens, args: Tokens): CommandAction {
  const tokens = trimAtConnector(args);
  const operands: string[] = [];
  let pattern: string | null = null;
  let afterDoubleDash = false;
  for (let i = 0; i < tokens.length; i++) {
    const arg = tokens[i]!;
    if (afterDoubleDash) { operands.push(arg); continue; }
    if (arg === "--") { afterDoubleDash = true; continue; }
    if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") {
      const value = tokens[++i];
      if (value !== undefined && pattern === null) pattern = value;
      continue;
    }
    if (GREP_VALUE_FLAGS.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    operands.push(arg);
  }
  // Do not shorten the query: grep patterns may legitimately contain slashes.
  const hasPattern = pattern !== null;
  const query = pattern ?? operands[0] ?? null;
  return search(main, query, shortOrNull(operands[hasPattern ? 0 : 1]));
}

function awkDataFileOperand(args: Tokens): string | null {
  if (args.length === 0) return null;
  const tokens = trimAtConnector(args);
  const hasScriptFile = tokens.some((arg) => arg === "-f" || arg === "--file");
  const nonFlags = skipFlagValues(tokens, ["-F", "-v", "-f", "--field-separator", "--assign", "--file"])
    .filter((arg) => !arg.startsWith("-"));
  if (hasScriptFile) return nonFlags[0] ?? null;
  return nonFlags[1] ?? null;
}

function pythonWalksFiles(args: Tokens): boolean {
  const tokens = trimAtConnector(args);
  const index = tokens.indexOf("-c");
  const script = index >= 0 ? tokens[index + 1] : undefined;
  if (script === undefined) return false;
  return ["os.walk", "os.listdir", "os.scandir", "glob.glob", "glob.iglob", "pathlib.Path", ".rglob("]
    .some((needle) => script.includes(needle));
}

function isPythonCommand(cmd: string): boolean {
  return cmd === "python" || cmd === "python2" || cmd === "python3" || cmd.startsWith("python2.") || cmd.startsWith("python3.");
}

function cdTarget(args: Tokens): string | null {
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1] ?? null;
    if (arg.startsWith("-")) continue;
    target = arg;
  }
  return target;
}

/** Whether a command token has an explicit path shape. */
function isPathish(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../")
    || value.includes("/") || value.includes("\\");
}

function parseFdQueryAndPath(tail: Tokens): [string | null, string | null] {
  // fd flags that take values (e.g., -t/--type, -e/--extension).
  const nonFlags = skipFlagValues(trimAtConnector(tail), ["-t", "--type", "-e", "--extension", "-E", "--exclude", "--search-path"])
    .filter((arg) => !arg.startsWith("-"));
  const [first, second] = nonFlags;
  if (first === undefined) return [null, null];
  if (second === undefined) return isPathish(first) ? [null, shortDisplayPath(first)] : [first, null];
  return [first, shortDisplayPath(second)];
}

function parseFindQueryAndPath(tail: Tokens): [string | null, string | null] {
  const tokens = trimAtConnector(tail);
  // First positional argument (excluding common unary operators) is the root path.
  const root = tokens.find((arg) => !arg.startsWith("-") && arg !== "!" && arg !== "(" && arg !== ")");
  // A common name/path/regex pattern, if present.
  const index = tokens.findIndex((arg) => arg === "-name" || arg === "-iname" || arg === "-path" || arg === "-regex");
  const query = index >= 0 ? tokens[index + 1] ?? null : null;
  return [query, shortOrNull(root)];
}

/** `sed -n 123p` / `sed -n 12,20p`. */
function isValidSedNArg(arg: string | undefined): boolean {
  if (arg === undefined || !arg.endsWith("p")) return false;
  const parts = arg.slice(0, -1).split(",");
  return parts.length <= 2 && parts.every((part) => part !== "" && allDigits(part));
}

function sedReadPath(args: Tokens): string | null {
  const tokens = trimAtConnector(args);
  if (sedHasInPlaceFlag(tokens) || !tokens.includes("-n")) return null;
  let hasRangeScript = false;
  for (let i = 0; i < tokens.length; i++) {
    const arg = tokens[i]!;
    if (arg === "-e" || arg === "--expression") {
      if (isValidSedNArg(tokens[i + 1])) hasRangeScript = true;
      i++;
    } else if (arg === "-f" || arg === "--file") {
      i++;
    }
  }
  if (!hasRangeScript) hasRangeScript = tokens.some((arg) => !arg.startsWith("-") && isValidSedNArg(arg));
  if (!hasRangeScript) return null;
  const [first, second] = skipFlagValues(tokens, ["-e", "-f", "--expression", "--file"]).filter((arg) => !arg.startsWith("-"));
  if (first === undefined) return null;
  return isValidSedNArg(first) ? second ?? null : first;
}

function sedHasInPlaceFlag(tokens: Tokens): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") break;
    if (token === "-e" || token === "-f" || token === "--expression" || token === "--file") { i++; continue; }
    if (token === "--in-place" || token.startsWith("--in-place=")) return true;
    if (token.startsWith("--") || !token.startsWith("-")) continue;
    const shortOptions = token.slice(1);
    for (let index = 0; index < shortOptions.length; index++) {
      const option = shortOptions[index];
      if (option === "i") return true;
      if (option === "e" || option === "f") {
        if (index + 1 === shortOptions.length) i++;
        break;
      }
    }
  }
  return false;
}

function isMutatingXargsCommand(tokens: Tokens): boolean {
  const sub = xargsSubcommand(tokens);
  return sub !== null && xargsIsMutatingSubcommand(sub);
}

function xargsSubcommand(tokens: Tokens): Tokens | null {
  if (tokens[0] !== "xargs") return null;
  for (let i = 1; i < tokens.length;) {
    const token = tokens[i]!;
    if (token === "--") return i + 1 < tokens.length ? tokens.slice(i + 1) : null;
    if (!token.startsWith("-")) return tokens.slice(i);
    const takesValue = ["-E", "-e", "-I", "-L", "-n", "-P", "-s"].includes(token);
    i += takesValue && token.length === 2 ? 2 : 1;
  }
  return null;
}

function xargsIsMutatingSubcommand(tokens: Tokens): boolean {
  const [head, ...tail] = tokens;
  switch (head) {
    case "perl": case "ruby": return hasInPlaceFlag(tail);
    case "sed": return sedHasInPlaceFlag(tail);
    case "rg": return tail.includes("--replace");
    default: return false;
  }
}

function hasInPlaceFlag(tokens: Tokens): boolean {
  return tokens.some((token) => token.startsWith("-i") || token.startsWith("-pi")
    || token === "--in-place" || token.startsWith("--in-place="));
}

// Skip values consumed by specific flags and ignore --flag=value style arguments.
function skipFlagValues(args: Tokens, flagsWithValues: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      // From here on, everything is a positional operand.
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (flagsWithValues.includes(arg)) {
      if (i + 1 < args.length) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function positionalOperands(args: Tokens, flagsWithValues: readonly string[]): string[] {
  const out: string[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (afterDoubleDash) { out.push(arg); continue; }
    if (arg === "--") { afterDoubleDash = true; continue; }
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (flagsWithValues.includes(arg)) {
      if (i + 1 < args.length) i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    out.push(arg);
  }
  return out;
}

function firstNonFlagOperand(args: Tokens, flagsWithValues: readonly string[]): string | null {
  return positionalOperands(args, flagsWithValues)[0] ?? null;
}

function singleNonFlagOperand(args: Tokens, flagsWithValues: readonly string[]): string | null {
  const operands = positionalOperands(args, flagsWithValues);
  return operands.length === 1 ? operands[0]! : null;
}

function allDigits(value: string): boolean {
  return /^[0-9]*$/.test(value);
}

function isAbsLike(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\\/.test(path) || path.startsWith("\\\\");
}

function joinPaths(base: string, rel: string): string {
  if (isAbsLike(rel) || base === "") return rel;
  return base.endsWith("/") ? base + rel : `${base}/${rel}`;
}

function sameAction(a: CommandAction, b: CommandAction): boolean {
  if (a.type !== b.type || a.command !== b.command) return false;
  switch (a.type) {
    case "read": return b.type === "read" && a.name === b.name && a.path === b.path;
    case "list_files": return b.type === "list_files" && a.path === b.path;
    case "search": return b.type === "search" && a.query === b.query && a.path === b.path;
    default: return true;
  }
}

// ── Scanner (stands in for Codex's tree-sitter word-only sequence) ──────────

/**
 * Split a script into its commands when it only contains plain words joined by
 * `&&`, `||`, `|`, `;` or newlines. Quotes are honoured; any other shell syntax
 * returns null, as Codex's `try_parse_word_only_commands_sequence` does.
 */
function splitWordOnlyScript(script: string): string[][] | null {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let raw = "";
  let inWord = false;
  let awaitingRight = false;

  const endWord = (): boolean => {
    if (!inWord) return true;
    // `NAME=value` in command position is an assignment, not a word.
    if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) return false;
    words.push(word);
    word = "";
    raw = "";
    inWord = false;
    awaitingRight = false;
    return true;
  };
  const endCommand = (): boolean => {
    if (!endWord() || words.length === 0) return false;
    commands.push(words);
    words = [];
    return true;
  };

  for (let i = 0; i < script.length;) {
    const c = script[i]!;
    const next = script[i + 1];
    if (c === " " || c === "\t") {
      if (!endWord()) return null;
      i++;
    } else if (c === "\n") {
      if (!endWord()) return null;
      // Blank lines are fine, and a binary operator may continue on the next line.
      if (words.length) {
        commands.push(words);
        words = [];
      }
      i++;
    } else if (c === "\\") {
      if (next === undefined) return null;
      if (next !== "\n") {
        word += next;
        raw += c + next;
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) return null;
      word += script.slice(i + 1, end);
      raw += script.slice(i, end + 1);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      const quoted = readDoubleQuoted(script, i, false);
      if (!quoted) return null;
      word += quoted.value;
      raw += script.slice(i, quoted.end);
      inWord = true;
      i = quoted.end;
    } else if (c === "&" || c === "|") {
      // `&&`, `||` and `|` join commands; `&` (background), `&>` and `|&` do not.
      if (next !== c && (c === "&" || next === "&")) return null;
      if (!endCommand()) return null;
      awaitingRight = true;
      i += next === c ? 2 : 1;
    } else if (c === ";") {
      // `;;` and a `;` with no command before it are syntax errors.
      if (next === ";" || !endCommand()) return null;
      i++;
    } else if ("$`()<>{}".includes(c) || (c === "#" && !inWord)) {
      // Expansions, substitutions, subshells, redirections, heredocs, brace
      // groups and comments: not a word-only sequence.
      return null;
    } else {
      word += c;
      raw += c;
      inWord = true;
      i++;
    }
  }
  if (!endWord()) return null;
  if (words.length) commands.push(words);
  else if (awaitingRight) return null;
  return commands;
}

/**
 * Read a double-quoted string starting at `start` (the opening quote). In the
 * scanner (`allowExpansions` false) an unescaped `$` or backtick rejects the
 * script; `shlex` keeps them literally.
 */
function readDoubleQuoted(input: string, start: number, allowExpansions: boolean): { value: string; end: number } | null {
  let value = "";
  for (let j = start + 1; ;) {
    const ch = input[j];
    if (ch === undefined) return null;
    if (ch === '"') return { value, end: j + 1 };
    if (!allowExpansions && (ch === "$" || ch === "`")) return null;
    if (ch === "\\") {
      const escaped = input[j + 1];
      if (escaped === undefined) return null;
      if (escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") value += escaped;
      else if (escaped !== "\n") value += ch + escaped;
      j += 2;
      continue;
    }
    value += ch;
    j++;
  }
}

// ── shlex ───────────────────────────────────────────────────────────────────

/** POSIX-style split as the `shlex` crate does it; null on an unterminated quote or escape. */
export function shlexSplit(input: string): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < input.length;) {
    const c = input[i]!;
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c === "#") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    let word = "";
    while (i < input.length) {
      const ch = input[i]!;
      if (ch === " " || ch === "\t" || ch === "\n") break;
      if (ch === "'") {
        const end = input.indexOf("'", i + 1);
        if (end < 0) return null;
        word += input.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '"') {
        const quoted = readDoubleQuoted(input, i, true);
        if (!quoted) return null;
        word += quoted.value;
        i = quoted.end;
      } else if (ch === "\\") {
        const escaped = input[i + 1];
        if (escaped === undefined) return null;
        if (escaped !== "\n") word += escaped;
        i += 2;
      } else {
        word += ch;
        i++;
      }
    }
    out.push(word);
  }
  return out;
}

const UNQUOTED_OK = 1;
const SINGLE_QUOTED_OK = 2;
const DOUBLE_QUOTED_OK = 4;
const UNQUOTED_SAFE = /^[A-Za-z0-9+\-./:@\]_]$/;

/** The prefix one strategy can cover, and that strategy (`shlex` `quoting_strategy`). */
function quotingStrategy(input: string): [number, number] {
  let prevOk = SINGLE_QUOTED_OK | DOUBLE_QUOTED_OK | UNQUOTED_OK;
  let i = 0;
  // To work around a Bash bug, ^ is only allowed right after an opening single quote.
  if (input[0] === "^") {
    prevOk = SINGLE_QUOTED_OK;
    i = 1;
  }
  for (; i < input.length; i++) {
    const ch = input[i]!;
    let curOk = prevOk;
    // Non-ASCII always needs quotes.
    if (ch.charCodeAt(0) >= 0x80 || !UNQUOTED_SAFE.test(ch)) curOk &= ~UNQUOTED_OK;
    // Fish treats backslashes in single quotes as escapes; double quotes work everywhere.
    if (ch === "'" || ch === "^" || ch === "\\") curOk &= ~SINGLE_QUOTED_OK;
    if (ch === "`" || ch === "$" || ch === "!" || ch === "^") curOk &= ~DOUBLE_QUOTED_OK;
    if (curOk === 0) break;
    prevOk = curOk;
  }
  const strategy = prevOk & UNQUOTED_OK ? UNQUOTED_OK : prevOk & SINGLE_QUOTED_OK ? SINGLE_QUOTED_OK : DOUBLE_QUOTED_OK;
  return [i, strategy];
}

function shlexQuote(input: string): string {
  if (input === "") return "''";
  let out = "";
  let rest = input;
  while (rest.length) {
    const [length, strategy] = quotingStrategy(rest);
    if (length === rest.length && strategy === UNQUOTED_OK && out === "") return rest;
    const chunk = rest.slice(0, length);
    rest = rest.slice(length);
    if (strategy === UNQUOTED_OK) out += chunk;
    else if (strategy === SINGLE_QUOTED_OK) out += `'${chunk}'`;
    else out += `"${chunk.replace(/[$`"\\]/g, "\\$&")}"`;
  }
  return out;
}

/** Join argv for display, quoting each word as the `shlex` crate does. */
export function shlexJoin(tokens: Tokens): string {
  if (tokens.some((token) => token.includes("\0"))) return "<command included NUL byte>";
  return tokens.map(shlexQuote).join(" ");
}
