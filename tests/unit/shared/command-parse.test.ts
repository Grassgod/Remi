// Cases ported from the unit tests in OpenAI Codex
// `codex-rs/shell-command/src/parse_command.rs` (Apache-2.0), one `it` per Rust
// `#[test]`, with the Rust test name kept. `vec_str(&[...])` becomes an argv
// array, `shlex_split_safe(s)` becomes `argv(s)`, `ParsedCommand::Read { cmd, .. }`
// becomes `read(cmd, ..)` and so on.
//
// Not ported (PowerShell is out of scope for this port):
//   powershell_command_is_stripped, powershell_file_reads_are_classified,
//   complex_powershell_file_reads_are_intentionally_not_classified,
//   pwsh_with_noprofile_and_c_alias_is_stripped, powershell_with_path_is_stripped.
// No bash case depends on tree-sitter behaviour the scanner does not reproduce:
// every `bash -lc` case below passes through the scanner unchanged. The cases
// at the end cover what the scanner rejects instead of tree-sitter.

import { describe, expect, it } from "bun:test";
import type { CommandAction } from "@multiremi/contracts/trace";
import {
  isSmallFormattingCommand,
  parseCommand,
  shlexJoin,
  shlexSplit,
  shortDisplayPath,
} from "@shared/command-parse.js";

const argv = (s: string): string[] => shlexSplit(s) ?? s.split(/\s+/).filter(Boolean);
const read = (command: string, name: string, path: string): CommandAction => ({ type: "read", command, name, path });
const list = (command: string, path: string | null): CommandAction => ({ type: "list_files", command, path });
const search = (command: string, query: string | null, path: string | null): CommandAction =>
  ({ type: "search", command, query, path });
const unknown = (command: string): CommandAction => ({ type: "unknown", command });

function expectParsed(command: string | string[], expected: CommandAction[]): void {
  expect(parseCommand(command)).toEqual(expected);
}

