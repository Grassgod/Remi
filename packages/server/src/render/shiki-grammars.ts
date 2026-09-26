/**
 * The Shiki grammars the server renderer can load, statically imported.
 *
 * `renderMarkdown` is synchronous (B1 calls it inside its write transaction),
 * so grammars cannot be fetched by dynamic import at render time. Shiki's
 * `createHighlighterCoreSync` loads a grammar object synchronously, and a
 * static import is the only way to have that object in hand without an await.
 *
 * The trade-off is bundle size: `bun build --compile` follows static imports,
 * so each grammar here is in the release binary. The list is therefore the
 * languages that actually show up in agent output and fenced blocks in issue
 * and chat text, not all 332 bundled grammars. A fence in a language outside
 * the list still renders — `resolveLanguage` falls back to `text` — it just
 * comes out uncoloured, exactly as the browser treats an unknown language.
 *
 * Adding one: import it, add it to `languages` (and `aliases` if the fence
 * names differ from the grammar id), and note that `RENDER_PIPELINE_REVISION`
 * has to move if the change alters output for existing markdown.
 */
import typescript from "shiki/langs/typescript.mjs";
import javascript from "shiki/langs/javascript.mjs";
import tsx from "shiki/langs/tsx.mjs";
import jsx from "shiki/langs/jsx.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import yaml from "shiki/langs/yaml.mjs";
import toml from "shiki/langs/toml.mjs";
import ini from "shiki/langs/ini.mjs";
import xml from "shiki/langs/xml.mjs";
import html from "shiki/langs/html.mjs";
import css from "shiki/langs/css.mjs";
import scss from "shiki/langs/scss.mjs";
import markdown from "shiki/langs/markdown.mjs";
import mdx from "shiki/langs/mdx.mjs";
import sql from "shiki/langs/sql.mjs";
import graphql from "shiki/langs/graphql.mjs";
import python from "shiki/langs/python.mjs";
import ruby from "shiki/langs/ruby.mjs";
import php from "shiki/langs/php.mjs";
import go from "shiki/langs/go.mjs";
import rust from "shiki/langs/rust.mjs";
import java from "shiki/langs/java.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import swift from "shiki/langs/swift.mjs";
import c from "shiki/langs/c.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import objectiveC from "shiki/langs/objective-c.mjs";
import bash from "shiki/langs/bash.mjs";
import zsh from "shiki/langs/zsh.mjs";
import powershell from "shiki/langs/powershell.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import diff from "shiki/langs/diff.mjs";
import lua from "shiki/langs/lua.mjs";
import perl from "shiki/langs/perl.mjs";
import r from "shiki/langs/r.mjs";
import scala from "shiki/langs/scala.mjs";
import dart from "shiki/langs/dart.mjs";
import elixir from "shiki/langs/elixir.mjs";
import erlang from "shiki/langs/erlang.mjs";
import haskell from "shiki/langs/haskell.mjs";
import clojure from "shiki/langs/clojure.mjs";
import groovy from "shiki/langs/groovy.mjs";
import zig from "shiki/langs/zig.mjs";
import nix from "shiki/langs/nix.mjs";
import lisp from "shiki/langs/lisp.mjs";
import scheme from "shiki/langs/scheme.mjs";
import proto from "shiki/langs/proto.mjs";
import makefile from "shiki/langs/makefile.mjs";
import nginx from "shiki/langs/nginx.mjs";
import terraform from "shiki/langs/terraform.mjs";
import hcl from "shiki/langs/hcl.mjs";
import vue from "shiki/langs/vue.mjs";
import svelte from "shiki/langs/svelte.mjs";
import astro from "shiki/langs/astro.mjs";
import solidity from "shiki/langs/solidity.mjs";
import latex from "shiki/langs/latex.mjs";
import tex from "shiki/langs/tex.mjs";
import matlab from "shiki/langs/matlab.mjs";
import julia from "shiki/langs/julia.mjs";
import ocaml from "shiki/langs/ocaml.mjs";
import fsharp from "shiki/langs/fsharp.mjs";
import vim from "shiki/langs/vim.mjs";
import viml from "shiki/langs/viml.mjs";
import csv from "shiki/langs/csv.mjs";
import log from "shiki/langs/log.mjs";
import apache from "shiki/langs/apache.mjs";
import asm from "shiki/langs/asm.mjs";
import ada from "shiki/langs/ada.mjs";
import cobol from "shiki/langs/cobol.mjs";
import fortranFree from "shiki/langs/fortran-free-form.mjs";
import commonLisp from "shiki/langs/common-lisp.mjs";

