/**
 * SQL keywords that are not function calls, split by how confidently that can
 * be decided.
 *
 * `IN (…)`, `EXISTS (…)`, `CAST(x AS int)`, `count(*) FILTER (WHERE …)` and
 * `SUM(x) WITHIN GROUP (ORDER BY …)` are syntax, not invocation, and refusing
 * them would reject ordinary reads the store issues every day. But a word is
 * only *always* syntax when PostgreSQL will not accept it as a function name,
 * and that is a property of the word rather than of the list it happens to be
 * written in.
 *
 * ## How the two sets are decided
 *
 * {@link SQL_UNCONDITIONAL_KEYWORD_HEADS} holds words PostgreSQL marks `R`
 * (reserved) or `C` (cannot be a function or type name) in
 * `pg_get_keywords()`. An unquoted `word(` spelling of one of those can never
 * resolve to a user function, so skipping it unconditionally cannot hide a
 * call. `tests/unit/multiremi/read-pool.test.ts` asserts that every member has
 * catcode `R` or `C` on a real server, which is what makes the set safe to grow
 * only with genuinely un-callable words.
 *
 * {@link SQL_CONTEXTUAL_KEYWORD_HEADS} holds words PostgreSQL *does* accept as
 * function names — catcode `U` or `T`, or absent from the catalog entirely.
 * They are still needed for ordinary syntax, so they are skipped only where the
 * grammar makes the word unambiguous, never merely because the next token is
 * `(`. There are two such words, and the rule for each is in
 * `sql-calls.ts`:
 *
 * - `OVER` and `FILTER` open a window/filter clause, which can only follow the
 *   `)` that closes the call it modifies. Anywhere else — `SELECT filter()`,
 *   `FROM filter()`, `LATERAL filter()`, `ROWS FROM(filter())` — it is a call
 *   and goes through the whitelist.
 *
 * ## What was removed from the earlier version of this file
 *
 * A previous revision carried 115 words and skipped all of them
 * unconditionally. Independent review (MUL-439 `cmt_0f5ulv021ijn`) showed that
 * 46 of them can be created as unquoted functions and called, so the skip was a
 * bypass: a user-defined `filter()` taking an advisory lock ran with the pool
 * reporting success. Of those 46, three are needed for ordinary syntax
 * (`filter`, `over`, `by` — see above) and the rest are gone. The other words
 * that are not callable today are still not reserved by the grammar, which is
 * not a guarantee worth resting a gate on: they are callable the moment
 * PostgreSQL relaxes a rule or an extension adds a parser hook, so none of them
 * is skipped any more.
 *
 * The `T`-catcode words that are genuine functions — `left`, `right` — are
 * handled by the whitelist instead, with a note there on why they are read-only.
 *
 * `WITHIN` and `RESPECT` were dropped outright: legal syntax reads
 * `WITHIN GROUP (…)` and `WITHIN GROUP (…) RESPECT NULLS`, so neither is ever
 * directly followed by `(`, and both can be function names.
 *
 * The split from `READ_FUNCTION_WHITELIST` in `read-pool.ts` remains: this file
 * is a list of *grammar*, that one is a list of *pure functions*. A word listed
 * here is skipped without a purity argument; a name there has to earn its place.
 */

/**
 * Keywords that can never be an unquoted function call: PostgreSQL catcode `R`
 * (reserved) or `C` (cannot be a function or type name).
 *
 * The comment on each line is the catcode from `pg_get_keywords()` on
 * PostgreSQL 18.4. The general-purpose constructs (`CAST`, `EXISTS`,
 * `COALESCE`, `NULLIF`, `GREATEST`, `LEAST`, `EXTRACT`, `POSITION`,
 * `SUBSTRING`, `TRIM`, `OVERLAY`, `ROW`, `ARRAY`, `INTERVAL`, `VALUES`) are
 * here rather than in the whitelist because PostgreSQL parses them as
 * constructs, not invocations; they are pure as well, but the whitelist stays a
 * list of names the store actually calls.
 */
export const SQL_UNCONDITIONAL_KEYWORD_HEADS: ReadonlySet<string> = new Set<string>([
  // Boolean and comparison (R)
  "and", "or", "not", "in", "any", "all", "some", "null", "true", "false",
  // (C) between is a construct, not a call
  "between",
  // Query clauses (R)
  "select", "from", "where", "order", "group", "having", "limit", "offset",
  "fetch", "only", "for", "union", "except", "intersect", "with", "lateral",
  "on", "using", "as", "distinct", "asc", "desc", "collate", "window", "into",
  "returning", "do",
  // CASE (R)
  "case", "when", "then", "else", "end",
  // Constructs PostgreSQL parses itself (R or C)
  "cast", "array", "row", "values", "exists", "coalesce", "nullif", "greatest",
  "least", "extract", "position", "substring", "trim", "overlay", "interval",
  "both", "leading", "trailing",
  // Type names that can precede a modifier or a `::` cast (C)
  "numeric", "decimal", "varchar", "character", "bit", "timestamp", "precision",
  // `time` and `zone` are C/R respectively; `time` is also a type name.
  "time",
]);

/**
 * Keywords that PostgreSQL accepts as function names, so a bare `word(` is a
 * call unless the surrounding grammar says otherwise.
 *
 * Each one is skipped only in the position where the grammar makes it a clause
 * keyword. The rules live in `sql-calls.ts`; in summary:
 *
 * - `FILTER` — after `)`, as in `aggregate(...) FILTER (WHERE …)`.
 * - `OVER` — after `)`, as in `window_fn(...) OVER (…)`.
 * - `BY` — after `ORDER`, `GROUP` or `PARTITION`, as in `ORDER BY (…)`.
 *   `ORDER BY` is the reason it cannot simply be dropped: the store orders by
 *   grouped expressions, and `squads-repo.ts` writes `ORDER BY (m.member_type =
 *   'agent' AND …) DESC`.
 *
 * A preceding-token rule cannot be fooled by writing the function name after
 * the keyword: `ORDER BY by()` has the tokens `order by by (`, so the second
 * `by` is preceded by an identifier rather than by `ORDER` and is reported as a
 * call. That is why each rule keys on the token *before* the candidate rather
 * than on the raw text.
 *
 * `WITHIN` and `RESPECT` are deliberately absent. Neither is ever directly
 * followed by `(` in legal syntax — the grammar reads `WITHIN GROUP (…)` and
 * `… RESPECT NULLS` — and both are valid function names, so there is no
 * position in which skipping them would be safe.
 */
export const SQL_CONTEXTUAL_KEYWORD_HEADS: ReadonlySet<string> = new Set<string>([
  "filter",
  "over",
  "by",
]);

/**
 * Every keyword this scanner may skip, for tests and for the error message that
 * explains a refusal. Membership here does not mean the skip is unconditional —
 * see the two sets above.
 */
export const SQL_KEYWORD_HEADS: ReadonlySet<string> = new Set<string>([
  ...SQL_UNCONDITIONAL_KEYWORD_HEADS,
  ...SQL_CONTEXTUAL_KEYWORD_HEADS,
]);
