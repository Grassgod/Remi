/**
 * The read pool's SQL scanner: find every function call a statement makes,
 * resolving names the way PostgreSQL does.
 *
 * ## Why this is a scanner and not a regular expression
 *
 * The first two cuts of the pool gate matched a regex against the statement
 * text (MUL-439 `cmt_u0bywkppcajq`, `cmt_w08j1ocyurc6`). Both were bypassable,
 * and neither failure was a missing pattern: PostgreSQL gives one function name
 * several spellings that a regex over raw text cannot tell apart from
 * identifiers, string contents or comments.
 *
 * - `set_config(…)`, `pg_catalog.set_config(…)`, `"set_config"(…)` and
 *   `pg_catalog."set_config"(…)` all call the same function.
 * - `"Set_Config"(…)` is a *different* function: a quoted identifier keeps its
 *   case, so it does not resolve to `set_config`.
 * - `"COUNT"(…)` is not `count(…)` for the same reason.
 * - `U&"\0073et_config"(…)` is `set_config` spelled with a Unicode escape.
 * - `'pg_notify('`, `$x$ pg_notify( $x$` and `/* pg_notify( *\/` are not calls.
 *
 * So the scanner walks the statement once, tracks which region it is in, and
 * reports each call with its name resolved the way PostgreSQL would look it up.
 * The caller compares the result against a whitelist and refuses anything not
 * on it.
 *
 * ## What it is not
 *
 * It is not a SQL parser. It answers one question — "which functions does this
 * statement invoke?" — and the pool uses the answer only to refuse. A statement
 * the scanner cannot tokenise raises {@link SqlScanError}, which the pool also
 * treats as a refusal, so an input the scanner misreads is never waved through.
 */
import {
  SQL_CONTEXTUAL_KEYWORD_HEADS,
  SQL_UNCONDITIONAL_KEYWORD_HEADS,
} from "./sql-keywords.js";

/** A function call found in a statement. */
export interface SqlFunctionCall {
  /** Resolved name: folded to lower case unless written as a quoted identifier. */
  name: string;
  /** `pg_catalog` when the call was schema-qualified with it, else null. */
  schema: string | null;
  /** True when the name was written with double quotes. */
  quoted: boolean;
  /** True when the name was written with a `U&"…"` Unicode escape. */
  unicodeEscaped: boolean;
  /** Offset of the name in the original text, for messages. */
  index: number;
}

/** Raised when the scanner cannot tokenise the statement. */
export class SqlScanError extends Error {
  constructor(readonly offset: number, message: string) {
    super(message);
    this.name = "SqlScanError";
  }
}

interface IdentToken {
  kind: "ident";
  /** Resolved name: lower-cased when unquoted, verbatim when quoted. */
  value: string;
  quoted: boolean;
  unicodeEscaped: boolean;
  index: number;
}

interface PunctToken {
  kind: "punct";
  value: "." | "(" | ")" | "::";
  index: number;
}

/**
 * Anything skipped between two tokens: an operator, a comma, a placeholder.
 *
 * These are recorded rather than dropped because the call form is `name(`
 * *adjacent* in the token stream. Dropping them would make `a = (SELECT …)`
 * look like a call to `a`, which is a false positive that would refuse ordinary
 * predicates — `WHERE x = (SELECT …)` appears throughout the store.
 */
interface GapToken {
  kind: "gap";
  index: number;
}

type Token = IdentToken | PunctToken | GapToken;

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_\u0080-\uffff]/u.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$\u0080-\uffff]/u.test(ch);
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/**
 * The two views of one statement: the tokens a call can be built from, and the
 * same text with every non-code region blanked out.
 *
 * Both come out of a single pass, which is the point. The pool's two deciders —
 * "is this a read?" and "which functions does it call?" — previously had
 * separate, weaker notions of what a string or a comment is, so a statement
 * could be a read to one and not the other. Sharing the walk removes that gap.
 */
interface ScannedSql {
  tokens: Token[];
  /**
   * The statement with comments removed and literal contents replaced by
   * spaces. Keywords inside a string no longer look like keywords, and a
   * comment cannot hide a token from either decider.
   */
  masked: string;
}

/**
 * Tokenise the parts of a statement that can carry a call, skipping the parts
 * that cannot: comments, string literals and dollar-quoted bodies. Also returns
 * `masked`, the same statement with those regions blanked out.
 */