/**
 * Grammar id → grammar module. Ids match Shiki's own, so a fence the browser
 * highlights with a bundled grammar highlights identically here as long as it
 * appears in this map.
 */
export const SHIKI_GRAMMARS = {
  languages: {
    typescript,
    javascript,
    tsx,
    jsx,
    json,
    jsonc,
    yaml,
    toml,
    ini,
    xml,
    html,
    css,
    scss,
    markdown,
    mdx,
    sql,
    graphql,
    python,
    ruby,
    php,
    go,
    rust,
    java,
    kotlin,
    swift,
    c,
    cpp,
    csharp,
    "objective-c": objectiveC,
    bash,
    zsh,
    powershell,
    dockerfile,
    diff,
    lua,
    perl,
    r,
    scala,
    dart,
    elixir,
    erlang,
    haskell,
    clojure,
    groovy,
    zig,
    nix,
    lisp,
    scheme,
    "common-lisp": commonLisp,
    proto,
    makefile,
    nginx,
    terraform,
    hcl,
    vue,
    svelte,
    astro,
    solidity,
    latex,
    tex,
    matlab,
    julia,
    ocaml,
    fsharp,
    vim,
    viml,
    csv,
    log,
    apache,
    asm,
    ada,
    cobol,
    "fortran-free-form": fortranFree,
  } as Record<string, unknown>,

  /**
   * Fence names that differ from the grammar id.
   *
   * The js/ts/sh/… shorthands are the browser's `LANGUAGE_ALIASES`
   * (`frontend/packages/ui/markdown/CodeBlock.tsx`); the rest are Shiki's own
   * aliases, expanded here because `createHighlighterCoreSync` does not apply
   * `bundledLanguagesAlias` for a highlighter built from bare grammar objects.
   */
  aliases: {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    py: "python",
    python3: "python",
    sh: "bash",
    shell: "bash",
    shellscript: "bash",
    zsh: "zsh",
    yml: "yaml",
    rb: "ruby",
    rs: "rust",
    kt: "kotlin",
    kts: "kotlin",
    "objective-c": "objective-c",
    objc: "objective-c",
    cs: "csharp",
    "c#": "csharp",
    "c++": "cpp",
    golang: "go",
    console: "bash",
    docker: "dockerfile",
    md: "markdown",
    html5: "html",
    json5: "jsonc",
    "jsonc": "jsonc",
    toml: "toml",
    tf: "terraform",
    tfvars: "terraform",
    hcl: "hcl",
    proto3: "proto",
    "protobuf": "proto",
    text: "plaintext",
    txt: "plaintext",
    plain: "plaintext",
    log: "log",
    vimscript: "vim",
    "viml": "viml",
    ps1: "powershell",
    pwsh: "powershell",
    ps: "powershell",
    matlab: "matlab",
    octave: "matlab",
    f90: "fortran-free-form",
    "fortran": "fortran-free-form",
    "objectivec": "objective-c",
    "golang": "go",
    "postgres": "sql",
    "postgresql": "sql",
    "mysql": "sql",
    "sqlite": "sql",
    "tsql": "sql",
    "plpgsql": "sql",
    "yml": "yaml",
  } as Record<string, string>,
} as const;
