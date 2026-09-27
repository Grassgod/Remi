/**
 * SQL keywords that may be followed by `(` without being function calls.
 *
 * `IN (…)`, `EXISTS (…)`, `CAST(x AS int)`, `ROW_NUMBER() OVER (…)`,
 * `count(*) FILTER (WHERE …)` and `SUM(x) WITHIN GROUP (ORDER BY …)` are all
 * syntax, not invocation, and refusing them would reject ordinary reads the
 * store issues every day.
 *
 * The split from `READ_FUNCTION_WHITELIST` in `read-pool.ts` is deliberate:
 * this file is a list of *grammar*, that one is a list of *pure functions*. A
 * keyword here is allowed by construction; a name there has to be argued for.
 *
 * `COALESCE`, `NULLIF`, `GREATEST`, `LEAST`, `EXTRACT`, `POSITION`,
 * `SUBSTRING`, `TRIM`, `OVERLAY`, `CAST`, `ROW` and `ARRAY` are listed here
 * rather than in the whitelist because PostgreSQL parses them as constructs:
 * they are also pure, so the whitelist would be equally safe, but keeping them
 * here means the whitelist stays a list of *names the store calls*.
 */
export const SQL_KEYWORD_HEADS = new Set([
  // Boolean and comparison
  "and", "or", "not", "in", "is", "like", "ilike", "similar", "between",
  "any", "all", "some", "exists", "null", "true", "false", "unknown",
  // Query clauses
  "select", "from", "where", "by", "order", "group", "having", "limit",
  "offset", "fetch", "next", "only", "for", "of", "union", "except",
  "intersect", "with", "recursive", "lateral", "join", "on", "using",
  "natural", "cross", "inner", "outer", "left", "right", "full", "as",
  "distinct", "asc", "desc", "nulls", "first", "last", "collate", "at",
  "time", "zone", "partition", "over", "filter", "within", "range", "rows",
  "groups", "exclude", "respect", "ties", "no", "current", "row", "unbounded",
  "preceding", "following", "window", "into", "returning", "conflict",
  "nothing", "do", "update", "share", "nowait", "skip", "locked", "values",
  // CASE and other constructs
  "case", "when", "then", "else", "end", "cast", "extract", "position",
  "substring", "trim", "overlay", "interval", "array", "coalesce", "nullif",
  "greatest", "least", "both", "leading", "trailing", "from",
  // Type and DDL words that can precede a type modifier
  "numeric", "decimal", "varchar", "character", "bit", "timestamp", "time",
  "interval", "double", "precision", "varying",
]);