function tokenize(sql: string): ScannedSql {
  const tokens: Token[] = [];
  const masked: string[] = [];
  const blank = (from: number, to: number): void => {
    // A single space per blanked region keeps the two halves of a split token
    // from joining up (`a/*x*/b` must not read as `ab`).
    masked.push(" ");
  };
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (isSpace(ch)) {
      masked.push(ch);
      i += 1;
      continue;
    }

    // `--` comment runs to end of line.
    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      blank(start, i);
      continue;
    }

    // Block comments nest in PostgreSQL.
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i += 1;
      }
      if (depth !== 0) throw new SqlScanError(start, "unterminated block comment");
      blank(start, i);
      continue;
    }

    // `E'…'` uses backslash escapes; a plain `'…'` does not, and `''` is the
    // escape in both.
    if (ch === "'") {
      const start = i;
      i = skipSingleQuoted(sql, i, false);
      blank(start, i);
      continue;
    }
    if ((ch === "e" || ch === "E") && sql[i + 1] === "'") {
      const start = i;
      i = skipSingleQuoted(sql, i + 1, true);
      blank(start, i);
      continue;
    }

    // `$tag$ … $tag$`. `$1` and `$name` are placeholders, not quotes.
    if (ch === "$") {
      const skip = skipDollarQuoted(sql, i);
      if (skip !== null) {
        const start = i;
        i = skip;
        blank(start, i);
        continue;
      }
      const start = i;
      i += 1;
      while (i < sql.length && isIdentPart(sql[i]!)) i += 1;
      tokens.push({ kind: "gap", index: start });
      masked.push(sql.slice(start, i));
      continue;
    }

    // Quoted identifier, `""` escaping a quote.
    if (ch === '"') {
      const { value, end } = readQuotedIdentifier(sql, i);
      tokens.push({ kind: "ident", value, quoted: true, unicodeEscaped: false, index: i });
      masked.push(sql.slice(i, end));
      i = end;
      continue;
    }

    // `U&"…"` Unicode-escaped identifier. Its escapes are not decoded: the
    // caller refuses every one of them (see `findDisallowedFunction`), so a
    // name that is spelled this way can never be mistaken for a whitelisted one.
    if ((ch === "u" || ch === "U") && sql[i + 1] === "&" && sql[i + 2] === '"') {
      const { value, end } = readQuotedIdentifier(sql, i + 2);
      tokens.push({ kind: "ident", value, quoted: true, unicodeEscaped: true, index: i });
      masked.push(sql.slice(i, end));
      i = end;
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < sql.length && isIdentPart(sql[i]!)) i += 1;
      tokens.push({
        kind: "ident",
        value: sql.slice(start, i).toLowerCase(),
        quoted: false,
        unicodeEscaped: false,
        index: start,
      });
      masked.push(sql.slice(start, i));
      continue;
    }

    if (ch === ":" && sql[i + 1] === ":") {
      tokens.push({ kind: "punct", value: "::", index: i });
      masked.push("::");
      i += 2;
      continue;
    }

    if (ch === "." || ch === "(" || ch === ")") {
      tokens.push({ kind: "punct", value: ch, index: i });
      masked.push(ch);
      i += 1;
      continue;
    }

    // Operators, commas, brackets and anything else cannot start a call form,
    // but they do separate tokens: `a = (SELECT …)` is not `a(`.
    tokens.push({ kind: "gap", index: i });
    masked.push(ch);
    i += 1;
  }

  return { tokens, masked: masked.join("") };
}

/**
 * The statement with comments removed and the contents of string and
 * dollar-quoted literals blanked out.
 *
 * Exported because the pool's read classifier uses the same view: a keyword
 * inside a string literal must not count as a keyword for either decider, and
 * that can only be true if both look at the same masked text.
 */
export function maskSqlLiterals(sql: string): string {
  return tokenize(sql).masked;
}

/**
 * Every function call in `sql`, in source order.
 *
 * Three shapes are deliberately *not* calls:
 *
 * - an identifier that is a **reserved** keyword or one PostgreSQL refuses as a
 *   function name (`IN (…)`, `EXISTS (…)`, `CAST(…)`), from
 *   `SQL_UNCONDITIONAL_KEYWORD_HEADS`;
 * - `FILTER` or `OVER` immediately after the `)` that closes the call it
 *   modifies (`count(*) FILTER (WHERE …)`, `row_number() OVER (…)`), from
 *   `SQL_CONTEXTUAL_KEYWORD_HEADS`;
 * - a type modifier after `::` (`x::numeric(10,2)`), which is a cast's
 *   precision, not an invocation.
 *
 * Anything else spelled `name(` is a call and is reported, whichever case it
 * uses and whether or not it is quoted. The previous revision skipped every
 * name in a 115-word list unconditionally, which let a user-defined `filter()`
 * through (MUL-439 `cmt_0f5ulv021ijn`); the two sets above are the correction.
 */