describe("parseCommand: ported Codex cases", () => {
  it("git_status_is_unknown", () => {
    expectParsed(["git", "status"], [unknown("git status")]);
  });

  it("supports_git_grep_and_ls_files", () => {
    expectParsed(argv("git grep TODO src"), [search("git grep TODO src", "TODO", "src")]);
    expectParsed(argv("git grep -l TODO src"), [search("git grep -l TODO src", "TODO", "src")]);
    expectParsed(argv("git ls-files"), [list("git ls-files", null)]);
    expectParsed(argv("git ls-files src"), [list("git ls-files src", "src")]);
    expectParsed(argv("git ls-files --exclude target src"), [list("git ls-files --exclude target src", "src")]);
  });

  it("handles_git_pipe_wc", () => {
    const inner = "git status | wc -l";
    expectParsed(["bash", "-lc", inner], [unknown(inner)]);
  });

  it("bash_lc_redirect_not_quoted", () => {
    const inner = "echo foo > bar";
    expectParsed(["bash", "-lc", inner], [unknown("echo foo > bar")]);
  });

  it("handles_complex_bash_command_head", () => {
    const inner = "rg --version && node -v && pnpm -v && rg --files | wc -l && rg --files | head -n 40";
    expectParsed(["bash", "-lc", inner], [unknown(inner)]);
  });

  it("supports_searching_for_navigate_to_route", () => {
    const inner = 'rg -n "navigate-to-route" -S';
    expectParsed(["bash", "-lc", inner], [search("rg -n navigate-to-route -S", "navigate-to-route", null)]);
  });

  it("handles_complex_bash_command", () => {
    const inner = 'rg -n "BUG|FIXME|TODO|XXX|HACK" -S | head -n 200';
    expectParsed(["bash", "-lc", inner], [search("rg -n 'BUG|FIXME|TODO|XXX|HACK' -S", "BUG|FIXME|TODO|XXX|HACK", null)]);
  });

  it("supports_rg_files_with_path_and_pipe", () => {
    expectParsed(["bash", "-lc", "rg --files webview/src | sed -n"], [list("rg --files webview/src", "webview")]);
  });

  it("supports_rg_files_then_head", () => {
    expectParsed(["bash", "-lc", "rg --files | head -n 50"], [list("rg --files", null)]);
  });

  it("keeps_mutating_xargs_pipeline", () => {
    const inner = "rg -l QkBindingController presentation/src/main/java | xargs perl -pi -e 's/QkBindingController/QkController/g'";
    expectParsed(["bash", "-lc", inner], [unknown(inner)]);
  });

  it("collapses_plain_pipeline_when_any_stage_is_unknown", () => {
    const command = argv("rg -l QkBindingController presentation/src/main/java | xargs perl -pi -e 's/QkBindingController/QkController/g'");
    expectParsed(command, [unknown(shlexJoin(command))]);
  });

  it("collapses_pipeline_with_helper_when_later_stage_is_unknown", () => {
    const command = argv("rg --files | nl -ba | foo");
    expectParsed(command, [unknown("rg --files '|' nl -ba '|' foo")]);
  });

  it("rg_files_with_matches_flags_are_search", () => {
    for (const cmd of ["rg -l TODO src", "rg --files-with-matches TODO src", "rg -L TODO src", "rg --files-without-match TODO src", "rga -l TODO src"]) {
      expectParsed(argv(cmd), [search(cmd, "TODO", "src")]);
    }
  });

  it("supports_cat", () => {
    const inner = "cat webview/README.md";
    expectParsed(["bash", "-lc", inner], [read(inner, "README.md", "webview/README.md")]);
  });

  it("zsh_lc_supports_cat", () => {
    expectParsed(["zsh", "-lc", "cat README.md"], [read("cat README.md", "README.md", "README.md")]);
  });

  it("supports_bat", () => {
    const inner = "bat --theme TwoDark README.md";
    expectParsed(["bash", "-lc", inner], [read(inner, "README.md", "README.md")]);
  });

  it("supports_batcat", () => {
    expectParsed(["bash", "-lc", "batcat README.md"], [read("batcat README.md", "README.md", "README.md")]);
  });

  it("supports_less", () => {
    const inner = "less -p TODO README.md";
    expectParsed(["bash", "-lc", inner], [read(inner, "README.md", "README.md")]);
  });

  it("supports_more", () => {
    expectParsed(["bash", "-lc", "more README.md"], [read("more README.md", "README.md", "README.md")]);
  });

  it("cd_then_cat_is_single_read", () => {
    expectParsed(argv("cd foo && cat foo.txt"), [read("cat foo.txt", "foo.txt", "foo/foo.txt")]);
  });

  it("cd_with_double_dash_then_cat_is_read", () => {
    expectParsed(argv("cd -- -weird && cat foo.txt"), [read("cat foo.txt", "foo.txt", "-weird/foo.txt")]);
  });

  it("cd_with_multiple_operands_uses_last", () => {
    expectParsed(argv("cd dir1 dir2 && cat foo.txt"), [read("cat foo.txt", "foo.txt", "dir2/foo.txt")]);
  });

  it("bash_cd_then_bar_is_same_as_bar", () => {
    expectParsed(argv("bash -lc 'cd foo && bar'"), [unknown("cd foo && bar")]);
  });

  it("bash_cd_then_cat_is_read", () => {
    expectParsed(argv("bash -lc 'cd foo && cat foo.txt'"), [read("cat foo.txt", "foo.txt", "foo/foo.txt")]);
  });

  it("supports_ls_with_pipe", () => {
    expectParsed(["bash", "-lc", "ls -la | sed -n '1,120p'"], [list("ls -la", null)]);
  });

  it("supports_eza_exa_tree_du", () => {
    expectParsed(argv("eza --color=always src"), [list("eza '--color=always' src", "src")]);
    expectParsed(argv("exa -I target ."), [list("exa -I target .", ".")]);
    expectParsed(argv("tree -L 2 src"), [list("tree -L 2 src", "src")]);
    expectParsed(argv("du -d 2 ."), [list("du -d 2 .", ".")]);
  });

  it("supports_head_n", () => {
    const inner = "head -n 50 Cargo.toml";
    expectParsed(["bash", "-lc", inner], [read(inner, "Cargo.toml", "Cargo.toml")]);
  });

  it("supports_head_file_only", () => {
    expectParsed(["bash", "-lc", "head Cargo.toml"], [read("head Cargo.toml", "Cargo.toml", "Cargo.toml")]);
  });

  it("supports_cat_sed_n", () => {
    const inner = "cat tui/Cargo.toml | sed -n '1,200p'";
    expectParsed(["bash", "-lc", inner], [read(inner, "Cargo.toml", "tui/Cargo.toml")]);
  });

  it("supports_tail_n_plus", () => {
    const inner = "tail -n +522 README.md";
    expectParsed(["bash", "-lc", inner], [read(inner, "README.md", "README.md")]);
  });

  it("supports_tail_n_last_lines", () => {
    const inner = "tail -n 30 README.md";
    expectParsed(["bash", "-lc", inner], [read(inner, "README.md", "README.md")]);
  });

  it("supports_tail_file_only", () => {
    expectParsed(["bash", "-lc", "tail README.md"], [read("tail README.md", "README.md", "README.md")]);
  });

  it("supports_npm_run_build_is_unknown", () => {
    expectParsed(["npm", "run", "build"], [unknown("npm run build")]);
  });

  it("supports_grep_recursive_current_dir", () => {
    expectParsed(["grep", "-R", "CODEX_SANDBOX_ENV_VAR", "-n", "."],
      [search("grep -R CODEX_SANDBOX_ENV_VAR -n .", "CODEX_SANDBOX_ENV_VAR", ".")]);
  });

  it("supports_grep_recursive_specific_file", () => {
    expectParsed(["grep", "-R", "CODEX_SANDBOX_ENV_VAR", "-n", "core/src/spawn.rs"],
      [search("grep -R CODEX_SANDBOX_ENV_VAR -n core/src/spawn.rs", "CODEX_SANDBOX_ENV_VAR", "spawn.rs")]);
  });

  it("supports_egrep_and_fgrep", () => {
    expectParsed(argv("egrep -R TODO src"), [search("egrep -R TODO src", "TODO", "src")]);
    expectParsed(argv("fgrep -l TODO src"), [search("fgrep -l TODO src", "TODO", "src")]);
  });

  it("grep_files_with_matches_flags_are_search", () => {
    for (const cmd of ["grep -l TODO src", "grep --files-with-matches TODO src", "grep -L TODO src", "grep --files-without-match TODO src"]) {
      expectParsed(argv(cmd), [search(cmd, "TODO", "src")]);
    }
  });

  it("supports_grep_query_with_slashes_not_shortened", () => {
    expectParsed(argv("grep -R src/main.rs -n ."), [search("grep -R src/main.rs -n .", "src/main.rs", ".")]);
  });

  it("supports_grep_weird_backtick_in_query", () => {
    expectParsed(argv("grep -R COD`EX_SANDBOX -n"), [search("grep -R 'COD`EX_SANDBOX' -n", "COD`EX_SANDBOX", null)]);
  });

  it("supports_cd_and_rg_files", () => {
    expectParsed(argv("cd codex-rs && rg --files"), [list("rg --files", null)]);
  });

  it("supports_single_string_script_with_cd_and_pipe", () => {
    const inner = 'cd /Users/pakrym/code/codex && rg -n "codex_api" codex-rs -S | head -n 50';
    expectParsed(["bash", "-lc", inner], [search("rg -n codex_api codex-rs -S", "codex_api", "codex-rs")]);
  });

  it("supports_python_walks_files", () => {
    const inner = `python -c "import os; print(os.listdir('.'))"`;
    expectParsed(["bash", "-lc", inner], [list(shlexJoin(argv(inner)), null)]);
    expect(shlexJoin(argv(inner))).toBe(`python -c "import os; print(os.listdir('.'))"`);
  });

  it("supports_python3_walks_files", () => {
    const inner = `python3 -c "import glob; print(glob.glob('*.rs'))"`;
    expectParsed(["bash", "-lc", inner], [list(shlexJoin(argv(inner)), null)]);
  });

  it("python_without_file_walk_is_unknown", () => {
    const inner = `python -c "print('hello')"`;
    expectParsed(["bash", "-lc", inner], [unknown(shlexJoin(argv(inner)))]);
  });

  it("small_formatting_always_true_commands", () => {
    for (const cmd of ["wc", "tr", "cut", "sort", "uniq", "xargs", "tee", "column"]) {
      expect(isSmallFormattingCommand(argv(cmd))).toBe(true);
      expect(isSmallFormattingCommand(argv(`${cmd} -x`))).toBe(true);
    }
  });

  it("awk_behavior", () => {
    expect(isSmallFormattingCommand(argv("awk '{print $1}'"))).toBe(true);
    expect(isSmallFormattingCommand(argv("awk '{print $1}' Cargo.toml"))).toBe(false);
    expect(isSmallFormattingCommand(argv("awk -f script.awk Cargo.toml"))).toBe(false);
  });

  it("head_behavior", () => {
    expect(isSmallFormattingCommand(["head"])).toBe(true);
    expect(isSmallFormattingCommand(argv("head -n 40"))).toBe(true);
    expect(isSmallFormattingCommand(argv("head -n 40 file.txt"))).toBe(false);
    expect(isSmallFormattingCommand(["head", "file.txt"])).toBe(false);
  });

  it("tail_behavior", () => {
    expect(isSmallFormattingCommand(["tail"])).toBe(true);
    expect(isSmallFormattingCommand(argv("tail -n +10"))).toBe(true);
    expect(isSmallFormattingCommand(argv("tail -n +10 file.txt"))).toBe(false);
    expect(isSmallFormattingCommand(argv("tail -n 30"))).toBe(true);
    expect(isSmallFormattingCommand(argv("tail -n 30 file.txt"))).toBe(false);
    expect(isSmallFormattingCommand(argv("tail -c 30"))).toBe(true);
    expect(isSmallFormattingCommand(argv("tail -c +10"))).toBe(true);
    expect(isSmallFormattingCommand(["tail", "file.txt"])).toBe(false);
  });

  it("sed_behavior", () => {
    expect(isSmallFormattingCommand(["sed"])).toBe(true);
    expect(isSmallFormattingCommand(["sed", "-n", "10p"])).toBe(true);
    expect(isSmallFormattingCommand(argv("sed -n 10p file.txt"))).toBe(false);
    expect(isSmallFormattingCommand(argv("sed -n -e 10p file.txt"))).toBe(false);
    expect(isSmallFormattingCommand(argv("sed -n 10p -- file.txt"))).toBe(false);
    expect(isSmallFormattingCommand(argv("sed -n 1,200p file.txt"))).toBe(false);
    expect(isSmallFormattingCommand(argv("sed -n p file.txt"))).toBe(true);
    expect(isSmallFormattingCommand(argv("sed -n +10p file.txt"))).toBe(true);
  });

  it("keeps_mutating_sed_in_compound_command", () => {
    for (const sedCommand of ["sed -n -i.bak 1p secret.txt", "sed -ni.bak 1p secret.txt", "sed -Eni.bak 1p secret.txt"]) {
      const inner = `cat README.md && ${sedCommand}`;
      expectParsed(["bash", "-lc", inner], [unknown(inner)]);
    }
  });

  it("ignores_sed_operands_after_double_dash_when_checking_mutation", () => {
    expectParsed(["bash", "-lc", "cat README.md && sed 's/a/x/' -- -input.txt"], [read("cat README.md", "README.md", "README.md")]);
  });

  it("empty_tokens_is_not_small", () => {
    expect(isSmallFormattingCommand([])).toBe(false);
  });

  it("supports_nl_then_sed_reading", () => {
    const inner = "nl -ba core/src/parse_command.rs | sed -n '1200,1720p'";
    expectParsed(["bash", "-lc", inner], [read(inner, "parse_command.rs", "core/src/parse_command.rs")]);
  });

  it("supports_sed_n", () => {
    const inner = "sed -n '2000,2200p' tui/src/history_cell.rs";
    expectParsed(["bash", "-lc", inner], [read(inner, "history_cell.rs", "tui/src/history_cell.rs")]);
  });

  it("supports_awk_with_file", () => {
    const inner = "awk '{print $1}' Cargo.toml";
    expectParsed(["bash", "-lc", inner], [read(inner, "Cargo.toml", "Cargo.toml")]);
  });

  it("filters_out_printf", () => {
    const inner = 'printf "\\n===== ansi-escape/Cargo.toml =====\\n"; cat -- ansi-escape/Cargo.toml';
    expectParsed(["bash", "-lc", inner], [read("cat -- ansi-escape/Cargo.toml", "Cargo.toml", "ansi-escape/Cargo.toml")]);
  });

  it("drops_yes_in_pipelines", () => {
    expectParsed(["bash", "-lc", "yes | rg --files"], [list("rg --files", null)]);
  });

  it("supports_sed_n_then_nl_as_search", () => {
    expectParsed(argv("sed -n '260,640p' exec/src/event_processor_with_human_output.rs | nl -ba"), [read(
      "sed -n '260,640p' exec/src/event_processor_with_human_output.rs",
      "event_processor_with_human_output.rs",
      "exec/src/event_processor_with_human_output.rs",
    )]);
  });

  it("preserves_rg_with_spaces", () => {
    expectParsed(argv("yes | rg -n 'foo bar' -S"), [search("rg -n 'foo bar' -S", "foo bar", null)]);
  });

  it("ls_with_glob", () => {
    expectParsed(argv("ls -I '*.test.js'"), [list("ls -I '*.test.js'", null)]);
  });

  it("strips_true_in_sequence", () => {
    expectParsed(argv("true && rg --files"), [list("rg --files", null)]);
    expectParsed(argv("rg --files && true"), [list("rg --files", null)]);
  });

  it("strips_true_inside_bash_lc", () => {
    expectParsed(["bash", "-lc", "true && rg --files"], [list("rg --files", null)]);
    expectParsed(["bash", "-lc", "rg --files || true"], [list("rg --files", null)]);
  });

  it("shorten_path_on_windows", () => {
    expectParsed(argv('cat "pkg\\src\\main.rs"'), [read('cat "pkg\\\\src\\\\main.rs"', "main.rs", "pkg\\src\\main.rs")]);
  });

  it("head_with_no_space", () => {
    expectParsed(argv("bash -lc 'head -n50 Cargo.toml'"), [read("head -n50 Cargo.toml", "Cargo.toml", "Cargo.toml")]);
  });

  it("bash_dash_c_pipeline_parsing", () => {
    expectParsed(["bash", "-c", "rg --files | head -n 1"], [list("rg --files", null)]);
  });

  it("tail_with_no_space", () => {
    expectParsed(argv("bash -lc 'tail -n+10 README.md'"), [read("tail -n+10 README.md", "README.md", "README.md")]);
  });

  it("grep_with_query_and_path", () => {
    expectParsed(argv("grep -R TODO src"), [search("grep -R TODO src", "TODO", "src")]);
  });

  it("supports_ag_ack_pt_rga", () => {
    for (const cmd of ["ag TODO src", "ack TODO src", "pt TODO src", "rga TODO src"]) {
      expectParsed(argv(cmd), [search(cmd, "TODO", "src")]);
    }
  });

  it("ag_ack_pt_files_with_matches_flags_are_search", () => {
    for (const cmd of ["ag -l TODO src", "ack -l TODO src", "pt -l TODO src"]) {
      expectParsed(argv(cmd), [search(cmd, "TODO", "src")]);
    }
  });

  it("rg_with_equals_style_flags", () => {
    expectParsed(argv("rg --colors=never -n foo src"), [search("rg '--colors=never' -n foo src", "foo", "src")]);
  });

  it("cat_with_double_dash_and_sed_ranges", () => {
    expectParsed(argv("cat -- ./-strange-file-name"), [read("cat -- ./-strange-file-name", "-strange-file-name", "./-strange-file-name")]);
    expectParsed(argv("sed -n '12,20p' Cargo.toml"), [read("sed -n '12,20p' Cargo.toml", "Cargo.toml", "Cargo.toml")]);
  });

  it("drop_trailing_nl_in_pipeline", () => {
    expectParsed(argv("rg --files | nl -ba"), [list("rg --files", null)]);
  });

  it("ls_with_time_style_and_path", () => {
    // short_display_path drops "dist" and shows "." as the last useful segment.
    expectParsed(argv("ls --time-style=long-iso ./dist"), [list("ls '--time-style=long-iso' ./dist", ".")]);
  });

  it("fd_file_finder_variants", () => {
    expectParsed(argv("fd -t f src/"), [list("fd -t f src/", "src")]);
    expectParsed(argv("fd main src"), [search("fd main src", "main", "src")]);
  });

  it("find_basic_name_filter", () => {
    expectParsed(argv("find . -name '*.rs'"), [search("find . -name '*.rs'", "*.rs", ".")]);
  });

  it("find_type_only_path", () => {
    expectParsed(argv("find src -type f"), [list("find src -type f", "src")]);
  });

  it("bin_bash_lc_sed", () => {
    expectParsed(argv("/bin/bash -lc 'sed -n '1,10p' Cargo.toml'"), [read("sed -n '1,10p' Cargo.toml", "Cargo.toml", "Cargo.toml")]);
  });

  it("bin_zsh_lc_sed", () => {
    expectParsed(argv("/bin/zsh -lc 'sed -n '1,10p' Cargo.toml'"), [read("sed -n '1,10p' Cargo.toml", "Cargo.toml", "Cargo.toml")]);
  });
});