export function scanSqlFunctionCalls(sql: string): SqlFunctionCall[] {
  const { tokens } = tokenize(sql);
  const calls: SqlFunctionCall[] = [];

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    if (token.kind !== "ident") continue;

    // A type modifier: `::name(…)` consumes the name and its parentheses.
    if (t >= 1 && tokens[t - 1]?.kind === "punct" && (tokens[t - 1] as PunctToken).value === "::") {
      continue;
    }

    const after = tokens[t + 1];
    const isCall = after?.kind === "punct" && (after as PunctToken).value === "(";
    if (!isCall) continue;

    // A quoted name is never a keyword: `"filter"` resolves to a user function,
    // not to the FILTER clause, and PostgreSQL will happily call it. The same
    // goes for a schema-qualified name — `public.filter()` is a call even
    // though `filter` is on the contextual list, because a qualifier cannot
    // appear in front of a clause keyword.
    const schemaQualified =
      t >= 2 &&
      tokens[t - 1]?.kind === "punct" &&
      (tokens[t - 1] as PunctToken).value === "." &&
      tokens[t - 2]?.kind === "ident";
    const isKeywordForm = !token.quoted && !token.unicodeEscaped && !schemaQualified;

    if (isKeywordForm) {
      // Reserved / un-callable words: the grammar cannot turn these into a call.
      if (SQL_UNCONDITIONAL_KEYWORD_HEADS.has(token.value)) continue;
      // A contextual keyword is skipped only in its clause position.
      if (SQL_CONTEXTUAL_KEYWORD_HEADS.has(token.value) && isClauseKeywordPosition(tokens, t, token.value)) {
        continue;
      }
    }

    // `schema.function(` — the qualifier is reported so the caller can refuse
    // anything outside `pg_catalog`, and a quoted qualifier keeps its case so
    // `"PG_CATALOG".set_config(…)` is not accepted as the real one.
    const schema = schemaQualified ? (tokens[t - 2] as IdentToken).value : null;

    calls.push({
      name: token.value,
      schema,
      quoted: token.quoted,
      unicodeEscaped: token.unicodeEscaped,
      index: token.index,
    });
  }

  return calls;
}

/**
 * True when a contextual keyword at index `t` is in a clause position rather
 * than calling a function of the same name.
 *
 * `FILTER` and `OVER` open a clause on the result of an aggregate or window
 * function, so in legal syntax they always follow the `)` that closes it.
 * `BY` belongs to `ORDER BY`, `GROUP BY` and `PARTITION BY`, so it follows one
 * of those words.
 *
 * Every rule keys on the token *before* the candidate. That is what makes them
 * resistant to the obvious trick: `ORDER BY by()` tokenises as
 * `order by by (`, so the second `by` is preceded by an identifier, not by
 * `ORDER`, and is reported as the call it is. Whitespace and comments never
 * reach this layer — `tokenize` has already dropped them — so the check is on
 * the token stream rather than on raw offsets.
 */
function isClauseKeywordPosition(tokens: Token[], t: number, word: string): boolean {
  const previous = tokens[t - 1];
  if (word === "filter" || word === "over") {
    // `aggregate(...) FILTER (…)` / `window_fn(...) OVER (…)`: the keyword
    // follows the `)` that closes the call it applies to.
    return previous?.kind === "punct" && (previous as PunctToken).value === ")";
  }
  if (word === "by") {
    // `ORDER BY (…)` / `GROUP BY (…)` / `PARTITION BY (…)`.
    return (
      previous?.kind === "ident" &&
      (previous.value === "order" || previous.value === "group" || previous.value === "partition")
    );
  }
  return false;
}

/** Skip a single-quoted string; `start` is the opening quote. */
function skipSingleQuoted(sql: string, start: number, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (backslashEscapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new SqlScanError(start, "unterminated string literal");
}

/**
 * Skip a dollar-quoted string, or return null when `start` begins something
 * else such as the `$1` placeholder.
 *
 * A dollar quote is `$` + an optional tag + `$`, where the tag is empty or an
 * identifier that may not start with a digit. `$1` therefore fails the closing
 * `$` test and is treated as a placeholder. The opening delimiter is matched
 * literally, so the tag has to be the same at both ends.
 */
function skipDollarQuoted(sql: string, start: number): number | null {
  let i = start + 1;
  // An empty tag closes immediately: `$$…$$`.
  while (i < sql.length && (sql[i] === "_" || /[A-Za-z-￿]/u.test(sql[i]!) || (i > start + 1 && /[0-9]/u.test(sql[i]!)))) {
    i += 1;
  }
  if (sql[i] !== "$") return null;
  const tag = sql.slice(start, i + 1);
  const close = sql.indexOf(tag, i + 1);
  if (close < 0) throw new SqlScanError(start, `unterminated dollar-quoted string ${tag}`);
  return close + tag.length;
}

/** Read a double-quoted identifier; `start` is the opening quote. */
function readQuotedIdentifier(sql: string, start: number): { value: string; end: number } {
  let i = start + 1;
  let value = "";
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '"') {
      if (sql[i + 1] === '"') {
        value += '"';
        i += 2;
        continue;
      }
      return { value, end: i + 1 };
    }
    value += ch;
    i += 1;
  }
  throw new SqlScanError(start, "unterminated quoted identifier");
}