describe("parseCommand: script strings", () => {
  it("parses a script string like the bash -lc argv", () => {
    expect(parseCommand("cat tui/Cargo.toml | sed -n '1,200p'"))
      .toEqual(parseCommand(["bash", "-lc", "cat tui/Cargo.toml | sed -n '1,200p'"]));
    expect(parseCommand("cd foo && cat foo.txt")).toEqual([read("cat foo.txt", "foo.txt", "foo/foo.txt")]);
    expect(parseCommand("rg --files | head -n 50")).toEqual([list("rg --files", null)]);
  });

  it("unwraps one shell wrapper written as a string", () => {
    expect(parseCommand("/bin/zsh -lc 'cat README.md'")).toEqual([read("cat README.md", "README.md", "README.md")]);
    expect(parseCommand("sh -c 'npm test'")).toEqual([unknown("npm test")]);
    expect(parseCommand("fish -c 'cat README.md'")).toEqual([unknown("fish -c 'cat README.md'")]);
  });

  it("splits on newlines and keeps a connector that continues on the next line", () => {
    expect(parseCommand("cd pkg\ncat a.ts &&\n  cat b.ts")).toEqual([
      read("cat a.ts", "a.ts", "pkg/a.ts"),
      read("cat b.ts", "b.ts", "pkg/b.ts"),
    ]);
  });

  it("resolves read paths against cwd", () => {
    expect(parseCommand("cat src/a.ts", "/repo")).toEqual([read("cat src/a.ts", "a.ts", "/repo/src/a.ts")]);
    expect(parseCommand("cat /etc/hosts", "/repo")).toEqual([read("cat /etc/hosts", "hosts", "/etc/hosts")]);
    expect(parseCommand("rg foo src", "/repo")).toEqual([search("rg foo src", "foo", "src")]);
  });

  it("dedupes consecutive identical actions", () => {
    expect(parseCommand("cat a.ts && cat a.ts && cat b.ts")).toEqual([
      read("cat a.ts", "a.ts", "a.ts"),
      read("cat b.ts", "b.ts", "b.ts"),
    ]);
  });

  it("falls back to one unknown action for syntax tree-sitter would reject", () => {
    for (const script of [
      "cat $(git ls-files | head -1)",
      "cat `which foo`",
      "cat README.md > out.txt",
      "rg foo 2>&1",
      "cat <<EOF\nhi\nEOF",
      "cat 'README.md",
      'cat "README.md',
      "cat README.md\\",
      'echo "$HOME" && cat a.ts',
      "FOO=1 cat a.ts",
      "(cd foo && cat a.ts)",
      "{ cat a.ts; }",
      "cat a.ts &",
      "cat a.ts # read it",
      "cat a.ts |& head",
      "&& cat a.ts",
      "cat a.ts &&",
      "; cat a.ts",
      "cat a.ts ;; cat b.ts",
    ]) {
      expect(parseCommand(script), script).toEqual([unknown(script)]);
    }
  });

  it("keeps quoted shell metacharacters as words", () => {
    expect(parseCommand("rg 'a|b' src && cat \"x > y.txt\"")).toEqual([
      search("rg 'a|b' src", "a|b", "src"),
      read("cat 'x > y.txt'", "x > y.txt", "x > y.txt"),
    ]);
  });

  it("treats an empty script as unknown", () => {
    expect(parseCommand("")).toEqual([unknown("")]);
    expect(parseCommand("   ")).toEqual([unknown("   ")]);
  });
});

describe("shortDisplayPath and shlex helpers", () => {
  it("keeps the last useful segment", () => {
    expect(shortDisplayPath("webview/src")).toBe("webview");
    expect(shortDisplayPath("foo/src/")).toBe("foo");
    expect(shortDisplayPath("packages/app/node_modules/")).toBe("app");
    expect(shortDisplayPath("pkg\\src\\main.rs")).toBe("main.rs");
    expect(shortDisplayPath("src")).toBe("src");
    expect(shortDisplayPath("/")).toBe("");
  });

  it("quotes like the shlex crate", () => {
    expect(shlexJoin(["a", "", "b c", "it's", "x\\y", "$HOME", "^x", "é"])).toBe(`a '' 'b c' "it's" "x\\\\y" '$HOME' '^x' 'é'`);
    expect(shlexJoin(["a\0b"])).toBe("<command included NUL byte>");
    expect(shlexSplit("a 'b c' \"d\\\"e\" f\\ g # comment")).toEqual(["a", "b c", 'd"e', "f g"]);
    expect(shlexSplit("'open")).toBeNull();
  });
});
